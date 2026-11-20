"""Local tests for the Python chatbot's service-to-service crisis webhook."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from app.services import mindora_notifications


class FakeResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code


class FakeAsyncClient:
    def __init__(self, *, timeout=None, responses=None, errors=None, calls=None):
        self.timeout = timeout
        self.responses = responses or []
        self.errors = errors or []
        self.calls = calls if calls is not None else []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, *, json, headers):
        self.calls.append({"url": url, "json": json, "headers": headers})
        if self.errors:
            error = self.errors.pop(0)
            if error:
                raise error
        status = self.responses.pop(0) if self.responses else 202
        return FakeResponse(status)


def _run(coro):
    return asyncio.run(coro)


def _payload():
    return {
        "eventId": "2a035f59-54e3-45d0-8945-79e7030ff435",
        "crisisLevel": 5,
        "messageExcerpt": "I have already hurt myself",
    }


def test_webhook_returns_false_when_not_configured(monkeypatch):
    monkeypatch.delenv("MINDORA_CRISIS_WEBHOOK_URL", raising=False)
    monkeypatch.delenv("MINDORA_CRISIS_WEBHOOK_TOKEN", raising=False)
    assert _run(mindora_notifications.publish_crisis_event(_payload())) is False


def test_webhook_posts_event_with_bearer_token(monkeypatch):
    monkeypatch.setenv("MINDORA_CRISIS_WEBHOOK_URL", "https://api.example.test/api/v1/ai/internal/chatbot-crisis-events")
    monkeypatch.setenv("MINDORA_CRISIS_WEBHOOK_TOKEN", "test-shared-secret")
    calls = []
    monkeypatch.setattr(
        mindora_notifications.httpx,
        "AsyncClient",
        lambda **kwargs: FakeAsyncClient(responses=[202], calls=calls, **kwargs),
    )

    assert _run(mindora_notifications.publish_crisis_event(_payload())) is True
    assert len(calls) == 1
    assert calls[0]["headers"]["Authorization"] == "Bearer test-shared-secret"
    assert calls[0]["json"]["eventId"] == _payload()["eventId"]


def test_webhook_retries_transient_http_status_then_succeeds(monkeypatch):
    monkeypatch.setenv("MINDORA_CRISIS_WEBHOOK_URL", "https://api.example.test/webhook")
    monkeypatch.setenv("MINDORA_CRISIS_WEBHOOK_TOKEN", "test-shared-secret")
    calls = []
    responses = [503, 429, 202]
    monkeypatch.setattr(
        mindora_notifications.httpx,
        "AsyncClient",
        lambda **kwargs: FakeAsyncClient(responses=responses, calls=calls, **kwargs),
    )
    async def no_sleep(_):
        return None
    monkeypatch.setattr(mindora_notifications.asyncio, "sleep", no_sleep)

    assert _run(mindora_notifications.publish_crisis_event(_payload())) is True
    assert len(calls) == 3


def test_webhook_does_not_retry_permanent_auth_failure(monkeypatch):
    monkeypatch.setenv("MINDORA_CRISIS_WEBHOOK_URL", "https://api.example.test/webhook")
    monkeypatch.setenv("MINDORA_CRISIS_WEBHOOK_TOKEN", "test-shared-secret")
    calls = []
    monkeypatch.setattr(
        mindora_notifications.httpx,
        "AsyncClient",
        lambda **kwargs: FakeAsyncClient(responses=[401, 202], calls=calls, **kwargs),
    )

    assert _run(mindora_notifications.publish_crisis_event(_payload())) is False
    assert len(calls) == 1


def test_webhook_stops_after_bounded_transport_retries(monkeypatch):
    monkeypatch.setenv("MINDORA_CRISIS_WEBHOOK_URL", "https://api.example.test/webhook")
    monkeypatch.setenv("MINDORA_CRISIS_WEBHOOK_TOKEN", "test-shared-secret")
    calls = []
    timeout = httpx.TimeoutException("test timeout")
    errors = [timeout, timeout, timeout]
    monkeypatch.setattr(
        mindora_notifications.httpx,
        "AsyncClient",
        lambda **kwargs: FakeAsyncClient(errors=errors, calls=calls, **kwargs),
    )
    async def no_sleep(_):
        return None
    monkeypatch.setattr(mindora_notifications.asyncio, "sleep", no_sleep)

    assert _run(mindora_notifications.publish_crisis_event(_payload())) is False
    assert len(calls) == 3
