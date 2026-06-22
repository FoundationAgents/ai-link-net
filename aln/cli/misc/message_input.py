"""Message input parsing helpers for CLI send commands."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from typing import Any

import click


@dataclass(frozen=True, slots=True)
class ParsedCliMessage:
    """Plain message payload parsed from CLI input."""

    text: str
    session_id: str | None = None


class MessageInputParser:
    """Parse JSON, plain text, or stdin message input consistently."""

    def parse(
        self,
        *,
        message_json: str | None,
        text: str | None,
        text_stdin: bool,
        text_env: str | None = None,
        session_id: str | None = None,
    ) -> ParsedCliMessage:
        """Parse one CLI message from exactly one supported input source."""
        raw_text = self._plain_text(
            message_json=message_json,
            text=text,
            text_stdin=text_stdin,
            text_env=text_env,
        )
        if raw_text is not None:
            return ParsedCliMessage(
                text=self._require_text(raw_text),
                session_id=self._clean_session_id(session_id),
            )

        if message_json is None:
            raise click.ClickException(
                "Provide -m/--message JSON, -t/--text, or --text-stdin."
            )

        message_data = self._parse_json(message_json)
        json_text, json_session_id = self._extract_message(message_data)
        return ParsedCliMessage(
            text=self._require_text(json_text),
            session_id=self._clean_session_id(session_id) or json_session_id,
        )

    def _plain_text(
        self,
        *,
        message_json: str | None,
        text: str | None,
        text_stdin: bool,
        text_env: str | None,
    ) -> str | None:
        provided = [
            message_json is not None,
            text is not None,
            text_stdin,
            text_env is not None,
        ]
        if sum(provided) > 1:
            raise click.ClickException(
                "Use only one message input source: --message, --text, --text-stdin, or --text-env."
            )
        if text is not None:
            return text
        if text_stdin:
            return sys.stdin.read()
        if text_env is not None:
            return self._read_env_text(text_env)
        return None

    @staticmethod
    def _read_env_text(text_env: str) -> str:
        env_name = text_env.strip()
        if not env_name:
            raise click.ClickException("Environment variable name cannot be empty")
        if env_name not in os.environ:
            raise click.ClickException(f"Environment variable not found: {env_name}")
        return os.environ[env_name]

    @staticmethod
    def _parse_json(message_json: str) -> dict[str, Any]:
        try:
            message_data = json.loads(message_json)
        except json.JSONDecodeError as exc:
            raise click.ClickException(f"Invalid JSON message: {exc}") from exc
        if not isinstance(message_data, dict):
            raise click.ClickException("Message must be a JSON object")
        return message_data

    def _extract_message(self, message_data: dict[str, Any]) -> tuple[str | None, str | None]:
        text = message_data.get("text")
        session_id = self._clean_session_id(message_data.get("session_id"))

        payload = message_data.get("payload")
        if text is None and isinstance(payload, dict):
            text = payload.get("text")
            session_id = self._clean_session_id(payload.get("session_id")) or session_id

        return str(text) if text is not None else None, session_id

    @staticmethod
    def _require_text(text: str | None) -> str:
        normalized = text.strip() if text is not None else ""
        if not normalized:
            raise click.ClickException('Message must contain "text"')
        return normalized

    @staticmethod
    def _clean_session_id(session_id: Any) -> str | None:
        if not isinstance(session_id, str):
            return None
        normalized = session_id.strip()
        return normalized or None
