import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth.integration_router import router
from app.db.database import Base, get_db
from app.db.models import User


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("MINDORA_INTEGRATION_KEY", "test-only-shared-integration-key")
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client, TestingSessionLocal
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


def test_creates_and_reuses_stable_chatbot_identity(client):
    test_client, session_factory = client
    response = test_client.post(
        "/integration/session",
        headers={"X-Integration-Key": "test-only-shared-integration-key"},
        json={"external_id": "v3-patient-001", "email": "Patient@example.com"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] > 0
    assert body["user_id"].isdigit()
    assert body["access_token"]

    db = session_factory()
    try:
        assert db.query(User).filter_by(mindora_external_id="v3-patient-001").count() == 1
    finally:
        db.close()

    second = test_client.post(
        "/integration/session",
        headers={"X-Integration-Key": "test-only-shared-integration-key"},
        json={"external_id": "v3-patient-001", "email": "patient@example.com"},
    )
    assert second.status_code == 200
    assert second.json()["user_id"] == body["user_id"]


def test_rejects_missing_or_invalid_integration_key(client):
    test_client, _ = client
    missing = test_client.post(
        "/integration/session",
        json={"external_id": "v3-patient-002", "email": "patient2@example.com"},
    )
    invalid = test_client.post(
        "/integration/session",
        headers={"X-Integration-Key": "wrong"},
        json={"external_id": "v3-patient-002", "email": "patient2@example.com"},
    )
    assert missing.status_code == 401
    assert invalid.status_code == 401


def test_links_existing_chatbot_user_without_creating_duplicate(client):
    test_client, session_factory = client
    db = session_factory()
    existing = User(username="legacy-user", email="legacy@example.com", password="pre-hashed-placeholder")
    db.add(existing)
    db.commit()
    db.refresh(existing)
    existing_id = existing.id
    db.close()

    response = test_client.post(
        "/integration/session",
        headers={"X-Integration-Key": "test-only-shared-integration-key"},
        json={"external_id": "v3-patient-legacy", "email": "legacy@example.com"},
    )
    assert response.status_code == 200
    db = session_factory()
    try:
        linked = db.query(User).filter_by(id=existing_id).one()
        assert linked.mindora_external_id == "v3-patient-legacy"
        assert db.query(User).filter_by(email="legacy@example.com").count() == 1
    finally:
        db.close()
