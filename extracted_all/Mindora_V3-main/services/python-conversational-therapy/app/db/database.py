import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

APP_ENV = os.getenv('APP_ENV', 'development').lower()
DATABASE_URL = os.getenv('DATABASE_URL') or os.getenv('CHATBOT_DATABASE_URL')
if not DATABASE_URL:
    if APP_ENV == 'production':
        raise RuntimeError('DATABASE_URL must be configured in production')
    DATABASE_URL = 'sqlite:///./mindora_chatbot_dev.db'

connect_args = {'check_same_thread': False} if DATABASE_URL.startswith('sqlite:') else {}
engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
