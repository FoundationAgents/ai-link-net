"""Queue-based AGENT handler with session-scoped batch execution."""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from dataclasses import dataclass
from functools import partial
from typing import TYPE_CHECKING

from loguru import logger

from aln.app.adapters.cli_adapter import CLIAdapter, CLIResult
from aln.app.adapters.prompts import AGENT_HANDLER_PROMPT_TEMPLATE
from aln.app.schemas.token_usage import TokenUsageRecord
from aln.app.service.session_service import SessionService
from aln.app.service.token_usage_service import TokenUsageService
from fp.core.session import Session, SessionKind
from fp.handler import BaseHandler, HandlerConfig
from fp.message import InvokePayload, Message, MessageKind
from fp.utils.storage import get_storage_manager

if TYPE_CHECKING:
    from fp.entity import Entity


@dataclass(slots=True)
class QueuedMessage:
    """Queued message with resolved session_id."""

    session_id: str
    message: Message


def build_agent_system_prompt(entity: Entity) -> str:
    """Build complete system prompt for agent using template."""
    entity_kind = entity.kind if isinstance(entity.kind, str) else entity.kind.value

    if entity.friends:
        friends_lines = [
            f"  - {c.name} ({c.address.address}) - {c.kind}"
            for c in entity.friends.values()
        ]
        friends_list = "Your Friends:\n" + "\n".join(friends_lines)
    else:
        friends_list = "Your Friends:\n  (No friends yet)"

    description = entity.description.strip() if entity.description else ""
    if description:
        description = f"## Your Role\n{description}"

    owner_info = "None"
    owner_address = ""
    if entity.owner:
        owner_name = entity.resolve_name(entity.owner.address) or entity.owner.entity_uid
        owner_info = f"{owner_name} ({entity.owner.address})"
        owner_address = entity.owner.address

    arbiter_info = "None"
    if entity.arbiter:
        arbiter_name = entity.resolve_name(entity.arbiter.address) or entity.arbiter.entity_uid
        arbiter_info = f"{arbiter_name} ({entity.arbiter.address})"

    return AGENT_HANDLER_PROMPT_TEMPLATE.format(
        entity_kind=entity_kind,
        entity_name=entity.name,
        entity_address=entity.address.address,
        entity_uid=entity.uid,
        host_uid=entity.host.uid,
        friends_list=friends_list,
        description=description,
        owner_info=owner_info,
        owner_address=owner_address,
        arbiter_info=arbiter_info,
    ).strip()


