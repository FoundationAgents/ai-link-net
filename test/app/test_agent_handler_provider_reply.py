"""AgentHandler provider reply fallback tests."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from fp import EntityKind, Host, Message, MessageKind
from fp.core.session import Session, SessionKind
from fp.mailbox import Mailbox
from fp.message import InvokePayload

from aln.app.adapters.cli_adapter import CLIResult
from aln.app.handlers.agent_handler import AgentHandler
from aln.app.service.session_service import GROUP_SESSION_TYPE
from test.app.handler_helpers import make_handler_config


def test_agent_handler_auto_sends_provider_text_reply() -> None:
    """Provider text should become a visible direct reply when no ALN mail was sent."""

    async def run() -> str:
        host = Host(name="AgentReplyHub")
        human = host.register_entity(name="Human", kind=EntityKind.HUMAN)
        agent = host.register_entity(name="Planner", kind=EntityKind.AGENT)
        human.add_friend(agent.entity_card)
        agent.add_friend(human.entity_card)
        human.save()
        agent.save()

        handler = AgentHandler.__new__(AgentHandler)
        handler.entity = agent
        handler.provider = "claude"
        handler.config = make_handler_config()
        handler._system_prompt = "test"
        handler._queue = MagicMock()
        handler.adapter = MagicMock()
        handler.adapter.run_turn.return_value = CLIResult(
            text="visible reply",
            provider_session_id="thread-reply",
            return_code=0,
        )
        handler._update_system_prompt = MagicMock()
        handler._format_batch_prompt = MagicMock(return_value="hello")

        message = Message(
            kind=MessageKind.INVOKE,
            payload=InvokePayload(text="hello", session_id="direct:reply"),
            metadata={"sender_address": human.address.address},
        )
        await handler._execute_batch("direct:reply", [message])
        await asyncio.sleep(0.1)

        inbox = Mailbox(human.uid, Path(human.mailbox_path)).list_mails(direction="inbound")
        reply = inbox[-1]["mail"]["message"]["payload"]
        return reply["text"]

    assert asyncio.run(run()) == "visible reply"


def test_agent_handler_skips_provider_text_when_cli_sent_mail() -> None:
    """Provider text fallback should not duplicate replies already sent via ALN."""

    async def run() -> int:
        host = Host(name="AgentReplyHub")
        human = host.register_entity(name="Human", kind=EntityKind.HUMAN)
        agent = host.register_entity(name="Planner", kind=EntityKind.AGENT)

        handler = AgentHandler.__new__(AgentHandler)
        handler.entity = agent
        handler.provider = "claude"
        handler.config = make_handler_config()
        handler._system_prompt = "test"
        handler._queue = MagicMock()
        handler.adapter = MagicMock()
        handler.adapter.run_turn.return_value = CLIResult(
            text="already sent",
            provider_session_id="thread-reply",
            return_code=0,
        )
        handler._update_system_prompt = MagicMock()
        handler._format_batch_prompt = MagicMock(return_value="hello")
        handler._outbound_mail_count = MagicMock(side_effect=[0, 1])
        handler._send_provider_direct_reply = AsyncMock()

        message = Message(
            kind=MessageKind.INVOKE,
            payload=InvokePayload(text="hello", session_id="direct:reply"),
            metadata={"sender_address": human.address.address},
        )
        await handler._execute_batch("direct:reply", [message])
        return handler._send_provider_direct_reply.await_count

    assert asyncio.run(run()) == 0


def test_agent_handler_skips_stopped_group_messages() -> None:
    """Stopped group messages should not enter the provider queue."""

    async def run() -> int:
        host = Host(name="StoppedGroupHub")
        human = host.register_entity(name="Human", kind=EntityKind.HUMAN)
        agent = host.register_entity(name="Planner", kind=EntityKind.AGENT)
        session_id = "group:stopped"
        agent.sessions[session_id] = Session(
            session_id=session_id,
            name="Stopped Room",
            participants=[human.address, agent.address],
            kind=SessionKind.MANUAL,
            metadata={
                "session_type": GROUP_SESSION_TYPE,
                "group_id": session_id,
                "status": "stopped",
                "members": {},
            },
        )

        handler = AgentHandler.__new__(AgentHandler)
        handler.entity = agent
        handler.adapter = MagicMock()
        handler._queue = asyncio.Queue()

        message = Message(
            kind=MessageKind.INVOKE,
            payload=InvokePayload(text="should not run", session_id=session_id),
            metadata={"conversation_type": GROUP_SESSION_TYPE, "group_id": session_id},
        )
        await handler.handle(message)
        return handler._queue.qsize()

    assert asyncio.run(run()) == 0
