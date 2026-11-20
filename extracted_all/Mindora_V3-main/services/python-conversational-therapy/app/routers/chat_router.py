from datetime import datetime, timezone
from uuid import uuid4
from typing import Optional
import logging

from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel, Field

from app.services.llm_service import LLMService
from app.services.crisis_safety import assess_crisis_message, build_crisis_support_response, make_crisis_webhook_payload
from app.services.mindora_notifications import publish_crisis_event

logger = logging.getLogger(__name__)
router = APIRouter(prefix='/api', tags=['chat'])
_llm_service: LLMService | None = None

def get_llm_service() -> LLMService:
    global _llm_service
    if _llm_service is None:
        _llm_service = LLMService(model_name='llama3')
    return _llm_service

class Message(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    conversation_id: Optional[str] = Field(default=None, max_length=120)

class ChatResponse(BaseModel):
    response: str
    timestamp: str
    conversation_id: Optional[str] = None
    crisis_level: int = 0

# Legacy anonymous demo route. Production MINDORA deployments should use the
# authenticated /auth/messages flow; this endpoint is retained for compatibility.
conversation_store: dict[str, list[dict[str, str]]] = {}

@router.post('/chat', response_model=ChatResponse)
async def chat(
    message: Message,
    background_tasks: BackgroundTasks,
):
    conversation_id = message.conversation_id or f'conv_{uuid4()}'
    conversation = conversation_store.setdefault(conversation_id, [])
    assessment = assess_crisis_message(message.message)
    timestamp = datetime.now(timezone.utc).isoformat()

    if assessment.is_crisis:
        response_text = build_crisis_support_response(assessment.level)
        event_id = str(uuid4())
        payload = make_crisis_webhook_payload(
            event_id=event_id,
            conversation_id=conversation_id,
            external_user_ref=None,
            level=assessment.level,
            message_excerpt=message.message,
            occurred_at=timestamp,
        )
        conversation.extend([
            {'role': 'user', 'text': message.message, 'timestamp': timestamp},
            {'role': 'model', 'text': response_text, 'timestamp': timestamp},
        ])
        conversation_store[conversation_id] = conversation[-30:]
        background_tasks.add_task(publish_crisis_event, payload)
        return ChatResponse(
            response=response_text,
            timestamp=timestamp,
            conversation_id=conversation_id,
            crisis_level=assessment.level,
        )

    conversation.append({'role': 'user', 'text': message.message, 'timestamp': timestamp})
    # Construct/load the LLM only after the deterministic crisis pre-filter.
    # Crisis messages above return before model initialization or network calls.
    llm_service = get_llm_service()
    response_text = await llm_service.generate_response(
        message.message,
        conversation_history=conversation[-30:],
    )
    conversation.append({'role': 'model', 'text': response_text, 'timestamp': timestamp})
    conversation_store[conversation_id] = conversation[-30:]
    return ChatResponse(
        response=response_text,
        timestamp=timestamp,
        conversation_id=conversation_id,
        crisis_level=0,
    )
