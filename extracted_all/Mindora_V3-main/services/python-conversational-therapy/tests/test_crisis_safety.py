import os
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app.services.crisis_safety import (  # noqa: E402
    assess_crisis_message,
    build_crisis_support_response,
    make_crisis_webhook_payload,
)


@pytest.mark.parametrize(
    ("message", "expected_level"),
    [
        ("I have already hurt myself", 5),
        ("I just cut myself", 5),
        ("I cannot keep myself safe", 5),
        ("I swallowed an overdose", 5),
        ("I am about to end my life", 5),
        ("I have a plan to kill myself", 5),
        ("I intend to end my life", 4),
        ("I am thinking of killing myself", 4),
        ("I am having suicidal thoughts", 3),
        ("I wish I were dead", 3),
        ("I have urges to hurt myself", 3),
        ("I have been self-harming", 3),
        ("I want to hurt myself", 3),
        ("I feel like ending it all", 3),
        ("It would be better if I were dead", 3),
        ("I do not see a reason to stay alive", 3),
        ("I might kill myself", 4),
        ("I have been cutting myself", 3),
    ],
)
def test_high_risk_messages_are_flagged(message: str, expected_level: int) -> None:
    assessment = assess_crisis_message(message)
    assert assessment.is_crisis is True
    assert assessment.level == expected_level
    assert assessment.matched


@pytest.mark.parametrize(
    "message",
    [
        "I am not suicidal",
        "I do not want to die",
        "I have never thought about suicide",
        "No self-harm thoughts",
        "I am studying suicide prevention for a public-health class",
        "Can you explain how mental-health crisis services work?",
        "Hello, how are you today?",
    ],
)
def test_clear_denials_and_general_education_are_not_high_risk(message: str) -> None:
    assert assess_crisis_message(message).is_crisis is False


def test_support_response_does_not_invent_emergency_numbers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CRISIS_CONTACTS_APPROVED", "false")
    monkeypatch.delenv("CRISIS_APPROVED_RESOURCES", raising=False)
    response = build_crisis_support_response(5)
    assert "+250 783 974-066" in response
    assert "info@mindora.rw" in response
    assert "Monday to Friday" in response
    assert "not emergency services" in response
    assert "112" not in response
    assert "912" not in response


def test_approved_resources_are_only_shown_when_flag_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CRISIS_CONTACTS_APPROVED", "false")
    monkeypatch.setenv("CRISIS_APPROVED_RESOURCES", "Clinically approved resource A")
    assert "Clinically approved resource A" not in build_crisis_support_response(4)

    monkeypatch.setenv("CRISIS_CONTACTS_APPROVED", "true")
    assert "Clinically approved resource A" in build_crisis_support_response(4)


def test_webhook_payload_is_bounded_and_identifies_source() -> None:
    payload = make_crisis_webhook_payload(
        event_id="2a035f59-54e3-45d0-8945-79e7030ff435",
        conversation_id="c" * 200,
        external_user_ref="u" * 200,
        level=9,
        message_excerpt="m" * 2000,
        occurred_at="2026-11-03T10:00:00+00:00",
    )
    assert payload["source"] == "python-chatbot"
    assert payload["crisisLevel"] == 5
    assert len(payload["messageExcerpt"]) == 1500
    assert len(payload["conversationId"]) == 120
    assert len(payload["externalUserRef"]) == 120
