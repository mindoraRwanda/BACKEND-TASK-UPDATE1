import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers.chat_router import router as chat_router
from app.auth.auth_router import router as auth_router
from app.auth.emotion_router import router as emotion_router
from app.auth.integration_router import router as integration_router
from app.db.database import engine
from app.db import models

def _create_tables_enabled() -> bool:
    configured = os.getenv('CHATBOT_CREATE_TABLES_ON_STARTUP')
    if configured is not None:
        return configured.lower() == 'true'
    return os.getenv('APP_ENV', 'development').lower() != 'production'

@asynccontextmanager
async def lifespan(app: FastAPI):
    if _create_tables_enabled():
        # Development convenience only. Production schema changes should use reviewed migrations.
        models.Base.metadata.create_all(bind=engine)
    yield

app = FastAPI(title='MINDORA Conversational Therapy API', lifespan=lifespan)

origins = [item.strip() for item in os.getenv('CHATBOT_CORS_ORIGINS', 'http://localhost:3000').split(',') if item.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allow_headers=['Authorization', 'Content-Type'],
)

app.include_router(auth_router)
app.include_router(chat_router)
app.include_router(emotion_router)
app.include_router(integration_router)

@app.get('/health')
async def health():
    return {'status': 'ok', 'service': 'mindora-conversational-therapy'}

@app.get('/')
async def root():
    return {'message': 'MINDORA Conversational Therapy API is running'}
