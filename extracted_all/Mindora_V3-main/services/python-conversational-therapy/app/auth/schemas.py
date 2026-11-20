from pydantic import BaseModel, EmailStr, Field, model_validator, constr
from typing import Annotated, List
from datetime import datetime
from app.services.chatbot_insights_pipeline import analyze_user_input




# Type-safe annotated fields
UsernameType = Annotated[str, constr(min_length=3, max_length=20)]
PasswordType = Annotated[str, Field(min_length=8, max_length=128, pattern=r"^(?=.*[A-Za-z])(?=.*\d).{8,128}$")]

class UserCreate(BaseModel):
    username: UsernameType
    email: EmailStr
    password: PasswordType
    confirm_password: PasswordType

    @model_validator(mode="after")
    def passwords_must_match(self):
        if self.password != self.confirm_password:
            raise ValueError("Passwords do not match")
        return self

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: int = None
    username: str = None

class MessageCreate(BaseModel):
    conversation_id: int
    content: Annotated[str, Field(min_length=1, max_length=2000)]  # Bound user input size

class MessageOut(BaseModel):
    id: int
    sender: str
    content: str
    timestamp: datetime

    class Config:
        from_attributes = True  # for Pydantic v2 (replaces orm_mode)

class ConversationOut(BaseModel):
    id: int
    started_at: datetime

    class Config:
        from_attributes = True

class EmotionRequest(BaseModel):
    text: str    
        
class AnalysisRequest(BaseModel):
    user_input: str