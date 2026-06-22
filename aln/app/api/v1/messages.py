"""Messages API - send text messages between entities."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from loguru import logger
from pydantic import BaseModel

from fp import EntityCard, FPAddress, Host, Mail, MailStatus, Message, MessageKind
from fp.mailbox import Mailbox
from fp.message import InvokePayload

from aln.app.misc.common import resolve_sender_entity
from aln.app.misc.exception_handler import exception_wrapper
from aln.app.misc.provider import get_host_runtime
from aln.app.schemas import StandardResponse
from aln.app.service.session_service import SessionService

router = APIRouter(prefix="/messages", tags=["messages"])


class SendMessageRequest(BaseModel):
    """Send message request payload."""

    from_entity: str
    to_address: str
    text: str
    session_id: str | None = None


class SendGroupMessageRequest(BaseModel):
    """Send group message request payload."""

    from_entity: str
    session_id: str
    text: str


@router.post("/send", response_model=StandardResponse[dict])
@exception_wrapper(catch_http_exc=True)
async def send_message(
    request_data: SendMessageRequest,
    current_host: Annotated[Host, Depends(get_host_runtime)],
) -> StandardResponse[dict]:
    """Send text message from one local entity to target address."""
    sender_entity = resolve_sender_entity(current_host, request_data.from_entity)

    # 如果 to_address 不包含 ':'，说明是同 host 内的 entity_uid，补全为完整地址
    to_addr = request_data.to_address
    if ':' not in to_addr:
        to_addr = f"{current_host.uid}:{to_addr}"

    recipient_address = FPAddress(address=to_addr)
    session_id = SessionService(sender_entity).resolve_outbound_session_id(
        recipient_address,
        request_data.session_id,
    )

    text_message = Message(
        kind=MessageKind.INVOKE,
        payload=InvokePayload(text=request_data.text, session_id=session_id),
    )

    # 检查目标是否可达
    target_host_uid = recipient_address.host_uid
    delivery_status = "sent"
    warning_message = None

    # 检查路由可达性
    if target_host_uid != current_host.uid:
        # 检查是否是 child
        if target_host_uid in current_host.child_hosts:
            # 检查 child 是否连接
            if hasattr(current_host, 'child_clients') and target_host_uid not in current_host.child_clients:
                delivery_status = "offline"
                warning_message = "Target host is offline"
        else:
            # 需要转发给 parent
            if not current_host.parent_host:
                delivery_status = "unreachable"
                warning_message = "Cannot route to target host (no parent configured)"

    mail = await sender_entity.send_message(
        to=recipient_address,
        message=text_message,
    )

    # NOTE: 总是返回 SENT 状态，后续状态由 WebSocket 推送
    # mail.status 可能已经被 route_mail 异步更新，不应该返回给前端
    return StandardResponse[dict](
        success=True,
        message=warning_message or "Message sent successfully",
        data={
            "message_id": mail.message.message_id,
            "mail_id": mail.mail_id,  # Add mail_id for frontend tracking
            "from_entity_uid": sender_entity.uid,
            "to_address": request_data.to_address,
            "session_id": session_id,
            "delivery_status": delivery_status,
            "warning": warning_message,
            "status": "sent",  # Always return SENT, subsequent updates via WebSocket
        },
    )


def _resolve_group_recipients(
    sender_entity,
    session,
) -> list[tuple[FPAddress, EntityCard]]:
    """Resolve active group recipients and verify friendship."""
    recipients: list[tuple[FPAddress, EntityCard]] = []
    for member in SessionService.active_group_members(session):
        address_value = member.get("address")
        if not isinstance(address_value, str):
            continue
        address = FPAddress(address=address_value)
        if address.address == sender_entity.address.address:
            continue
        friend_card = sender_entity.friends.get(address.entity_uid)
        if friend_card is None or friend_card.address.address != address.address:
            raise HTTPException(
                status_code=403,
                detail=f"Group recipient must be sender's friend before messaging: {address.address}",
            )
        recipients.append((address, friend_card))
    if not recipients:
        raise HTTPException(status_code=400, detail="Group has no recipients")
    return recipients


def _save_group_outbound_mail(sender_entity, recipients: list[FPAddress], message: Message) -> Mail:
    """Save one readable outbound group mail for the sender."""
    outbound_mail = Mail(
        sender=sender_entity.address,
        recipient=recipients,
        message=message,
        signature="",
    )
    outbound_mail = outbound_mail._sign(sender_entity.sign_private_key)
    outbound_mail.status = MailStatus.SENT
    Mailbox(sender_entity.uid, Path(sender_entity.mailbox_path)).save_outbound(outbound_mail)
    return outbound_mail


@router.post("/send_group", response_model=StandardResponse[dict])
@exception_wrapper(catch_http_exc=True)
async def send_group_message(
    request_data: SendGroupMessageRequest,
    current_host: Annotated[Host, Depends(get_host_runtime)],
) -> StandardResponse[dict]:
    """Send one text message to all active members of a group session."""
    sender_entity = resolve_sender_entity(current_host, request_data.from_entity)
    service = SessionService(sender_entity)
    session = service.get_group_session(request_data.session_id)
    sender_member = service.require_group_send_permission(session)
    SessionService.ensure_local_group_member_friendships(current_host, session)
    recipients = _resolve_group_recipients(sender_entity, session)
    recipient_addresses = [address for address, _ in recipients]

    session.updated_at = time.time()
    sender_entity.save()
    SessionService.sync_group_session_to_local_members(current_host, session)

    group_metadata = service.build_group_message_metadata(session, sender_member)
    text_message = Message(
        kind=MessageKind.INVOKE,
        payload=InvokePayload(text=request_data.text, session_id=session.session_id),
        metadata=group_metadata,
    )

    outbound_mail = _save_group_outbound_mail(
        sender_entity,
        recipient_addresses,
        text_message,
    )

    routed: list[dict[str, str]] = []
    for recipient_address, friend_card in recipients:
        wire_mail = Mail.seal(
            sender=sender_entity.address,
            recipient=recipient_address,
            message=text_message,
            sign_private_key=sender_entity.sign_private_key,
            encrypt_public_key=friend_card.encrypt_public_key,
        )
        wire_mail = wire_mail.model_copy(update={"mail_id": outbound_mail.mail_id})
        wire_mail.status = MailStatus.SENT
        await current_host.route_mail(wire_mail)
        routed.append({
            "address": recipient_address.address,
            "entity_uid": recipient_address.entity_uid,
            "host_uid": recipient_address.host_uid,
        })

    if sender_entity.owner and sender_entity.owner.address != sender_entity.address.address:
        await sender_entity._send_carbon_copy_to_owner(
            sender_address=sender_entity.address.address,
            recipient_address=session.session_id,
            recipient_name=session.name,
            message=text_message,
            direction="outbound",
        )

    return StandardResponse[dict](
        success=True,
        message="Group message sent successfully",
        data={
            "message_id": text_message.message_id,
            "mail_id": outbound_mail.mail_id,
            "from_entity_uid": sender_entity.uid,
            "session_id": session.session_id,
            "group_name": session.name,
            "recipient_count": len(routed),
            "recipients": routed,
            "status": "sent",
        },
    )


def _format_message(mail_entry: dict) -> dict | None:
    """Format mail entry for frontend."""
    try:
        mail_data = mail_entry.get("mail", {})
        metadata = mail_entry.get("metadata", {})

        mail = Mail.from_dict(mail_data)

        sender_address = mail.sender
        message_obj = mail.message

        if hasattr(message_obj, 'model_dump'):
            message_dict = message_obj.model_dump()
        elif isinstance(message_obj, dict):
            message_dict = message_obj
        else:
            logger.warning(f"Unexpected message type: {type(message_obj)}")
            return None

        sender_str = sender_address.address if hasattr(sender_address, 'address') else str(sender_address)
        recipient_list = []
        if hasattr(mail, 'recipient'):
            for r in mail.recipient:
                recipient_list.append(r.address if hasattr(r, 'address') else str(r))

        # 获取消息类型
        kind = message_dict.get("kind", "invoke")
        if hasattr(message_obj, 'kind'):
            kind = message_obj.kind.value if hasattr(message_obj.kind, 'value') else str(message_obj.kind)

        return {
            "message_id": message_dict.get("message_id", ""),
            "mail_id": mail_data.get("mail_id", ""),
            "kind": kind,
            "sender": sender_str,
            "recipient": recipient_list,
            "payload": message_dict.get("payload", {}),
            "metadata": message_dict.get("metadata", {}),
            "conversation_type": message_dict.get("metadata", {}).get("conversation_type"),
            "group_id": message_dict.get("metadata", {}).get("group_id"),
            "timestamp": metadata.get("timestamp", ""),
            "direction": metadata.get("direction", ""),
            "is_read": metadata.get("is_read", False),
            "status": metadata.get("status", mail_data.get("status", "sent")),
        }

    except Exception as e:
        logger.error(f"Failed to process mail entry: {e}")
        return None


@router.get("/{entity_uid}", response_model=StandardResponse[list[dict[str, Any]]])
@exception_wrapper(catch_http_exc=True)
async def get_messages(
    entity_uid: str,
    current_host: Annotated[Host, Depends(get_host_runtime)],
    limit: int | None = Query(default=None, ge=1),
) -> StandardResponse[list[dict[str, Any]]]:
    """Get messages for an entity from its mailbox."""
    entity = current_host.get_entity(entity_uid)
    if entity is None:
        raise HTTPException(status_code=404, detail=f"Entity not found: {entity_uid}")

    mailbox = Mailbox(entity_uid, Path(entity.mailbox_path))
    mails = mailbox.list_mails()
    if limit is not None and len(mails) > limit:
        mails = mails[-limit:]

    messages = []
    for mail_entry in mails:
        formatted = _format_message(mail_entry)
        if formatted:
            messages.append(formatted)

    return StandardResponse[list[dict[str, Any]]](
        success=True,
        message=f"Retrieved {len(messages)} messages",
        data=messages,
    )


class MarkReadRequest(BaseModel):
    """Mark messages as read request payload."""

    message_ids: list[str]


@router.post("/{entity_uid}/mark_read", response_model=StandardResponse[dict])
@exception_wrapper(catch_http_exc=True)
async def mark_messages_read(
    entity_uid: str,
    request_data: MarkReadRequest,
    current_host: Annotated[Host, Depends(get_host_runtime)],
) -> StandardResponse[dict]:
    """Mark messages as read for an entity."""
    entity = current_host.get_entity(entity_uid)
    if entity is None:
        raise HTTPException(status_code=404, detail=f"Entity not found: {entity_uid}")

    mailbox = Mailbox(entity_uid, Path(entity.mailbox_path))

    marked_count = 0
    for message_id in request_data.message_ids:
        if mailbox.mark_as_read(message_id):
            marked_count += 1

    return StandardResponse[dict](
        success=True,
        message=f"Marked {marked_count} messages as read",
        data={"marked_count": marked_count, "total_requested": len(request_data.message_ids)},
    )
