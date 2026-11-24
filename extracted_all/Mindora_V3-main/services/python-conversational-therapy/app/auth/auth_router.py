from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import List
import bleach
from sqlalchemy.exc import IntegrityError
# Add this import if it's not already there
from app.auth.schemas import TokenResponse
from app.services.emotion_classifier import classify_emotion
from app.db.database import SessionLocal
from app.db.models import Conversation, Message, User
from app.auth.schemas import (
    MessageCreate, MessageOut, UserCreate, UserLogin, TokenResponse,
    ConversationOut, MessageCreate, EmotionRequest
)
from app.auth.utils import hash_password, verify_password, create_access_token, get_current_user
from app.services.llm_service import LLMService
from app.services.crisis_safety import assess_crisis_message, build_crisis_support_response, make_crisis_webhook_payload
from app.services.mindora_notifications import publish_crisis_event
from uuid import uuid4
from datetime import datetime, timezone
from app.db.models import EmotionLog
from app.services.emotion_classifier import classify_emotion
router = APIRouter(prefix="/auth", tags=["Authentication"])
# Switch to vLLM by changing use_vllm=True
_llm_service: LLMService | None = None  # initialized only for non-crisis requests

def get_llm_service() -> LLMService:
    global _llm_service
    if _llm_service is None:
        _llm_service = LLMService(use_vllm=False)
    return _llm_service

# Dependency: get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# --- Auth Endpoints ---

@router.post("/signup", response_model=TokenResponse)
def signup(user: UserCreate, db: Session = Depends(get_db)):
    # Check for existing email
    existing_email = db.query(User).filter(User.email == user.email).first()
    if existing_email:
        raise HTTPException(status_code=400, detail="Email already in use")

    # Check for existing username
    existing_username = db.query(User).filter(User.username == user.username).first()
    if existing_username:
        raise HTTPException(status_code=400, detail="Username already taken")

    hashed_pw = hash_password(user.password)
    new_user = User(username=user.username, email=user.email, password=hashed_pw)

    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    token = create_access_token(data={"sub": str(new_user.id)})
    return {"access_token": token, "token_type": "bearer", "user_id": new_user.id, "username": new_user.username}



@router.post("/login", response_model=TokenResponse)
def login(user_data: UserLogin, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == user_data.email).first()
    if not user or not verify_password(user_data.password, user.password):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token({"sub": str(user.id)})
    return {
        "access_token": token,
        "token_type": "bearer",
        "user_id": user.id,
        "username": user.username  
    }


# --- Conversation Endpoints ---

