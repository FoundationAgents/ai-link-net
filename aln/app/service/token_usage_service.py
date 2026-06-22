"""Persist and summarize provider token usage records."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from loguru import logger

from fp.utils.path import get_fp_home

from aln.app.schemas.token_usage import (
    TokenUsageRecord,
    TokenUsageSummary,
    TokenUsageTotals,
)


class TokenUsageService:
    """Host-scoped token usage ledger."""

    def __init__(self, host_uid: str, fp_home: Path | None = None) -> None:
        self.host_uid = host_uid
        self.fp_home = fp_home or get_fp_home()
        self.path = self.fp_home / "hosts" / host_uid / "token_usage.jsonl"

    def append(self, record: TokenUsageRecord) -> None:
        """Append one usage record."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as file:
            file.write(record.model_dump_json(exclude_none=True))
            file.write("\n")

    def list_records(
        self,
        *,
        session_id: str | None = None,
        entity_uids: Iterable[str] | None = None,
        provider: str | None = None,
    ) -> list[TokenUsageRecord]:
        """List records with optional filters."""
        if not self.path.exists():
            return []

        entity_filter = set(entity_uids or [])
        provider_filter = provider.strip().lower() if provider else None
        records: list[TokenUsageRecord] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                record = TokenUsageRecord.model_validate_json(line)
            except Exception as exc:
                logger.warning(f"Skipping invalid token usage record: {exc}")
                continue
            if session_id is not None and record.session_id != session_id:
                continue
            if entity_filter and record.entity_uid not in entity_filter:
                continue
            if provider_filter and record.provider.lower() != provider_filter:
                continue
            records.append(record)
        return sorted(records, key=lambda item: item.created_at)

    def summarize_session(
        self,
        session_id: str,
        *,
        entity_uids: Iterable[str] | None = None,
    ) -> TokenUsageSummary:
        """Summarize token usage for one FP session."""
        records = self.list_records(session_id=session_id, entity_uids=entity_uids)
        return TokenUsageSummary(
            session_id=session_id,
            totals=TokenUsageTotals.from_records(records),
            records=records,
            providers=sorted({record.provider for record in records}),
            entity_uids=sorted({record.entity_uid for record in records}),
            has_actual_usage=bool(records),
        )
