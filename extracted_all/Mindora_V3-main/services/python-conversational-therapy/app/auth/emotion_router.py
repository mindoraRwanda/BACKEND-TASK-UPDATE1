# app/routers/emotion_router.py
from fastapi import APIRouter, HTTPException
from app.auth.schemas import AnalysisRequest, EmotionRequest
from app.services.emotion_classifier import classify_emotion
from app.services.chatbot_insights_pipeline import (
    analyze_user_input,
    detect_medication_mentions,
    detect_suicide_risk,
    load_and_index_datasets,
)
from app.services.crisis_safety import assess_crisis_message

router = APIRouter()

@router.post("/emotion")
def detect_emotion(request: EmotionRequest):
    emotion = classify_emotion(request.text)
    return {"emotion": emotion}

@router.post("/analyze", tags=["Mental Health Analysis"])
def analyze_user_message(request: AnalysisRequest):
    """
    Analyze a user message for emotional and psychological risk indicators.
    """
    result = analyze_user_input(request.user_input)
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])

    return {
        "status": "success",
        "input": request.user_input,
        "analysis": result
    }

@router.post("/detect/medications", tags=["Utilities"])
def extract_medications(request: AnalysisRequest):
    meds = detect_medication_mentions(request.user_input)
    return {"medications_detected": meds}

@router.post("/detect/suicide-risk", tags=["Utilities"])
def check_suicide_flag(request: AnalysisRequest):
    assessment = assess_crisis_message(request.user_input)
    return {
        "suicide_risk": "high" if assessment.is_crisis else "low",
        "crisis_level": assessment.level,
        "category": assessment.category,
        "clinical_validation_required": True,
    }

@router.post("/reindex", tags=["Admin"])
def rebuild_vector_knowledge():
    try:
        load_and_index_datasets()
        return {"status": "reindexed successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