@router.post("/conversations", response_model=ConversationOut)
def create_conversation(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    new_convo = Conversation(user_id=user.id)
    db.add(new_convo)
    db.commit()
    db.refresh(new_convo)
    return new_convo



@router.get("/conversations")
def list_user_conversations(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    conversations = db.query(Conversation).filter_by(user_id=user.id).order_by(Conversation.started_at.desc()).all()
    return [
        {
            "id": c.id,
            "started_at": c.started_at,
            "messages": db.query(Message).filter_by(conversation_id=c.id).order_by(Message.timestamp.asc()).limit(1).all()
        } for c in conversations
    ]


@router.get("/conversations/{conversation_id}/messages", response_model=List[MessageOut])
def get_conversation_messages(
    conversation_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    conversation = db.query(Conversation)\
        .filter_by(id=conversation_id, user_id=user.id).first()

    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = db.query(Message)\
        .filter_by(conversation_id=conversation_id)\
        .order_by(Message.timestamp)\
        .all()

    return messages

# --- Messaging ---
@router.post("/messages", response_model=MessageOut)
async def send_message(
    message: MessageCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    import time
    pipeline_start = time.time()
    print(f"\n🚀 Starting message pipeline for user {user.id}")
    
    # Single query to verify conversation ownership
    db_start = time.time()
    convo = db.query(Conversation).filter_by(
        id=message.conversation_id,
        user_id=user.id
    ).first()
    db_lookup_time = time.time() - db_start
    print(f"⏱️  DB conversation lookup: {db_lookup_time:.3f}s")

    if not convo:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Content cleaning
    clean_start = time.time()
    clean_content = bleach.clean(message.content.strip())
    clean_time = time.time() - clean_start
    print(f"⏱️  Content cleaning: {clean_time:.3f}s")
    
    if not clean_content:
        raise HTTPException(status_code=400, detail="Message content is empty or invalid")

    # Load only recent conversation history (last 15 messages for context)
    history_start = time.time()
    recent_history = db.query(Message)\
        .filter_by(conversation_id=message.conversation_id)\
        .order_by(Message.timestamp.desc())\
        .limit(15)\
        .all()
    
    # Reverse to get chronological order
    recent_history.reverse()
    conversation_history = [
        {"role": msg.sender, "text": msg.content} for msg in recent_history
    ]
    history_time = time.time() - history_start
    print(f"⏱️  DB history load: {history_time:.3f}s ({len(recent_history)} messages)")

    # Run deterministic safety pre-filter BEFORE emotion models, RAG or the LLM.
    assessment = assess_crisis_message(clean_content)
    if assessment.is_crisis:
        detected_emotion = "distress"
        bot_reply = build_crisis_support_response(assessment.level)
        event_id = str(uuid4())
        webhook_payload = make_crisis_webhook_payload(
            event_id=event_id,
            conversation_id=str(message.conversation_id),
            external_user_ref=str(user.id),
            level=assessment.level,
            message_excerpt=clean_content,
            occurred_at=datetime.now(timezone.utc).isoformat(),
        )
        background_tasks.add_task(publish_crisis_event, webhook_payload)
        emotion_time = 0.0
        llm_time = 0.0
        print(f"[safety] Crisis pre-filter returned level {assessment.level}; LLM bypassed")
    else:
        # Emotion classification is optional and must not block normal chat if unavailable.
        emotion_start = time.time()
        detected_emotion = classify_emotion(clean_content)
        emotion_time = time.time() - emotion_start
        print(f"⏱️  Emotion detection: {emotion_time:.3f}s -> {detected_emotion}")

        llm_start = time.time()
        bot_reply = await get_llm_service().generate_response(clean_content, conversation_history)
        llm_time = time.time() - llm_start
        print(f"⏱️  LLM generation: {llm_time:.3f}s ({len(bot_reply)} chars)")

    # Batch database operations - create all objects first
    db_prep_start = time.time()
    user_msg = Message(
        conversation_id=message.conversation_id,
        sender="user",
        content=clean_content
    )
    
    bot_msg = Message(
        conversation_id=message.conversation_id,
        sender="bot",
        content=bleach.clean(bot_reply)
    )
    
    emotion_log = EmotionLog(
        user_id=user.id,
        conversation_id=message.conversation_id,
        input_text=clean_content,
        detected_emotion=detected_emotion
    )

    # Single transaction - add all objects and commit once
    db.add_all([user_msg, bot_msg, emotion_log])
    convo.last_activity_at = bot_msg.timestamp
    db.commit()
    
    # Only refresh the bot message we're returning
    db.refresh(bot_msg)
    db_save_time = time.time() - db_prep_start
    print(f"⏱️  DB save operations: {db_save_time:.3f}s")
    
    total_time = time.time() - pipeline_start
    print(f"🏁 Total pipeline time: {total_time:.3f}s")
    print(f"📊 Breakdown: DB({db_lookup_time + history_time + db_save_time:.3f}s) | LLM({llm_time:.3f}s) | Emotion({emotion_time:.3f}s) | Other({total_time - (db_lookup_time + history_time + db_save_time + llm_time + emotion_time):.3f}s)")

    return bot_msg


# --- Context Window Endpoint ---

@router.get("/context", response_model=List[MessageOut])
def get_context_window(
    limit: int = Query(default=10, le=50),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    # Get most recently active conversation (with messages)
    conversation = (
        db.query(Conversation)
        .filter_by(user_id=user.id)
        .order_by(Conversation.started_at.desc())
        .first()
    )

    if not conversation:
        return []

    messages = (
        db.query(Message)
        .filter_by(conversation_id=conversation.id)
        .order_by(Message.timestamp.desc())
        .limit(limit)
        .all()
    )

    return list(reversed(messages))  # return oldest → newest


@router.delete("/conversations/{conversation_id}")
def delete_conversation(
    conversation_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user)
):
    conversation = db.query(Conversation)\
        .filter_by(id=conversation_id, user_id=user.id).first()
    
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    
    # Delete related emotion logs first to avoid foreign key constraint violation
    db.query(EmotionLog)\
        .filter_by(conversation_id=conversation_id)\
        .delete()
    
    # Now delete the conversation (messages will be cascade deleted due to relationship config)
    db.delete(conversation)
    db.commit()
    
    return {"message": "Conversation deleted successfully"}


