"""Service-to-service crisis event forwarding with bounded delivery retries."""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

async def publish_crisis_event(payload: dict[str, Any]) -> bool:
    url = os.getenv('MINDORA_CRISIS_WEBHOOK_URL', '').strip()
    token = os.getenv('MINDORA_CRISIS_WEBHOOK_TOKEN', '').strip()
    if not url or not token:
        logger.warning('MINDORA crisis webhook is not configured; event was not forwarded')
        return False

    event_id = payload.get('eventId')
    delays = (0.0, 0.5, 1.5)
    for attempt, delay in enumerate(delays, start=1):
        if delay:
            await asyncio.sleep(delay)
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0)) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={
                        'Authorization': f'Bearer {token}',
                        'Content-Type': 'application/json',
                    },
                )
            if response.status_code in (200, 202, 204):
                logger.info('Crisis event accepted by MINDORA backend (event_id=%s)', event_id)
                return True

            # Retry transient server/rate-limit responses only. Authentication and
            # validation failures need configuration or code correction, not retries.
            if response.status_code not in (408, 425, 429) and response.status_code < 500:
                logger.error(
                    'Crisis webhook rejected event (event_id=%s, status=%s)',
                    event_id, response.status_code,
                )
                return False
            logger.warning(
                'Transient crisis webhook response (event_id=%s, status=%s, attempt=%s)',
                event_id, response.status_code, attempt,
            )
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            logger.warning(
                'Crisis webhook transport failure (event_id=%s, type=%s, attempt=%s)',
                event_id, type(exc).__name__, attempt,
            )
        except Exception as exc:
            logger.error(
                'Crisis webhook failed unexpectedly (event_id=%s, type=%s)',
                event_id, type(exc).__name__,
            )
            return False

    logger.error('Crisis event forwarding exhausted retries (event_id=%s)', event_id)
    return False
