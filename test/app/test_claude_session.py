"""Claude CLI session management tests.

Requires `claude` CLI installed — skips automatically if unavailable.
Tests the full lifecycle: new session → resume → stale session retry.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import uuid

import pytest

from aln.app.adapters.cli_adapter import CLIAdapter, CLIMapping, CLIResult
from test.app.handler_helpers import make_handler_config

CLAUDE_AVAILABLE = shutil.which("claude") is not None
skip_no_claude = pytest.mark.skipif(not CLAUDE_AVAILABLE, reason="claude CLI not installed")


def _make_adapter() -> CLIAdapter:
    return CLIAdapter(provider="claude")


# ── Unit tests (no CLI needed) ──


class TestCLIMappingLoadsCorrectly:
    def test_claude_mapping_from_yaml(self):
        mapping = CLIMapping.from_yaml("claude")
        assert mapping.provider_name == "claude"
        assert mapping.executable == "claude"
        assert mapping.resume_flag == "-r"
        assert mapping.resume_use_session_id is True
        assert mapping.output_format == "json"
        assert mapping.session_id_path == ["session_id"]

    def test_resume_command_includes_session_id(self):
        adapter = _make_adapter()
        config = make_handler_config()
        cmd = adapter._build_command(
            prompt="hello",
            config=config,
            session_id="test-session",
            provider_session_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            system_prompt=None,
        )
        assert "-r" in cmd
        assert "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" in cmd

    def test_new_session_command_has_no_resume_flag(self):
        adapter = _make_adapter()
        config = make_handler_config()
        cmd = adapter._build_command(
            prompt="hello",
            config=config,
            session_id="test-session",
            provider_session_id=None,
            system_prompt=None,
        )
        assert "-r" not in cmd

    def test_parse_json_extracts_session_id(self):
        adapter = _make_adapter()
        fake_result = subprocess.CompletedProcess(
            args=[], returncode=0,
            stdout=json.dumps({
                "result": "Hi there!",
                "session_id": "11111111-2222-3333-4444-555555555555",
            }),
            stderr="",
        )
        parsed = adapter._parse_output(fake_result, fallback_session_id=None)
        assert parsed.provider_session_id == "11111111-2222-3333-4444-555555555555"
        assert parsed.text == "Hi there!"
        assert parsed.return_code == 0

    def test_parse_json_empty_result_uses_fallback(self):
        adapter = _make_adapter()
        fake_result = subprocess.CompletedProcess(
            args=[], returncode=0,
            stdout=json.dumps({"result": "ok"}),
            stderr="",
        )
        parsed = adapter._parse_output(fake_result, fallback_session_id="fallback-id")
        assert parsed.provider_session_id == "fallback-id"


# ── Integration tests (require claude CLI) ──


@skip_no_claude
class TestClaudeSessionLifecycle:
    """End-to-end session tests against real Claude CLI."""

    def test_new_session_returns_session_id(self):
        """First turn should create a new conversation and return a session_id."""
        adapter = _make_adapter()
        config = make_handler_config(max_budget_usd=0.05)
        result = adapter.run_turn(
            prompt="Reply with exactly: SESSION_TEST_OK",
            config=config,
            session_id=f"test-new-{uuid.uuid4().hex[:8]}",
            provider_session_id=None,
            system_prompt="You are a test bot. Reply exactly as instructed.",
            entity_name="test",
        )
        assert result.provider_session_id is not None, "No session_id returned"

    def test_resume_with_valid_session(self):
        """Resume should work with a session_id from a previous turn."""
        adapter = _make_adapter()
        config = make_handler_config(max_budget_usd=0.05)
        run_id = uuid.uuid4().hex[:8]

        # Turn 1: create session
        r1 = adapter.run_turn(
            prompt="Remember the word: PINEAPPLE. Reply with OK.",
            config=config,
            session_id=f"test-resume-{run_id}",
            provider_session_id=None,
            system_prompt="You are a test bot.",
            entity_name="test",
        )
        sid = r1.provider_session_id
        assert sid is not None, "No session_id from turn 1"

        # Turn 2: resume (may hit budget, but session_id should still be returned)
        r2 = adapter.run_turn(
            prompt="What word did I ask you to remember?",
            config=config,
            session_id=f"test-resume-{run_id}",
            provider_session_id=sid,
            system_prompt=None,
            entity_name="test",
        )
        assert r2.provider_session_id is not None, "No session_id on resume"

    def test_resume_with_stale_session_raises(self):
        """Resume with a fake/stale session_id should raise RuntimeError."""
        adapter = _make_adapter()
        config = make_handler_config(max_budget_usd=0.05)
        with pytest.raises(RuntimeError, match="(?i)no conversation found"):
            adapter.run_turn(
                prompt="hello",
                config=config,
                session_id=f"test-stale-{uuid.uuid4().hex[:8]}",
                provider_session_id="00000000-0000-0000-0000-000000000000",
                system_prompt=None,
                entity_name="test",
            )


# ── AgentHandler retry logic (unit test with mock) ──


class TestAgentHandlerRetryOnStaleSession:
    """Test that _execute_batch retries when resume fails with stale session."""

    def test_clear_provider_session_id(self):
        """_clear_provider_session_id should set provider_session_id to None."""
        from unittest.mock import MagicMock

        from aln.app.handlers.agent_handler import AgentHandler

        entity = MagicMock()
        entity.name = "TestAgent"
        entity.uid = "test-uid"
        entity.sessions = {}

        handler = AgentHandler.__new__(AgentHandler)
        handler.entity = entity
        handler.adapter = MagicMock()
        handler.config = make_handler_config()

        session = handler._ensure_session("test-session")
        session.provider_session_id = "old-stale-id"

        handler._clear_provider_session_id("test-session")
        assert session.provider_session_id is None

    @pytest.mark.asyncio
    async def test_execute_batch_retries_on_stale_session(self):
        """_execute_batch should catch stale-session error and retry without provider_session_id."""
        from unittest.mock import MagicMock, patch

        from aln.app.handlers.agent_handler import AgentHandler

        entity = MagicMock()
        entity.name = "TestAgent"
        entity.uid = "test-uid"
        entity.sessions = {}

        handler = AgentHandler.__new__(AgentHandler)
        handler.entity = entity
        handler.config = make_handler_config()
        handler._system_prompt = "test"
        handler._queue = MagicMock()

        adapter = MagicMock()
        handler.adapter = adapter

        # Set up stale provider_session_id
        session = handler._ensure_session("s1")
        session.provider_session_id = "stale-uuid"

        # First call raises (stale session), second call succeeds
        ok_result = CLIResult(text="ok", provider_session_id="new-uuid", return_code=0)
        adapter.run_turn.side_effect = [
            RuntimeError("claude CLI failed (exit 1): No conversation found with session ID: stale-uuid"),
            ok_result,
        ]

        msg = MagicMock()
        msg.metadata = {}
        msg.payload = MagicMock()
        msg.payload.text = "hello"

        handler._update_system_prompt = MagicMock()
        handler._format_batch_prompt = MagicMock(return_value="hello")

        await handler._execute_batch("s1", [msg])

        # Should have been called twice: first with stale id, then without
        assert adapter.run_turn.call_count == 2
        first_call_kwargs = adapter.run_turn.call_args_list[0]
        second_call_kwargs = adapter.run_turn.call_args_list[1]
        assert first_call_kwargs.kwargs.get("provider_session_id") == "stale-uuid"
        assert second_call_kwargs.kwargs.get("provider_session_id") is None
        assert session.provider_session_id == "new-uuid"


class TestAgentHandlerTradeNotify:
    """Trade and system messages should reach AgentHandler through the same queue."""

    @pytest.mark.asyncio
    async def test_trade_message_is_queued_by_agent_handler(self):
        """Trade status messages should be queued so the agent can observe them."""
        from unittest.mock import AsyncMock, MagicMock, patch

        from aln.app.handlers.agent_handler import AgentHandler
        from fp.message import Message, MessageKind

        def _drop_task(coro):
            coro.close()
            return MagicMock()

        handler = AgentHandler.__new__(AgentHandler)
        handler.entity = MagicMock()
        handler.entity.name = "Agent"
        handler.entity.uid = "agent-uid"
        handler.entity.call_owner = AsyncMock()
        handler.adapter = MagicMock()
        handler._queue = asyncio.Queue()
        handler._loop_task = None
        handler._running_summary = "idle"
        handler._resolve_session_id = MagicMock(return_value="auto:arbiter")

        message = Message(
            kind=MessageKind.CONTRACT_STATUS,
            payload={},
            metadata={"sender_address": "host:arbiter"},
        )

        with patch("aln.app.handlers.agent_handler.asyncio.create_task", side_effect=_drop_task):
            await handler.handle(message)

        handler.entity.call_owner.assert_not_awaited()
        assert handler._queue.qsize() == 1

    @pytest.mark.asyncio
    async def test_execute_batch_retries_on_already_in_use(self):
        """_execute_batch should resume when session is already in use (e.g. after host restart)."""
        from unittest.mock import MagicMock

        from aln.app.handlers.agent_handler import AgentHandler

        entity = MagicMock()
        entity.name = "TestAgent"
        entity.uid = "test-uid"
        entity.sessions = {}

        handler = AgentHandler.__new__(AgentHandler)
        handler.entity = entity
        handler.config = make_handler_config()
        handler._system_prompt = "test"
        handler._queue = MagicMock()

        adapter = MagicMock()
        handler.adapter = adapter

        session = handler._ensure_session("s1")
        assert session.provider_session_id is None

        existing_uuid = "d710cb9f-25c6-5c13-a3ee-389476910c44"
        ok_result = CLIResult(text="ok", provider_session_id=existing_uuid, return_code=0)
        adapter.run_turn.side_effect = [
            RuntimeError(f"claude CLI failed (exit 1): Error: Session ID {existing_uuid} is already in use."),
            ok_result,
        ]

        msg = MagicMock()
        msg.metadata = {}
        msg.payload = MagicMock()
        msg.payload.text = "hello"

        handler._update_system_prompt = MagicMock()
        handler._format_batch_prompt = MagicMock(return_value="hello")

        await handler._execute_batch("s1", [msg])

        assert adapter.run_turn.call_count == 2
        second_call_kwargs = adapter.run_turn.call_args_list[1]
        assert second_call_kwargs.kwargs.get("provider_session_id") == existing_uuid
        assert second_call_kwargs.kwargs.get("system_prompt") is None
        assert session.provider_session_id == existing_uuid
