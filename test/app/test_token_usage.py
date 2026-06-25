"""Token usage accounting regression tests."""

from __future__ import annotations

import asyncio
import json
import subprocess
from unittest.mock import MagicMock

from fp import EntityKind, Host, Message, MessageKind
from fp.message import InvokePayload

from aln.app.adapters.cli_adapter import CLIAdapter, CLIResult
from aln.app.api.v1.sessions import (
    CreateGroupSessionRequest,
    create_group_session,
    get_session_token_usage,
)
from aln.app.handlers.agent_handler import AgentHandler
from aln.app.schemas.token_usage import TokenUsageRecord
from aln.app.service.token_usage_service import TokenUsageService
from test.app.handler_helpers import make_handler_config


def test_codex_jsonl_usage_is_parsed() -> None:
    """Codex JSONL turn.completed usage should become CLI metadata."""
    adapter = CLIAdapter(provider="codex")
    stdout = "\n".join(
        [
            json.dumps({"type": "thread.started", "thread_id": "thread-1"}),
            json.dumps(
                {
                    "type": "turn.completed",
                    "usage": {
                        "input_tokens": 12,
                        "cached_input_tokens": 3,
                        "output_tokens": 5,
                    },
                }
            ),
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {"type": "agent_message", "text": "done"},
                }
            ),
        ]
    )
    fake_result = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")

    parsed = adapter._parse_output(fake_result, fallback_session_id=None)

    assert parsed.text == "done"
    assert parsed.provider_session_id == "thread-1"
    assert parsed.metadata["input_tokens"] == 12
    assert parsed.metadata["cached_input_tokens"] == 3
    assert parsed.metadata["output_tokens"] == 5
    assert parsed.metadata["total_tokens"] == 17


def test_token_usage_service_summarizes_session() -> None:
    """TokenUsageService should persist and aggregate host-scoped records."""
    service = TokenUsageService("host-1")
    service.append(
        TokenUsageRecord(
            host_uid="host-1",
            entity_uid="planner",
            entity_name="Planner",
            provider="codex",
            session_id="group:demo",
            input_tokens=10,
            output_tokens=4,
            total_tokens=14,
        )
    )
    service.append(
        TokenUsageRecord(
            host_uid="host-1",
            entity_uid="reviewer",
            entity_name="Reviewer",
            provider="codex",
            session_id="group:demo",
            input_tokens=20,
            cached_input_tokens=8,
            output_tokens=6,
            total_tokens=26,
        )
    )

    summary = service.summarize_session("group:demo")

    assert summary.has_actual_usage is True
    assert summary.totals.input_tokens == 30
    assert summary.totals.cached_input_tokens == 8
    assert summary.totals.output_tokens == 10
    assert summary.totals.total_tokens == 40
    assert summary.entity_uids == ["planner", "reviewer"]
    assert summary.providers == ["codex"]


def test_token_usage_record_accepts_common_provider_aliases() -> None:
    """Provider aliases should normalize into ALN token fields."""
    record = TokenUsageRecord.from_cli_metadata(
        host_uid="host-1",
        entity_uid="agent-1",
        entity_name="Agent",
        provider="json-provider",
        session_id="s1",
        provider_session_id=None,
        message_ids=[],
        model=None,
        return_code=0,
        metadata={
            "usage": {
                "prompt_tokens": 13,
                "completion_tokens": 7,
                "cache_read_input_tokens": 5,
            }
        },
    )

    assert record is not None
    assert record.input_tokens == 13
    assert record.cached_input_tokens == 5
    assert record.output_tokens == 7
    assert record.total_tokens == 20


def test_session_usage_api_requires_visible_session_and_summarizes() -> None:
    """Session API should expose usage for sessions visible to the requester."""

    async def run() -> int:
        host = Host(name="UsageHub")
        alice = host.register_entity(name="Alice", kind=EntityKind.HUMAN)
        bob = host.register_entity(name="Bob", kind=EntityKind.AGENT)
        alice.add_friend(bob.entity_card)
        bob.add_friend(alice.entity_card)
        alice.save()
        bob.save()

        created = await create_group_session(
            alice.uid,
            CreateGroupSessionRequest(name="Usage Room", members=[bob.uid]),
            target_entity=alice,
            current_host=host,
        )
        assert created.data is not None

        TokenUsageService(host.uid).append(
            TokenUsageRecord(
                host_uid=host.uid,
                entity_uid=bob.uid,
                entity_name=bob.name,
                provider="codex",
                session_id=created.data.session_id,
                input_tokens=30,
                output_tokens=7,
                total_tokens=37,
            )
        )

        response = await get_session_token_usage(
            alice.uid,
            created.data.session_id,
            target_entity=alice,
            current_host=host,
        )
        assert response.data is not None
        return response.data.totals.total_tokens

    assert asyncio.run(run()) == 37


def test_agent_handler_records_cli_usage() -> None:
    """AgentHandler should append one usage record after a provider turn."""

    async def run() -> tuple[int, str | None]:
        host = Host(name="AgentUsageHub")
        human = host.register_entity(name="Human", kind=EntityKind.HUMAN)
        agent = host.register_entity(name="Reviewer", kind=EntityKind.AGENT)

        handler = AgentHandler.__new__(AgentHandler)
        handler.entity = agent
        handler.provider = "codex"
        handler.config = make_handler_config(model="gpt-5")
        handler._system_prompt = "test"
        handler._queue = MagicMock()
        handler.adapter = MagicMock()
        handler.adapter.run_turn.return_value = CLIResult(
            text="ok",
            provider_session_id="thread-usage",
            return_code=0,
            metadata={
                "usage": {
                    "input_tokens": 11,
                    "cached_input_tokens": 2,
                    "output_tokens": 9,
                },
                "input_tokens": 11,
                "cached_input_tokens": 2,
                "output_tokens": 9,
                "total_tokens": 20,
            },
        )
        handler._update_system_prompt = MagicMock()
        handler._format_batch_prompt = MagicMock(return_value="hello")

        message = Message(
            kind=MessageKind.INVOKE,
            payload=InvokePayload(text="hello", session_id="group:usage"),
            metadata={"sender_address": human.address.address},
        )
        await handler._execute_batch("group:usage", [message])

        records = TokenUsageService(host.uid).list_records(session_id="group:usage")
        return records[0].total_tokens, records[0].provider_session_id

    total_tokens, provider_session_id = asyncio.run(run())

    assert total_tokens == 20
    assert provider_session_id == "thread-usage"
