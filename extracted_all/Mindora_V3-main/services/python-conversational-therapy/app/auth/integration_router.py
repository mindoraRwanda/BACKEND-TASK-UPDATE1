"""Private service-to-service session exchange for MINDORA V3.

This endpoint is not a browser login route. It requires the shared
MINDORA_INTEGRATION_KEY and maps one V3 identity to one chatbot account.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.utils import ACCESS_TOKEN_EXPIRE_MINUTES, create_access_token, hash_password
from app.db.database import get_db
from app.db.models import User

router = APIRouter(prefix="/integration", tags=["Private service integration"])


class IntegrationSessionRequest(BaseModel):
    external_id: str = Field(min_length=1, max_length=128)
    email: EmailStr


@router.post("/session")
def create_integration_session(
    payload: IntegrationSessionRequest,
    x_integration_key: str | None = Header(default=None, alias="X-Integration-Key"),
    db: Session = Depends(get_db),
):
    configured_key = os.getenv("MINDORA_INTEGRATION_KEY", "").strip()
    if not configured_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service integration is not configured",
        )
    if not x_integration_key or not hmac.compare_digest(x_integration_key, configured_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized service integration",
        )

    external_id = payload.external_id.strip()
    email = str(payload.email).strip().lower()
    if not external_id:
        raise HTTPException(status_code=422, detail="external_id is required")

    # Prefer the stable V3 identity. If this is the first linked request,
    # safely attach a pre-existing chatbot account with the same email.
    user = db.query(User).filter(User.mindora_external_id == external_id).first()
    if user is None:
        user = db.query(User).filter(User.email == email).first()
        if user is not None and user.mindora_external_id not in (None, external_id):
            raise HTTPException(status_code=409, detail="Chatbot account is already linked")
        if user is not None:
            user.mindora_external_id = external_id
        else:
            username_hash = hashlib.sha256(external_id.encode("utf-8")).hexdigest()[:24]
            user = User(
                username=f"mindora_{username_hash}",
                email=email,
                password=hash_password(secrets.token_urlsafe(48)),
                mindora_external_id=external_id,
            )
            db.add(user)

    # Keep email current for linked accounts, but never steal an email already
    # associated with a different chatbot account.
    email_owner = db.query(User).filter(User.email == email).first()
    if email_owner is not None and email_owner.id != user.id:
        raise HTTPException(status_code=409, detail="Email is already linked to another chatbot account")
    user.email = email

    try:
        db.commit()
        db.refresh(user)
    except IntegrityError:
        db.rollback()
        # A concurrent first request may have created the same association.
        user = db.query(User).filter(User.mindora_external_id == external_id).first()
        if user is None or user.email != email:
            raise HTTPException(status_code=409, detail="Could not link chatbot account")

    access_token = create_access_token({"sub": str(user.id)})
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "user_id": str(user.id),
    }
