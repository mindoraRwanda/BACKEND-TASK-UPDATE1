"""Lightweight crisis-signal pre-filter for the MINDORA conversation module.

This is a safety-routing aid, not a clinical diagnosis or a validated risk scale.
Clinical staff must approve categories, messages and escalation policy before go-live.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

_IMMEDIATE_PATTERNS = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"\bI\s+(?:have\s+already|just)\s+(?:hurt|injured|cut|burned)\s+myself\b",
    r"\bI(?:'ve| have)\s+(?:already\s+)?(?:taken|swallowed|ingested)\s+(?:an?\s+)?(?:overdose|dangerous amount|pills? to hurt myself|pills? to end my life)\b",
    r"\bI\s+(?:swallowed|ingested|took)\s+(?:an?\s+)?(?:overdose|dangerous amount)\b",
    r"\bI\s+(?:overdosed|took an overdose|am about to overdose)\b",
    r"\bI\s+(?:cannot|can't|can’t|do not|don't|don’t)\s+keep myself safe\b",
    r"\bI\s+(?:do not|don't|don’t)\s+trust myself to stay safe\b",
    r"\bI\s+(?:am|’m|'m)\s+about to\s+(?:kill myself|end my life|hurt myself)\b",
    r"\bI\s+(?:will|am going to|’m going to|'m going to)\s+(?:kill myself|end my life|hurt myself)\s+(?:right now|tonight|today)\b",
    r"\bI\s+(?:have|made)\s+a\s+plan\s+to\s+(?:kill myself|end my life|hurt myself)\b",
    r"\bI\s+(?:have|am holding)\s+(?:a gun|a knife|the pills)\s+and\s+(?:might|will|plan to)\s+(?:hurt myself|kill myself)\b",
    r"\bI\s+(?:might|may)\s+(?:kill myself|end my life|hurt myself)\s+(?:right now|tonight|today)\b",
    r"\bI\s+(?:took|swallowed)\s+too many pills\b",
    r"\bI\s+(?:have|had)\s+(?:just )?tried to (?:kill myself|end my life)\b",
))

_ACTIVE_INTENT_PATTERNS = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"\bI\s+(?:want|intend|plan)\s+to\s+(?:kill myself|end my life|take my life)\b",
    r"\bI\s+(?:am|’m|'m)\s+going to\s+(?:kill myself|end my life)\b",
    r"\bI\s+am\s+thinking\s+of\s+(?:killing myself|ending my life)\b",
    r"\bI\s+want\s+to\s+hurt myself\s+(?:today|tonight|now)\b",
    r"\bI\s+(?:might|may|plan to)\s+(?:kill myself|end my life|take my life)\b",
))

_IDEATION_PATTERNS = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"\bI(?:'m| am)\s+thinking\s+about\s+suicide\b",
    r"\bI(?:'m| am)\s+having\s+suicidal\s+thoughts\b",
    r"\bI\s+have\s+suicidal\s+thoughts\b",
    r"\bI\s+(?:wish|think)\s+I\s+were\s+dead\b",
    r"\bI\s+don't\s+want\s+to\s+be\s+alive\b",
    r"\bI\s+want\s+to\s+die\b",
    r"\bI\s+want\s+to\s+hurt myself\b",
    r"\bI\s+(?:feel like|am thinking about)\s+ending it all\b",
    r"\bIt would be better if I were dead\b",
    r"\bI\s+do not see a reason to stay alive\b",
    r"\bI\s+keep\s+thinking\s+about\s+(?:killing myself|ending my life)\b",
    r"\bI\s+have\s+urges?\s+to\s+(?:hurt|cut|harm)\s+myself\b",
    r"\bI\s+(?:cut|burn|hit)\s+myself\b",
    r"\bI\s+(?:keep|have been)\s+(?:cutting|hurting|burning) myself\b",
    r"\bI\s+am\s+self[- ]?harming\b",
    r"\bI\s+have\s+been\s+self[- ]?harming\b",
    r"\bI\s+am\s+thinking\s+about\s+self[- ]?harm\b",
    r"\bI\s+have\s+thoughts\s+of\s+hurting\s+myself\b",
    r"\bmy friend\s+(?:wants|is planning)\s+to\s+(?:kill himself|kill herself|end their life)\b",
))

_CLEAR_NEGATIONS = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"\bI(?:'m| am)\s+not\s+(?:suicidal|thinking about suicide)\b",
    r"\bI\s+(?:do not|don't|don’t)\s+want\s+to\s+(?:die|hurt myself|kill myself|end my life)\b",
    r"\bI\s+have\s+never\s+(?:thought about suicide|wanted to die|hurt myself)\b",
    r"\bno\s+(?:suicidal|self[- ]?harm)\s+thoughts\b",
))

@dataclass(frozen=True)
class CrisisAssessment:
    level: int
    category: str
    matched: str | None = None

    @property
    def is_crisis(self) -> bool:
        return self.level >= 3

def _first_match(patterns: Iterable[re.Pattern[str]], text: str) -> str | None:
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match.group(0)
    return None

def assess_crisis_message(message: str) -> CrisisAssessment:
    """Return a conservative technical signal (0–5), not a clinical score.

    Explicit recent harm, an imminent plan, or inability to stay safe receives level 5.
    Explicit active intent receives level 4. Other explicit suicidal/self-harm disclosures
    receive level 3. General/educational mentions are not enough on their own.
    """
    if not isinstance(message, str) or not message.strip():
        return CrisisAssessment(0, 'none')
    text = re.sub(r"\s+", " ", message.replace('’', "'").replace('‘', "'")).strip()

    match = _first_match(_IMMEDIATE_PATTERNS, text)
    if match:
        return CrisisAssessment(5, 'immediate_safety_concern', match)

    match = _first_match(_ACTIVE_INTENT_PATTERNS, text)
    if match:
        return CrisisAssessment(4, 'active_intent', match)

    match = _first_match(_IDEATION_PATTERNS, text)
    if match:
        return CrisisAssessment(3, 'suicidal_ideation_or_self_harm_disclosure', match)

    # Avoid treating a clear denial or general educational question as a crisis.
    # This narrow exclusion is applied only after explicit high-risk patterns above.
    if _first_match(_CLEAR_NEGATIONS, text):
        return CrisisAssessment(0, 'explicit_denial')

    return CrisisAssessment(0, 'none')

def detect_suicide_risk(message: str) -> bool:
    return assess_crisis_message(message).is_crisis

def build_crisis_support_response(level: int) -> str:
    """Build a safe response using only approved/configured clinical contacts.

    MINDORA's phone/email are general public support contacts, not emergency hotlines.
    No unapproved emergency numbers or hospital contacts are hardcoded here.
    """
    lines = [
        "I'm really glad you told me. I'm sorry this feels so difficult right now. Your safety matters, and you deserve support from a real person.",
        "If you may act on these thoughts, have already hurt yourself, or cannot stay safe, please contact local emergency services or go to the nearest emergency department now. If possible, move away from anything you could use to hurt yourself and stay with someone you trust while you get help.",
        "For general MINDORA support during published business hours (Monday to Friday, 9:00 AM–5:00 PM), call +250 783 974-066. You can also email info@mindora.rw; the stated response time is within 24 hours. These are general support contacts, not emergency services or a 24/7 crisis hotline.",
    ]
    if os.getenv('CRISIS_CONTACTS_APPROVED', 'false').lower() == 'true':
        approved = os.getenv('CRISIS_APPROVED_RESOURCES', '').strip()
        therapist = os.getenv('CRISIS_APPROVED_THERAPIST_ROUTE', '').strip()
        if approved:
            lines.append(f"Additional MINDORA-approved crisis resources: {approved}")
        if therapist:
            lines.append(f"Approved therapist contact route: {therapist}")
    lines.append("You do not have to handle this alone. Can you move to a place where another trusted person is with you right now?")
    return "\n\n".join(lines)

def make_crisis_webhook_payload(*, event_id: str, conversation_id: str | None,
                                external_user_ref: str | None, level: int,
                                message_excerpt: str, occurred_at: str | None = None) -> dict:
    from datetime import datetime, timezone
    return {
        'eventId': event_id,
        'conversationId': (conversation_id or '')[:120] or None,
        'externalUserRef': (external_user_ref or '')[:120] or None,
        'crisisLevel': max(3, min(5, int(level))),
        'messageExcerpt': message_excerpt[:1500],
        'occurredAt': occurred_at or datetime.now(timezone.utc).isoformat(),
        'source': 'python-chatbot',
    }