class AgentHandler(BaseHandler):
    """Queue-based AGENT handler with session-scoped batch execution."""

    def __init__(
        self,
        entity: Entity,
        *,
        provider: str | None = None,
        config: HandlerConfig | None = None,
    ) -> None:
        super().__init__(entity)
        self.provider = (provider or "").strip().lower() or None
        self.config = config or HandlerConfig()
        self.adapter = CLIAdapter(provider) if provider else None
        self._queue: asyncio.Queue[QueuedMessage] = asyncio.Queue()
        self._loop_task: asyncio.Task[None] | None = None
        self._running_summary: str = "idle"
        self._system_prompt: str | None = None

    def _update_system_prompt(self) -> None:
        self._system_prompt = build_agent_system_prompt(self.entity)
        logger.debug(f"[{self.entity.name}] System Prompt:\n{self._system_prompt}")

    def _msgloop_prefix(self) -> str:
        return f"[{self.entity.uid}:MsgLoop]"

    def _build_running_summary(self, session_id: str, messages: list[Message]) -> str:
        message_ids = [message.message_id for message in messages]
        preview_ids = ",".join(message_ids[:3])
        if len(message_ids) > 3:
            preview_ids += ",..."
        return f"session_id={session_id} batch={len(messages)} message_ids=[{preview_ids}]"

    async def handle(self, message: Message) -> None:
        if self.adapter is None:
            logger.warning("No adapter configured for AgentHandler")
            return

        SessionService(self.entity).sync_group_session_from_message(message)
        session_id = self._resolve_session_id(message)
        await self._queue.put(QueuedMessage(session_id=session_id, message=message))
        logger.info(
            f"{self._msgloop_prefix()} 已入队 "
            f"kind={message.kind.value} "
            f"message_id={message.message_id} session_id={session_id} "
            f"waiting={self._queue.qsize()} running={self._running_summary}"
        )

        if self._loop_task is None or self._loop_task.done():
            self._loop_task = asyncio.create_task(self._process_loop())
            logger.info(f"{self._msgloop_prefix()} loop_started waiting={self._queue.qsize()}")

    async def _process_loop(self) -> None:
        while True:
            first = await self._queue.get()
            queued_invokes = [first]
            while not self._queue.empty():
                queued_invokes.append(self._queue.get_nowait())

            session_batches = self._group_messages_by_session(queued_invokes)
            for session_id, messages in session_batches.items():
                self._running_summary = self._build_running_summary(session_id, messages)
                logger.info(
                    f"{self._msgloop_prefix()} 正在执行 {self._running_summary} "
                    f"waiting={self._queue.qsize()}"
                )
                try:
                    await self._execute_batch(session_id=session_id, messages=messages)
                except Exception as e:
                    logger.error(f"{self._msgloop_prefix()} 执行失败 {self._running_summary}: {e}")
                finally:
                    self._running_summary = "idle"
                    logger.info(
                        f"{self._msgloop_prefix()} 执行完成 session_id={session_id} "
                        f"waiting={self._queue.qsize()} running={self._running_summary}"
                    )

    async def _execute_batch(self, session_id: str, messages: list[Message]) -> None:
        self._update_system_prompt()
        prompt = self._format_batch_prompt(messages)
        provider_session_id = self._get_provider_session_id(session_id)

        logger.info(
            f"{self._msgloop_prefix()} batch_detail "
            f"session_id={session_id} batch={len(messages)} "
            f"provider_session_id={provider_session_id or 'None'}"
        )

        loop = asyncio.get_event_loop()
        run_fn = partial(
            self.adapter.run_turn,
            prompt,
            self.config,
            session_id=session_id,
            provider_session_id=provider_session_id,
            system_prompt=self._system_prompt,
            entity_name=self.entity.name,
        )

        try:
            result = await loop.run_in_executor(None, run_fn)
        except RuntimeError as exc:
            error_msg = str(exc).lower()
            if provider_session_id and "no conversation found" in error_msg:
                logger.warning(
                    f"[{self.entity.name}] Stale provider_session_id={provider_session_id}, "
                    f"clearing and retrying as new conversation"
                )
                self._clear_provider_session_id(session_id)
                run_fn = partial(
                    self.adapter.run_turn,
                    prompt,
                    self.config,
                    session_id=session_id,
                    provider_session_id=None,
                    system_prompt=self._system_prompt,
                    entity_name=self.entity.name,
                )
                result = await loop.run_in_executor(None, run_fn)
            elif not provider_session_id and "already in use" in error_msg:
                existing_id = self._extract_session_id_from_error(str(exc))
                if not existing_id:
                    existing_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, session_id))
                logger.warning(
                    f"[{self.entity.name}] Session {existing_id} already in use, "
                    f"resuming existing conversation"
                )
                self._save_provider_session_id(session_id, existing_id)
                run_fn = partial(
                    self.adapter.run_turn,
                    prompt,
                    self.config,
                    session_id=session_id,
                    provider_session_id=existing_id,
                    system_prompt=None,
                    entity_name=self.entity.name,
                )
                result = await loop.run_in_executor(None, run_fn)
            else:
                raise

        self._save_provider_session_id(session_id, result.provider_session_id)
        self._record_token_usage(session_id, messages, result)

        if result.return_code != 0:
            logger.warning(
                f"[{self.entity.name}] Provider 执行失败 (exit_code={result.return_code})"
            )

    def _record_token_usage(
        self,
        session_id: str,
        messages: list[Message],
        result: CLIResult,
    ) -> None:
        provider = getattr(self, "provider", None)
        if not provider or not result.metadata:
            return

        host_uid = getattr(getattr(self.entity, "host", None), "uid", None)
        if not isinstance(host_uid, str) or not host_uid:
            logger.warning(f"[{self.entity.name}] Skip token usage record: missing host uid")
            return

        record = TokenUsageRecord.from_cli_metadata(
            host_uid=host_uid,
            entity_uid=self.entity.uid,
            entity_name=self.entity.name,
            provider=provider,
            session_id=session_id,
            provider_session_id=result.provider_session_id,
            message_ids=[message.message_id for message in messages],
            model=self.config.model,
            return_code=result.return_code,
            metadata=result.metadata,
        )
        if record is None:
            return

        TokenUsageService(host_uid).append(record)
        logger.info(
            f"[{self.entity.name}] Token usage recorded "
            f"session_id={session_id} provider={provider} total={record.total_tokens}"
        )

    def _group_messages_by_session(
        self, queued_messages: list[QueuedMessage]
    ) -> dict[str, list[Message]]:
        grouped: dict[str, list[Message]] = {}
        for queued_message in queued_messages:
            grouped.setdefault(queued_message.session_id, []).append(queued_message.message)
        return grouped

    def _extract_payload_session_id(self, message: Message) -> str | None:
        if isinstance(message.payload, InvokePayload):
            return message.payload.session_id
        if isinstance(message.payload, dict):
            raw = message.payload.get("session_id")
            if isinstance(raw, str):
                normalized = raw.strip()
                return normalized or None
        return None

    def _resolve_auto_session_id(self, message: Message) -> str:
        sender_uid = message.metadata.get("sender_uid")
        if isinstance(sender_uid, str) and sender_uid.strip():
            return f"auto:{sender_uid.strip()}"

        sender_address = message.metadata.get("sender_address")
        if isinstance(sender_address, str) and sender_address.strip():
            return f"auto:{sender_address.strip()}"

        return f"auto:{self.entity.uid}"

    def _resolve_session_id(self, message: Message) -> str:
        session_id = self._extract_payload_session_id(message)
        if session_id is None:
            session_id = self._resolve_auto_session_id(message)
        self._ensure_session(session_id, message)
        return session_id

    @staticmethod
    def _extract_sender_participant(message: Message | None) -> FPAddress | None:
        if message is None:
            return None
        sender_address = message.metadata.get("sender_address")
        if not isinstance(sender_address, str):
            return None
        normalized = sender_address.strip()
        if not normalized:
            return None
        try:
            return FPAddress(address=normalized)
        except Exception:
            return None

    @staticmethod
    def _extract_session_id_from_error(error_msg: str) -> str | None:
        """Extract UUID session ID from 'already in use' error message."""
        match = re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", error_msg)
        return match.group(0) if match else None

    @staticmethod
    def _has_participant(session: Session, participant: FPAddress) -> bool:
        return any(item.address == participant.address for item in session.participants)

    def _ensure_session(self, session_id: str, message: Message | None = None) -> Session:
        participant = self._extract_sender_participant(message)
        session = self.entity.sessions.get(session_id)
        if session is not None:
            if participant is not None and not self._has_participant(session, participant):
                session.participants.append(participant)
            session.updated_at = time.time()
            return session

        participants = [participant] if participant is not None else []
        session = Session(
            session_id=session_id,
            participants=participants,
            kind=SessionKind.IMPLICIT,
        )
        self.entity.sessions[session_id] = session
        self._save_sessions()
        return session

    def _get_provider_session_id(self, session_id: str) -> str | None:
        session = self._ensure_session(session_id)
        return session.provider_session_id

    def _clear_provider_session_id(self, session_id: str) -> None:
        """Clear in memory only — don't persist until retry succeeds."""
        session = self._ensure_session(session_id)
        session.provider_session_id = None
        session.updated_at = time.time()

    def _save_provider_session_id(
        self,
        session_id: str,
        provider_session_id: str | None,
    ) -> None:
        if not provider_session_id:
            return

        session = self._ensure_session(session_id)
        if session.provider_session_id == provider_session_id:
            return

        session.provider_session_id = provider_session_id
        session.updated_at = time.time()
        self._save_sessions()

    def _save_sessions(self) -> None:
        if not self.entity.sessions:
            return
        storage = get_storage_manager()
        sessions_dict = {
            sid: session.model_dump() for sid, session in self.entity.sessions.items()
        }
        storage.save_entity_sessions(self.entity.uid, sessions_dict)

    def _resolve_sender_name(self, message: Message) -> str:
        sender_address = message.metadata.get("sender_address", "")
        name = self.entity.resolve_name(sender_address)
        if name:
            return f"{name} ({sender_address})"
        return sender_address or "unknown"

    def _format_batch_prompt(self, messages: list[Message]) -> str:
        if len(messages) == 1:
            return self._format_single(messages[0])

        lines = ["你收到了以下新消息：\n"]
        for i, msg in enumerate(messages, 1):
            header = self._format_message_header(msg)
            text = msg.extract_text()
            lines.append(f"[{i}] {header}")
            lines.append(f"内容: {text}\n")
        lines.append("请依次处理这些消息；若 header 标记 conversation_type=group，请使用 aln group send 回复整个群。")
        return "\n".join(lines)

    def _format_single(self, message: Message) -> str:
        header = self._format_message_header(message)
        text = message.extract_text()
        group_context = self._format_group_context(message)
        parts = [header]
        if group_context:
            parts.append(group_context)
        parts.append(f"内容: {text}")
        return "\n".join(parts)

    def _format_message_header(self, message: Message) -> str:
        sender = self._resolve_sender_name(message)
        mail_id = message.metadata.get("mail_id", "")
        session_id = self._extract_payload_session_id(message) or "-"
        group_label = self._format_group_label(message)
        return (
            f"From: {sender} | kind={message.kind.value} | "
            f"mail_id={mail_id} | session_id={session_id}{group_label}"
        )

    @staticmethod
    def _group_metadata(message: Message) -> dict | None:
        if message.metadata.get("conversation_type") != "group":
            return None
        group_meta = message.metadata.get("group")
        return group_meta if isinstance(group_meta, dict) else {}

    def _format_group_label(self, message: Message) -> str:
        group_meta = self._group_metadata(message)
        if group_meta is None:
            return ""
        group_name = group_meta.get("name") or "group"
        group_id = group_meta.get("session_id") or message.metadata.get("group_id") or "-"
        return f" | conversation_type=group | group={group_name} ({group_id})"

    def _format_group_context(self, message: Message) -> str:
        group_meta = self._group_metadata(message)
        if group_meta is None:
            return ""
        members = group_meta.get("members")
        if not isinstance(members, dict):
            return "Group Members: unknown"

        lines = ["Group Members:"]
        for member in members.values():
            if not isinstance(member, dict):
                continue
            name = member.get("name") or member.get("entity_uid") or "unknown"
            address = member.get("address") or "unknown"
            role = member.get("role") or "member"
            status = member.get("status") or "active"
            lines.append(f"- {name} ({address}) role={role} status={status}")
        return "\n".join(lines)
