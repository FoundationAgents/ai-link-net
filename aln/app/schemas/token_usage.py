"""Token usage schemas for provider CLI execution accounting."""

from __future__ import annotations

import time
from collections.abc import Mapping
from uuid import uuid4

from pydantic import BaseModel, Field

type JsonValue = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]


def _as_int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, float):
        return max(0, int(value))
    if isinstance(value, str):
        try:
            return max(0, int(float(value)))
        except ValueError:
            return 0
    return 0


def _first_int(data: Mapping[str, object], keys: list[str]) -> int:
    for key in keys:
        value = data.get(key)
        parsed = _as_int(value)
        if parsed > 0:
            return parsed
    return 0


def _json_value(value: object) -> JsonValue:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, Mapping):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_json_value(item) for item in value]
    return str(value)


def _json_object(value: Mapping[str, object]) -> dict[str, JsonValue]:
    return {str(key): _json_value(item) for key, item in value.items()}


class TokenUsageTotals(BaseModel):
    """Aggregated token counts."""

    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0

    @classmethod
    def from_records(cls, records: list["TokenUsageRecord"]) -> "TokenUsageTotals":
        """Aggregate token counts from records."""
        return cls(
            input_tokens=sum(record.input_tokens for record in records),
            cached_input_tokens=sum(record.cached_input_tokens for record in records),
            output_tokens=sum(record.output_tokens for record in records),
            total_tokens=sum(record.total_tokens for record in records),
        )


class TokenUsageRecord(BaseModel):
    """One provider CLI turn usage record."""

    record_id: str = Field(default_factory=lambda: uuid4().hex)
    host_uid: str
    entity_uid: str
    entity_name: str
    provider: str
    session_id: str
    provider_session_id: str | None = None
    message_ids: list[str] = Field(default_factory=list)
    model: str | None = None
    return_code: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    raw_usage: dict[str, JsonValue] = Field(default_factory=dict)
    created_at: float = Field(default_factory=time.time)

    @classmethod
    def from_cli_metadata(
        cls,
        *,
        host_uid: str,
        entity_uid: str,
        entity_name: str,
        provider: str,
        session_id: str,
        provider_session_id: str | None,
        message_ids: list[str],
        model: str | None,
        return_code: int,
        metadata: Mapping[str, object],
    ) -> "TokenUsageRecord | None":
        """Build a record from parsed provider metadata."""
        raw_usage = metadata.get("usage")
        usage = raw_usage if isinstance(raw_usage, Mapping) else metadata
        input_tokens = _first_int(usage, ["input_tokens", "prompt_tokens"])
        cached_input_tokens = _first_int(
            usage,
            ["cached_input_tokens", "cache_read_input_tokens", "cached_tokens"],
        )
        output_tokens = _first_int(usage, ["output_tokens", "completion_tokens"])
        total_tokens = _first_int(usage, ["total_tokens"]) or input_tokens + output_tokens

        if total_tokens <= 0 and (not isinstance(raw_usage, Mapping) or not raw_usage):
            return None

        return cls(
            host_uid=host_uid,
            entity_uid=entity_uid,
            entity_name=entity_name,
            provider=provider,
            session_id=session_id,
            provider_session_id=provider_session_id,
            message_ids=message_ids,
            model=model,
            return_code=return_code,
            input_tokens=input_tokens,
            cached_input_tokens=cached_input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            raw_usage=_json_object(usage),
        )


class TokenUsageSummary(BaseModel):
    """Session token usage summary."""

    session_id: str
    totals: TokenUsageTotals
    records: list[TokenUsageRecord] = Field(default_factory=list)
    providers: list[str] = Field(default_factory=list)
    entity_uids: list[str] = Field(default_factory=list)
    has_actual_usage: bool = False
