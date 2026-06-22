"""Host runtime with WebSocket connection management."""

from __future__ import annotations

import asyncio
import json
import os
import signal
from pathlib import Path
from typing import Any, Awaitable, Callable

import websockets
import websockets.legacy.client
from fastapi import WebSocket
from loguru import logger
from pydantic import Field

from aln.app.endpoint import ENDPOINT
from aln.app.handlers import create_entity_handler
from fp import EntityCard, EntityKind, EntityStatus, EntityUid, Host, HostUid, HostWellKnown, Mail, get_fp_home
from fp.core.checkpoint import FriendRequestCheckPoint
from fp.core.wellknown import FPAddress
from fp.entity import Entity
from fp.handler import BaseHandler, HandlerConfig
from fp.trade.checkpoints import (
    ContractApprovalCheckPoint,
    PayClaimCheckPoint,
    PayCollectInboundCheckPoint,
    PayConfirmReceiptCheckPoint,
)
from fp.utils.path import get_entity_dir
from fp.utils.storage import OfflineMailQueueEntry, get_storage_manager

from .host_client import HostClient, HostClientError


class HostServer(Host):
    """Host runtime with WebSocket connection management.

    Extends Host with:
    1. WebSocket connections to parent/child hosts for mail forwarding
    2. HTTP mail endpoint for CLI submission
    3. Server lifecycle management
    """

    # WebSocket connections (runtime only)
    parent_ws: websockets.legacy.client.WebSocketClientProtocol | None = None
    child_clients: dict[HostUid, WebSocket] = Field(default_factory=dict)
    parent_url: str | None = None  # 父 Host 的 HTTP URL，用于建立 WS 连接

    # Entity status management (parent host maintains all discoverable entities)
    entity_status: dict[EntityUid, EntityStatus] = Field(default_factory=dict)

    # Offline message queues (grouped by entity_uid)
    offline_mail_queues: dict[EntityUid, list[Mail]] = Field(default_factory=dict)

    # Default owner for new agent entities
    default_owner: FPAddress | None = None

    # Queue configuration
    max_queue_size_per_entity: int = 100

    # ──────────────────────────────────────────────
    #  Handler 创建（覆盖 Host 协议层默认行为）
    # ──────────────────────────────────────────────

    def _serialize_offline_mail_queues(self) -> list[OfflineMailQueueEntry]:
        """Serialize offline mail queues for persistence."""
        return [
            OfflineMailQueueEntry(
                entity_uid=entity_uid,
                mails=[mail.to_dict() for mail in mails],
            )
            for entity_uid, mails in self.offline_mail_queues.items()
            if mails
        ]

    def _save_offline_mail_queues(self) -> None:
        """Persist offline mail queues."""
        storage = get_storage_manager()
        storage.save_host_offline_mail_queues(
            self.uid,
            self._serialize_offline_mail_queues(),
        )

    def _load_offline_mail_queues(self) -> None:
        """Restore offline mail queues from storage."""
        storage = get_storage_manager()
        restored: dict[EntityUid, list[Mail]] = {}

        for entry in storage.load_host_offline_mail_queues(self.uid):
            mails: list[Mail] = []
            for raw_mail in entry.mails:
                try:
                    mails.append(Mail.from_dict(raw_mail))
                except Exception as exc:
                    logger.warning(
                        f"Failed to restore offline mail for {entry.entity_uid}: {exc}"
                    )
            if mails:
                restored[entry.entity_uid] = mails

        self.offline_mail_queues = restored

    def save(self) -> None:
        """Save host state including offline mail queues."""
        super().save()
        self._save_offline_mail_queues()

    @classmethod
    def load(cls, host_uid: str) -> HostServer:
        """Load host runtime state including offline mail queues."""
        host = Host.load.__func__(cls, host_uid)
        host._load_offline_mail_queues()
        return host

    def _resolve_entity_handler(
        self,
        entity: "Entity",
        handler: BaseHandler | Callable[[Any], Awaitable[None]] | None,
        provider: str | None,
        system_prompt: str | None,
        handler_config: HandlerConfig | dict[str, Any] | None,
    ) -> BaseHandler | None:
        resolved = super()._resolve_entity_handler(
            entity=entity, handler=handler, provider=provider,
            system_prompt=system_prompt, handler_config=handler_config,
        )
        if resolved is not None:
            return resolved
        return create_entity_handler(
            entity=entity,
            kind=entity.kind,
            provider=provider,
            system_prompt=system_prompt,
            handler_config=handler_config,
        )

    def register_entity(
        self,
        name: str,
        kind: EntityKind | str,
        *,
        provider: str | None = None,
        system_prompt: str | None = None,
        handler_config: HandlerConfig | dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Entity:
        """Register entity with application-layer policies."""
        kind_value = kind.value if isinstance(kind, EntityKind) else str(kind).lower()
        refresh_runtime_policies = False

        owner_before = self.default_owner.address if self.default_owner else "None"
        logger.info(
            f"[Register] {name} kind={kind_value} | "
            f"default_owner={owner_before} | explicit_owner={kwargs.get('owner')}"
        )

        # Policy: auto_owner — use default_owner for agents
        if kwargs.get("owner") is None and kind_value == EntityKind.AGENT.value:
            kwargs["owner"] = self.default_owner

        # Policy: auto_arbiter — assign existing arbiter
        if kwargs.get("arbiter") is None:
            existing = self.get_arbiter()
            if existing:
                kwargs["arbiter"] = existing.address

        entity = super().register_entity(
            name, kind,
            provider=provider, system_prompt=system_prompt,
            handler_config=handler_config, **kwargs,
        )

        # Policy: first human becomes default_owner
        if kind_value == EntityKind.HUMAN.value and self.default_owner is None:
            self.default_owner = entity.address
            logger.info(f"Default owner set to {entity.name} ({entity.address.address})")
            refresh_runtime_policies = True

        # Policy: default workdir for agents (needs entity.uid, so after creation)
        if kind_value == EntityKind.AGENT.value and handler_config is not None:
            self._ensure_agent_workdir(entity, handler_config)

        # Policy: propagate new arbiter to all existing entities
        if kind_value == EntityKind.ARBITER.value:
            self._propagate_arbiter(entity.address)
            refresh_runtime_policies = True

        if refresh_runtime_policies:
            self._apply_load_policies()
        else:
            self._auto_friend_entity(entity)

        entity_owner = entity.owner.address if entity.owner else "None"
        logger.info(
            f"[Register] ✓ {entity.name} ({entity.uid}) registered | "
            f"owner={entity_owner} | friends={list(entity.friends.keys())}"
        )

        self.save()
        return entity

    @staticmethod
    def _ensure_agent_workdir(
        entity: Entity,
        handler_config: HandlerConfig | dict[str, Any],
    ) -> None:
        """Set default workdir for agent entities and create directory."""
        default_ws = get_entity_dir(entity.uid) / "workspace"
        if isinstance(handler_config, HandlerConfig) and handler_config.workdir is None:
            handler_config.workdir = str(default_ws)
        elif isinstance(handler_config, dict) and not handler_config.get("workdir"):
            handler_config["workdir"] = str(default_ws)
        workdir_path = (
            handler_config.workdir if isinstance(handler_config, HandlerConfig)
            else handler_config.get("workdir")
        )
        if workdir_path:
            Path(workdir_path).mkdir(parents=True, exist_ok=True)

    def _apply_load_policies(self) -> None:
        """Apply application policies after loading entities from storage."""
        owner_before = self.default_owner.address if self.default_owner else "None"
        logger.info(f"[LoadPolicy] start | default_owner={owner_before} | entities={len(self.entities)}")

        # Policy: migrate default_owner from legacy data
        if self.default_owner is None:
            for entity in self.entities.values():
                if self._entity_kind_value(entity) == EntityKind.HUMAN.value:
                    self.default_owner = entity.address
                    logger.info(f"Migrated default_owner to {entity.name} ({entity.address.address})")
                    break

        # Policy: auto_owner for agents without owner
        if self.default_owner:
            for entity in self.entities.values():
                if self._entity_kind_value(entity) == EntityKind.AGENT.value and entity.owner is None:
                    entity.owner = self.default_owner
                    logger.info(f"Auto-set owner for agent {entity.name}: {self.default_owner.entity_uid}")

        # Sync checkpoint call_owner_policy with entity.owner
        for entity in self.entities.values():
            for checkpoint_type in (
                FriendRequestCheckPoint,
                ContractApprovalCheckPoint,
                PayCollectInboundCheckPoint,
                PayClaimCheckPoint,
                PayConfirmReceiptCheckPoint,
            ):
                cp = entity.get_checkpoint(checkpoint_type)
                if cp is None:
                    continue
                expected = "always_call" if entity.owner else "always_pass"
                if cp.call_owner_policy != expected:
                    cp.call_owner_policy = expected
                    logger.info(f"[{entity.name}] Synced call_owner_policy → {expected}")

        # Policy: auto_arbiter propagation
        arbiter = self.get_arbiter()
        if arbiter:
            self._propagate_arbiter(arbiter.address)

        # Policy: auto-friend all entities with owner + arbiter
        for entity in self.entities.values():
            self._auto_friend_entity(entity)

        owner_after = self.default_owner.address if self.default_owner else "None"
        for entity in self.entities.values():
            ent_owner = entity.owner.address if entity.owner else "None"
            ent_kind = self._entity_kind_value(entity)
            logger.info(f"[LoadPolicy] entity={entity.name} ({entity.uid}) kind={ent_kind} owner={ent_owner}")
        logger.info(f"[LoadPolicy] done | default_owner={owner_after}")

    def _auto_friend_entity(self, entity: Entity) -> None:
        """Ensure entity is mutual friends with default_owner and local arbiter."""
        # Friend with owner
        if self.default_owner:
            owner = self.get_entity(self.default_owner.entity_uid)
            if owner and entity.uid != owner.uid:
                if entity.uid not in owner.friends:
                    owner.add_friend(entity.entity_card)
                    entity.add_friend(owner.entity_card)
                    logger.info(f"Auto-friended {entity.name} ↔ {owner.name}")

        # Friend with local arbiter
        arbiter = self.get_arbiter()
        if arbiter and entity.uid != arbiter.uid:
            if entity.uid not in arbiter.friends:
                arbiter.add_friend(entity.entity_card)
                entity.add_friend(arbiter.entity_card)
                logger.info(f"Auto-friended {entity.name} ↔ {arbiter.name}")

        # Friend with parent arbiter (cross-host)
        self._auto_friend_parent_arbiter(entity)

    def _auto_friend_parent_arbiter(self, entity: Entity) -> None:
        """Ensure entity is friends with parent host's arbiter (for cross-host contracts)."""
        if not self.parent_host:
            return
        for card in self.parent_host.known_public_entities:
            kind = card.kind if isinstance(card.kind, str) else card.kind.value
            if kind == EntityKind.ARBITER.value and card.entity_uid not in entity.friends:
                entity.add_friend(card)
                logger.info(f"Auto-friended {entity.name} ↔ parent arbiter {card.name}")

    # ──────────────────────────────────────────────
    #  Entity 状态管理
    # ──────────────────────────────────────────────

    def _get_child_entity_uids(self, child_uid: HostUid) -> list[EntityUid]:
        """Get all entity UIDs belonging to a child host."""
        child_host = self.child_hosts.get(child_uid)
        if not child_host:
            return []
        return [e.entity_uid for e in child_host.known_public_entities]

    async def _mark_child_entities_online(self, child_uid: HostUid) -> None:
        """Mark all entities of a connected child host as ONLINE."""
        child_host = self.child_hosts.get(child_uid)
        if not child_host:
            return

        for entity_card in child_host.known_public_entities:
            if self.entity_status.get(entity_card.entity_uid) != EntityStatus.DELETED:
                self.entity_status[entity_card.entity_uid] = EntityStatus.ONLINE
                logger.info(f"Entity {entity_card.entity_uid} marked as ONLINE")

    def _mark_child_entities_offline(self, child_uid: HostUid) -> None:
        """Mark all entities of a disconnected child host as OFFLINE."""
        child_host = self.child_hosts.get(child_uid)
        if not child_host:
            return

        for entity_card in child_host.known_public_entities:
            if self.entity_status.get(entity_card.entity_uid) != EntityStatus.DELETED:
                self.entity_status[entity_card.entity_uid] = EntityStatus.OFFLINE
                logger.info(f"Entity {entity_card.entity_uid} marked as OFFLINE")

    def _enqueue_offline_mail(self, entity_uid: EntityUid, mail: Mail) -> None:
        """Enqueue mail for offline entity."""
        if entity_uid not in self.offline_mail_queues:
            self.offline_mail_queues[entity_uid] = []

        queue = self.offline_mail_queues[entity_uid]
        if len(queue) >= self.max_queue_size_per_entity:
            logger.warning(f"Queue full for {entity_uid}, dropping oldest mail")
            queue.pop(0)  # FIFO

        queue.append(mail)
        logger.info(f"Queued mail for offline entity {entity_uid} (queue size: {len(queue)})")
        self._save_offline_mail_queues()

    async def _flush_offline_queues_for_child(self, child_uid: HostUid) -> None:
        """Flush all offline mail queues for entities belonging to a child host."""
        entity_uids = self._get_child_entity_uids(child_uid)

        for entity_uid in entity_uids:
            await self.flush_offline_queue_for_entity(child_uid, entity_uid)

    async def flush_offline_queue_for_entity(
        self, child_uid: HostUid, entity_uid: EntityUid
    ) -> int:
        """Flush offline mail queue for one entity on a child host."""
        mails = self.offline_mail_queues.pop(entity_uid, [])
        if not mails:
            return 0

        logger.info(f"Flushing {len(mails)} offline mails to {entity_uid}")
        for mail in mails:
            await self._forward_to_child(child_uid, mail)
        logger.info(f"Flushed {len(mails)} offline mails to {entity_uid}")
        self._save_offline_mail_queues()
        return len(mails)

    async def _notify_delivery_status(
        self,
        mail: Mail,
        recipient_address: str,
        status: str,
        reason: str | None = None,
    ) -> None:
        """Notify sender about delivery status via WebSocket."""
        try:
            from aln.app.api.v1.ws_messages import notify_delivery_status

            sender_entity_uid = mail.sender.entity_uid
            message_id = mail.message.message_id if hasattr(mail.message, "message_id") else str(mail.message)[:8]

            await notify_delivery_status(
                sender_entity_uid=sender_entity_uid,
                message_id=message_id,
                recipient_address=recipient_address,
                status=status,
                reason=reason,
            )
        except Exception as e:
            logger.warning(f"Failed to notify delivery status: {e}")

    async def push_to_web(self, entity_uid: EntityUid, message: "Message") -> None:
        """Push message to web UI via WebSocket (if connected)."""
        try:
            from datetime import datetime

            from aln.app.api.v1.ws_messages import manager, notify_new_message

            # 检查该 entity 是否有 WebSocket 连接
            if entity_uid not in manager.active_connections:
                logger.info(f"[Host] Entity {entity_uid} 无活跃 WebSocket 连接，跳过推送")
                return

            # 构建消息数据
            if hasattr(message, 'model_dump'):
                message_dict = message.model_dump()
                metadata = message.metadata if hasattr(message, 'metadata') else {}
                kind = message.kind.value if hasattr(message.kind, 'value') else str(message.kind)
            elif isinstance(message, dict):
                message_dict = message
                metadata = message.get("metadata", {})
                kind = message.get("kind", "invoke")
            else:
                logger.warning(f"[Host] Unknown message type: {type(message)}")
                return

            # 构造接收者地址（前端期望数组格式）
            recipient_address = f"{self.uid}:{entity_uid}"

            message_data = {
                "message_id": message_dict.get("message_id", ""),
                "mail_id": metadata.get("mail_id", ""),
                "kind": kind,
                "sender": metadata.get("sender_address", ""),
                "recipient": [recipient_address],
                "payload": message_dict.get("payload", {}),
                "metadata": metadata,
                "conversation_type": metadata.get("conversation_type"),
                "group_id": metadata.get("group_id"),
                "timestamp": datetime.utcnow().isoformat(),
                "direction": "inbound",
                "is_read": False,
                "status": "done",
            }

            await notify_new_message(entity_uid, message_data)
            logger.info(
                f"[Host] 📤 推送消息至 Web UI → {entity_uid} | "
                f"kind={kind} | message_id={message_data['message_id'][:8] if message_data['message_id'] else 'N/A'}"
            )

        except Exception as e:
            logger.error(f"[Host] Failed to push to web: {e}")
            import traceback
            logger.error(f"[Host] Traceback: {traceback.format_exc()}")

    # ──────────────────────────────────────────────
    #  WebSocket 连接管理
    # ──────────────────────────────────────────────

    async def connect_to_parent(self, parent_url: str | None = None) -> None:
        """子 Host 启动时，主动 WebSocket 连接到父 Host."""
        url = parent_url or self.parent_url
        if not url:
            logger.warning("No parent URL configured, skip connect")
            return

        self.parent_url = url

        try:
            parent_client = HostClient(url, timeout=5.0)
            parent_wellknown = await asyncio.to_thread(parent_client.get_wellknown)
            self.save_parent_info(parent_wellknown)
            self.save()
        except Exception as exc:
            logger.warning(f"Failed to sync parent wellknown before websocket connect: {exc}")

        # 创建 parent_host 对象（如果还没有）
        if self.parent_host is None:
            from urllib.parse import urlparse
            from fp import FPAddress
            from fp.utils.storage import get_storage_manager

            storage = get_storage_manager()
            config = storage.load_config()

            # 查找 parent_uid
            parent_uid = None
            for uid, entry in config.hosts.items():
                if entry.url == url or entry.parent_url == url:
                    parent_uid = entry.parent_uid
                    break

            # 如果还是找不到，从 wellknown 获取
            if not parent_uid:
                try:
                    parent_client = HostClient(url, timeout=5.0)
                    parent_wellknown = parent_client.get_wellknown()
                    parent_uid = parent_wellknown.uid
                except Exception as e:
                    logger.warning(f"Failed to get parent uid: {e}")
                    parent_uid = "unknown"

            parsed = urlparse(url)
            self.parent_host = Host(
                name=f"parent-{parent_uid[:8]}",
                address=FPAddress(address=f"{parent_uid}:0"),
                bind_host=parsed.hostname or "0.0.0.0",
                port=parsed.port or 7001,
            )
            logger.info(f"Created parent_host object: {parent_uid}")

        # http:// → ws://
        ws_url = url.replace("https://", "wss://").replace("http://", "ws://") + "/ws"

        try:
            try:
                # Disable system proxy for host-to-host local routing.
                self.parent_ws = await websockets.connect(ws_url, proxy=None)
            except TypeError:
                # Backward compatibility for websockets versions without `proxy` argument.
                self.parent_ws = await websockets.connect(ws_url)
            # 发送 handshake
            await self.parent_ws.send(json.dumps({
                "type": "handshake",
                "wellknown": self.get_wellknown().model_dump(mode="json"),
            }))
            logger.info(f"Connected to parent at {ws_url}")
            # 后台监听父 Host 发来的消息
            asyncio.create_task(self._listen_parent())
            # 后台发送心跳
            asyncio.create_task(self._heartbeat_to_parent())
        except Exception as e:
            logger.error(f"Failed to connect to parent: {e}")
            self.parent_ws = None

    async def _heartbeat_to_parent(self) -> None:
        """定期发送心跳到 parent，检测连接是否活跃."""
        while self.parent_ws:
            try:
                await asyncio.sleep(30)
                if self.parent_ws:
                    await self.parent_ws.send(json.dumps({"type": "ping"}))
                    logger.debug("Sent ping to parent")
            except Exception as e:
                logger.warning(f"Heartbeat to parent failed: {e}")
                break

    async def _listen_parent(self) -> None:
        """持续监听父 Host 通过 WebSocket 发来的消息."""
        try:
            async for raw in self.parent_ws:
                data = json.loads(raw)
                msg_type = data.get("type")
                if msg_type == "mail":
                    mail = Mail.from_dict(data["data"])
                    await self.route_mail(mail)
                elif msg_type == "pong":
                    logger.debug("Received pong from parent")
                elif msg_type == "ping":
                    await self.parent_ws.send(json.dumps({"type": "pong"}))
                    logger.debug("Sent pong to parent")
                else:
                    logger.warning(f"Unknown message type from parent: {msg_type}")
        except Exception as e:
            logger.warning(f"Parent connection lost: {e}")
            self.parent_ws = None
            # 自动重连到 parent
            await self._reconnect_to_parent()

    async def _reconnect_to_parent(self) -> None:
        """自动重连到 parent，带指数退避."""
        if not self.parent_url:
            return

        max_attempts = 10
        base_delay = 2.0

        for attempt in range(1, max_attempts + 1):
            delay = min(base_delay * (2 ** (attempt - 1)), 60)
            logger.info(f"Reconnecting to parent (attempt {attempt}/{max_attempts}) in {delay}s...")
            await asyncio.sleep(delay)

            try:
                await self.connect_to_parent(self.parent_url)
                logger.info(f"Reconnected to parent successfully")
                return
            except Exception as e:
                logger.warning(f"Reconnect attempt {attempt} failed: {e}")

        logger.error(f"Failed to reconnect to parent after {max_attempts} attempts")

    async def disconnect_from_parent(self) -> None:
        """断开与父 Host 的 WebSocket 连接."""
        if self.parent_ws:
            try:
                await self.parent_ws.close()
            except Exception:
                pass
            self.parent_ws = None
            logger.info("Disconnected from parent")

    async def accept_child_connection(
        self, child_uid: HostUid, websocket: WebSocket
    ) -> None:
        """接受子 Host 的 WebSocket 连接."""
        self.child_clients[child_uid] = websocket
        logger.info(f"Child host {child_uid} connected")

        # Mark child entities as ONLINE
        await self._mark_child_entities_online(child_uid)

        # Flush offline mail queues
        await self._flush_offline_queues_for_child(child_uid)

    async def remove_child_connection(self, child_uid: HostUid) -> None:
        """移除子 Host 的 WebSocket 连接."""
        self.child_clients.pop(child_uid, None)
        logger.info(f"Child host {child_uid} disconnected")

        # Mark child entities as OFFLINE
        self._mark_child_entities_offline(child_uid)

    # ──────────────────────────────────────────────
    #  核心方法：路由邮件（覆盖父类，增加状态检查）
    # ──────────────────────────────────────────────

    async def route_mail(self, mail: Mail) -> None:
        """Route mail with entity status checking and offline queueing."""
        from collections import defaultdict
        from fp.core import MailStatus
        from fp.core.wellknown import FPAddress

        mail_id = mail.mail_id if hasattr(mail, 'mail_id') else ""

        # Update status to DELIVERING when host starts routing
        mail.status = MailStatus.DELIVERING

        # Extract recipient entity UIDs for logging
        recipient_uids = [r.entity_uid for r in mail.recipient]
        logger.info(
            f"[Host {self.name}] 🔀 路由中 [{mail.status.value.upper()}] "
            f"→ {', '.join(recipient_uids)} | mail_id={mail_id}"
        )

        # Group recipients by host_uid
        recipients_by_host: dict[HostUid, list[EntityUid]] = defaultdict(list)
        for recipient in mail.recipient:
            host_uid, entity_uid = recipient.address.split(":")
            recipients_by_host[host_uid].append(entity_uid)

        parent_recipients: list[FPAddress] = []

        for host_uid, entity_uids in recipients_by_host.items():
            # Check if recipient is a child - apply status checking
            if host_uid in self.child_hosts:
                logger.debug(f"[Host {self.name}] 转发至子 Host {host_uid}")

                # Check each entity status
                for entity_uid in entity_uids:
                    status = self.entity_status.get(entity_uid, EntityStatus.ONLINE)
                    recipient_address = f"{host_uid}:{entity_uid}"

                    if status == EntityStatus.DELETED:
                        # Entity deleted - notify sender, don't queue
                        logger.warning(f"Entity {entity_uid} is DELETED, notifying sender")
                        await self._notify_delivery_status(
                            mail=mail,
                            recipient_address=recipient_address,
                            status="failed",
                            reason="entity deleted"
                        )
                        continue

                    if status == EntityStatus.OFFLINE:
                        # Entity offline - queue and notify sender
                        logger.info(f"Entity {entity_uid} is OFFLINE, queueing mail")
                        child_mail = mail.model_copy(update={
                            "recipient": [FPAddress(address=recipient_address)]
                        })
                        self._enqueue_offline_mail(entity_uid, child_mail)
                        await self._notify_delivery_status(
                            mail=mail,
                            recipient_address=recipient_address,
                            status="queued",
                            reason="recipient offline"
                        )
                        continue

                    # Status is ONLINE - forward normally
                    child_mail = mail.model_copy(update={
                        "recipient": [FPAddress(address=recipient_address)]
                    })
                    forwarded = await self._forward_to_child(host_uid, child_mail)
                    if forwarded:
                        await self._notify_delivery_status(
                            mail=mail,
                            recipient_address=recipient_address,
                            status="delivered",
                            reason=None
                        )
                    else:
                        self._enqueue_offline_mail(entity_uid, child_mail)
                        await self._notify_delivery_status(
                            mail=mail,
                            recipient_address=recipient_address,
                            status="queued",
                            reason="child host unavailable"
                        )

                continue

            # Check if recipient is on this host - no status check needed (local entities always available)
            if host_uid == self.uid:
                for entity_uid in entity_uids:
                    entity = self.entities.get(entity_uid)
                    if entity:
                        entity_mail = mail.model_copy(
                            update={"recipient": [FPAddress(address=f"{host_uid}:{entity_uid}")]}
                        )
                        asyncio.create_task(entity.receive_mail(entity_mail))
                        # NOTE: 不再这里推送 WebSocket，由 HumanHandler 负责
                        await self._notify_delivery_status(
                            mail=mail,
                            recipient_address=f"{host_uid}:{entity_uid}",
                            status="delivered",
                            reason=None
                        )
                    else:
                        logger.warning(f"[Host {self.name}] ❌ 实体不存在: {entity_uid}")
                        await self._notify_delivery_status(
                            mail=mail,
                            recipient_address=f"{host_uid}:{entity_uid}",
                            status="failed",
                            reason="entity not found"
                        )
                continue

            # Collect recipients for parent forwarding (no status check, parent will handle it)
            logger.debug(f"[Host {self.name}] 收集转发至父 Host: {host_uid}")
            for entity_uid in entity_uids:
                parent_recipients.append(FPAddress(address=f"{host_uid}:{entity_uid}"))

        # Forward to parent once with all parent-bound recipients
        if parent_recipients:
            logger.debug(f"[Host {self.name}] 转发至父 Host: {[r.entity_uid for r in parent_recipients]}")
            if self.parent_host or self.parent_url:
                parent_mail = mail.model_copy(update={"recipient": parent_recipients})
                forwarded = await self._forward_to_parent(parent_mail)
                if not forwarded:
                    for recipient in parent_recipients:
                        await self._notify_delivery_status(
                            mail=mail,
                            recipient_address=recipient.address,
                            status="failed",
                            reason="parent host unavailable",
                        )
            else:
                logger.warning(
                    f"Cannot route mail: no parent configured, recipients={[r.address for r in parent_recipients]}"
                )
                for recipient in parent_recipients:
                    await self._notify_delivery_status(
                        mail=mail,
                        recipient_address=recipient.address,
                        status="failed",
                        reason="no parent configured",
                    )

    # ──────────────────────────────────────────────
    #  核心方法：通过 WebSocket 转发邮件
    # ──────────────────────────────────────────────

    async def _forward_to_parent(self, mail: Mail) -> bool:
        """通过 WebSocket 转发邮件到父 Host."""
        if self.parent_ws:
            try:
                await self.parent_ws.send(json.dumps(
                    {"type": "mail", "data": mail.to_dict()}
                ))
                logger.info("Forwarded mail to parent via WebSocket")
                return True
            except Exception as exc:
                logger.warning(f"Failed to forward mail to parent via WebSocket: {exc}")
                self.parent_ws = None

        parent_url = self.parent_url or (self.parent_host.url if self.parent_host else None)
        if not parent_url:
            logger.warning("Not connected to parent and no parent_url configured")
            return False

        try:
            parent_client = HostClient(parent_url, timeout=5.0)
            await asyncio.to_thread(parent_client.send_mail, mail)
            logger.info(f"Forwarded mail to parent via HTTP: {parent_url}")
            return True
        except HostClientError as exc:
            logger.warning(f"Failed to forward mail to parent via HTTP: {exc}")
            return False
        except Exception as exc:
            logger.warning(f"Unexpected error forwarding mail to parent via HTTP: {exc}")
            return False

    async def _forward_to_child(self, child_uid: HostUid, mail: Mail) -> bool:
        """通过 WebSocket 转发邮件到子 Host."""
        ws = self.child_clients.get(child_uid)
        if ws:
            try:
                await ws.send_json({"type": "mail", "data": mail.to_dict()})
                logger.info(f"Forwarded mail to child {child_uid} via WebSocket")
                return True
            except Exception as exc:
                logger.warning(
                    f"Failed to forward mail to child {child_uid} via WebSocket: {exc}"
                )

        child_host = self.child_hosts.get(child_uid)
        child_url = child_host.url if child_host else None
        if not child_url:
            logger.warning(f"Child {child_uid} has no reachable URL, cannot forward mail")
            return False

        try:
            child_client = HostClient(child_url, timeout=5.0)
            await asyncio.to_thread(child_client.send_mail, mail)
            logger.info(f"Forwarded mail to child {child_uid} via HTTP: {child_url}")
            return True
        except HostClientError as exc:
            logger.warning(f"Failed to forward mail to child {child_uid} via HTTP: {exc}")
            return False
        except Exception as exc:
            logger.warning(
                f"Unexpected error forwarding mail to child {child_uid} via HTTP: {exc}"
            )
            return False

    def to_dict(self) -> dict[str, Any]:
        """Convert HostServer to dict, excluding runtime-only fields."""
        return self.model_dump(
            exclude={"parent_ws", "child_clients", "config"},
            exclude_none=True,
            mode="json",
        )

    # ──────────────────────────────────────────────
    #  状态查询
    # ──────────────────────────────────────────────

    def is_parent_connected(self) -> bool:
        """父连接是否活跃."""
        return self.parent_ws is not None

    def get_connected_children(self) -> list[HostUid]:
        """获取已连接的子 Host 列表."""
        return list(self.child_clients.keys())

    def start_ui(self, port: int) -> dict[str, Any]:
        """Start web UI daemon process."""
        config_dir = Path(get_fp_home())
        config_dir.mkdir(parents=True, exist_ok=True)
        pid_file = config_dir / "ui.pid"

        # Check if already running
        if pid_file.exists():
            try:
                pid = int(pid_file.read_text().strip())
                os.kill(pid, 0)
                return {
                    "success": False,
                    "message": f"UI is already running on port {port} (PID: {pid})",
                    "data": {"pid": pid, "port": port},
                }
            except (OSError, ValueError, ProcessLookupError):
                pid_file.unlink(missing_ok=True)

        # TODO: Implement actual UI daemon startup logic
        # For now, return placeholder response
        pid_file.write_text(str(os.getpid()))
        return {
            "success": True,
            "message": f"UI started successfully on port {port}",
            "data": {"pid": os.getpid(), "port": port},
        }

    def stop_ui(self) -> dict[str, Any]:
        """Stop web UI daemon process."""
        config_dir = Path(get_fp_home())
        pid_file = config_dir / "ui.pid"

        if not pid_file.exists():
            return {
                "success": False,
                "message": "UI is not running",
                "data": {},
            }

        try:
            pid = int(pid_file.read_text().strip())
            os.killpg(os.getpgid(pid), signal.SIGTERM)
            pid_file.unlink()
            return {
                "success": True,
                "message": f"UI stopped (PID: {pid})",
                "data": {"pid": pid},
            }
        except (OSError, ValueError, ProcessLookupError) as e:
            pid_file.unlink(missing_ok=True)
            return {
                "success": False,
                "message": f"Failed to stop UI: {e}",
                "data": {},
            }


    @property
    def ws_url(self) -> str:
        """WebSocket URL (converts 0.0.0.0 to 127.0.0.1)."""
        host = self.bind_host
        if not host or host == "0.0.0.0":
            host = "127.0.0.1"
        return f"ws://{host}:{self.port}"

    def register_child(self, child_wellknown: HostWellKnown) -> None:
        """注册子 Host（填充 child_hosts 以支持 route_mail 路由）."""
        self._set_child_host(child_wellknown)

        is_connected = child_wellknown.uid in self.child_clients
        for entity_card in child_wellknown.public_entities:
            if self.entity_status.get(entity_card.entity_uid) == EntityStatus.DELETED:
                continue
            self.entity_status[entity_card.entity_uid] = (
                EntityStatus.ONLINE if is_connected else EntityStatus.OFFLINE
            )

        # Friend local Arbiter with child's entities (so Arbiter can verify their messages)
        arbiter = self.get_arbiter()
        if arbiter:
            for card in child_wellknown.public_entities:
                if card.entity_uid not in arbiter.friends:
                    arbiter.add_friend(card)
                    logger.info(f"Auto-friended arbiter {arbiter.name} ↔ child entity {card.name}")

    def delete_entity(self, entity_uid: EntityUid) -> None:
        """Delete entity and sync to parent."""
        # Mark as DELETED and clear queue
        self.entity_status[entity_uid] = EntityStatus.DELETED
        self.offline_mail_queues.pop(entity_uid, None)
        self._save_offline_mail_queues()
        logger.info(f"Entity {entity_uid} marked as DELETED, queue cleared")

        # Call parent method
        super().delete_entity(entity_uid)

        # Notify parent about deletion (async, don't block)
        if self.parent_url:
            asyncio.create_task(self._notify_parent_entity_deleted(entity_uid))

    async def _notify_parent_entity_deleted(self, entity_uid: EntityUid) -> None:
        """Notify parent host about entity deletion via HTTP."""
        if not self.parent_url:
            return

        try:
            parent_client = HostClient(self.parent_url, timeout=5.0)
            # Call parent's entity deletion endpoint
            await asyncio.to_thread(
                parent_client._request,
                "POST",
                f"{ENDPOINT.ENTITIES}/{entity_uid}/mark_deleted",
                payload={"host_uid": self.uid},
            )
            logger.info(f"Notified parent about entity {entity_uid} deletion")
        except Exception as e:
            logger.warning(f"Failed to notify parent about entity deletion: {e}")

    def delete_host_by_uid(self, host_uid: str) -> bool:
        """Delete host and close WebSocket connection."""
        # 如果是 child，先关闭 WebSocket 连接
        if host_uid in self.child_clients:
            ws = self.child_clients.pop(host_uid)
            try:
                asyncio.create_task(ws.close())
            except Exception:
                pass
            logger.info(f"Closed WebSocket for child {host_uid}")

        # 调用父类方法删除 host
        return super().delete_host_by_uid(host_uid)

    def save_parent_info(self, parent_wellknown: HostWellKnown) -> None:
        """保存父 Host 信息并传播 Arbiter + 互友。"""
        self.parent_host = Host.from_wellknown(parent_wellknown)
        parent_arbiter = next(
            (
                card for card in parent_wellknown.public_entities
                if self._entity_kind_value(card) == EntityKind.ARBITER.value
            ),
            None,
        )
        if parent_arbiter:
            self._propagate_arbiter(parent_arbiter.address)
            logger.info(f"Propagated parent arbiter {parent_arbiter.name} to all entities")

        # Friend all local entities with parent arbiter
        for entity in self.entities.values():
            self._auto_friend_parent_arbiter(entity)

    async def ensure_parent_connection(self) -> None:
        """确保与父 Host 的 WebSocket 连接已建立."""
        if not self.is_parent_connected():
            await self.connect_to_parent()

    async def sync_wellknown_to_parent(self) -> None:
        """Sync current host wellknown to parent so parent can refresh entity cache."""
        if not self.parent_url:
            return

        try:
            parent_client = HostClient(self.parent_url, timeout=5.0)
            current_wellknown = self.get_wellknown()
            parent_wellknown = await asyncio.to_thread(
                parent_client.register_child,
                current_wellknown,
            )
            self.save_parent_info(parent_wellknown)
        except HostClientError as exc:
            logger.warning(f"Failed to sync wellknown to parent: {exc}")
        except Exception as exc:
            logger.warning(f"Unexpected error when syncing wellknown: {exc}")

    async def get_discoverable_entities_from_network(self) -> list[EntityCard]:
        """Collect discoverable entities from self+children and one-level parent.

        Returns all public entities accessible from this host's network perspective:
        - This host's public entities
        - All children hosts' public entities (from local cache)
        - Parent host's discoverable entities (includes parent + parent's all children)

        This enables network-level discovery where a child can discover sibling nodes through parent.
        """
        # Use local cache (children entities are synced via wellknown updates)
        discoverable_entities = self.get_discoverable_entities(include_parent=False)

        # Fetch from parent (if exists)
        if self.parent_url:
            try:
                parent_client = HostClient(self.parent_url, timeout=5.0)
                parent_discoverable = await asyncio.to_thread(parent_client.entity_search)
                discoverable_entities.extend(parent_discoverable)
            except HostClientError as exc:
                logger.warning(f"Failed to fetch parent discoverable entities: {exc}")
            except Exception as exc:
                logger.warning(f"Unexpected error while fetching parent entities: {exc}")

        return self._deduplicate_entity_cards(discoverable_entities)
