"""Session management API endpoints."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from fp import Entity, Host, Session

from aln.app.misc.exception_handler import exception_wrapper
from aln.app.misc.provider import get_host_runtime, get_target_entity
from aln.app.schemas import StandardResponse
from aln.app.schemas.token_usage import TokenUsageSummary
from aln.app.service.session_service import SessionService
from aln.app.service.token_usage_service import TokenUsageService

router = APIRouter(prefix="/entities/{entity_uid}/sessions", tags=["sessions"])


class GroupMemberInfo(BaseModel):
    """Group member information for API response."""
    address: str
    entity_uid: str
    host_uid: str
    name: str
    kind: str
    role: str
    status: str
    can_send: bool
    can_invite: bool
    can_remove: bool


class SessionInfo(BaseModel):
    """Session information for API response."""
    session_id: str
    name: str | None
    participants: list[str]
    created_at: float
    updated_at: float
    message_count: int = 0
    session_type: str = "direct"
    created_by: str | None = None
    members: list[GroupMemberInfo] = Field(default_factory=list)


class RenameSessionRequest(BaseModel):
    """Request to rename a session."""
    name: str = Field(..., min_length=1, max_length=100, description="New session name")


class CreateSessionRequest(BaseModel):
    """Request to create a new session."""
    contact_uid: str = Field(..., description="Contact entity UID")
    name: str | None = Field(None, max_length=100, description="Session name")


class CreateGroupSessionRequest(BaseModel):
    """Request to create a group session."""
    name: str = Field(..., min_length=1, max_length=100, description="Group name")
    members: list[str] = Field(
        default_factory=list,
        description="Friend entity uids, names, or full FP addresses to invite",
    )
    member_roles: dict[str, str] = Field(
        default_factory=dict,
        description="Optional role per member spec: admin/member/observer",
    )


class AddGroupMembersRequest(BaseModel):
    """Request to invite members into a group session."""
    members: list[str] = Field(
        default_factory=list,
        description="Friend entity uids, names, or full FP addresses to invite",
    )
    member_roles: dict[str, str] = Field(
        default_factory=dict,
        description="Optional role per member spec: admin/member/observer",
    )


class RemoveGroupMemberRequest(BaseModel):
    """Request to remove one member from a group session."""
    member: str = Field(..., min_length=1, description="Member uid, name, or FP address")


def _to_session_info(session: Session) -> SessionInfo:
    """Convert a domain session to API response schema."""
    members = SessionService.group_members(session)
    return SessionInfo(
        session_id=session.session_id,
        name=session.name,
        participants=[participant.address for participant in session.participants],
        created_at=session.created_at,
        updated_at=session.updated_at,
        message_count=0,
        session_type=SessionService.session_type(session),
        created_by=session.metadata.get("created_by") if isinstance(session.metadata.get("created_by"), str) else None,
        members=list(members.values()),
    )


@router.get("", response_model=StandardResponse[list[SessionInfo]])
@exception_wrapper(catch_http_exc=True)
async def list_sessions(
    entity_uid: str,
    target_entity: Annotated[Entity, Depends(get_target_entity)],
    contact_uid: str | None = None,
) -> StandardResponse[list[SessionInfo]]:
    """List all sessions for an entity, optionally filtered by contact."""
    service = SessionService(target_entity)
    sessions_list = [
        _to_session_info(session)
        for session in service.list_manual_sessions(contact_uid)
    ]

    return StandardResponse[list[SessionInfo]](
        success=True,
        message=f"Sessions list retrieved for entity: {entity_uid}",
        data=sessions_list,
    )


@router.post("", response_model=StandardResponse[SessionInfo])
@exception_wrapper(catch_http_exc=True)
async def create_session(
    entity_uid: str,
    request_data: CreateSessionRequest,
    target_entity: Annotated[Entity, Depends(get_target_entity)],
) -> StandardResponse[SessionInfo]:
    """Create a new session with a contact."""
    service = SessionService(target_entity)
    session = service.create_manual_session(
        contact_uid=request_data.contact_uid,
        name=request_data.name,
    )

    return StandardResponse[SessionInfo](
        success=True,
        message="Session created successfully",
        data=_to_session_info(session),
    )


@router.get("/groups", response_model=StandardResponse[list[SessionInfo]])
@exception_wrapper(catch_http_exc=True)
async def list_group_sessions(
    entity_uid: str,
    target_entity: Annotated[Entity, Depends(get_target_entity)],
) -> StandardResponse[list[SessionInfo]]:
    """List all group sessions for an entity."""
    sessions_list = [
        _to_session_info(session)
        for session in SessionService(target_entity).list_group_sessions()
    ]

    return StandardResponse[list[SessionInfo]](
        success=True,
        message=f"Group sessions retrieved for entity: {entity_uid}",
        data=sessions_list,
    )


@router.post("/groups", response_model=StandardResponse[SessionInfo])
@exception_wrapper(catch_http_exc=True)
async def create_group_session(
    entity_uid: str,
    request_data: CreateGroupSessionRequest,
    target_entity: Annotated[Entity, Depends(get_target_entity)],
    current_host: Annotated[Host, Depends(get_host_runtime)],
) -> StandardResponse[SessionInfo]:
    """Create a group session with friend entities."""
    session = SessionService(target_entity).create_group_session(
        name=request_data.name,
        members=request_data.members,
        member_roles=request_data.member_roles,
    )
    SessionService.sync_group_session_to_local_members(current_host, session)

    return StandardResponse[SessionInfo](
        success=True,
        message="Group session created successfully",
        data=_to_session_info(session),
    )


@router.post("/groups/{session_id}/members", response_model=StandardResponse[SessionInfo | dict[str, Any]])
@exception_wrapper(catch_http_exc=True)
async def add_group_members(
    entity_uid: str,
    session_id: str,
    request_data: AddGroupMembersRequest,
    target_entity: Annotated[Entity, Depends(get_target_entity)],
    current_host: Annotated[Host, Depends(get_host_runtime)],
) -> StandardResponse[SessionInfo | dict[str, Any]]:
    """Invite members into an existing group session."""
    session = SessionService(target_entity).add_group_members(
        session_id=session_id,
        members=request_data.members,
        member_roles=request_data.member_roles,
    )
    SessionService.sync_group_session_to_local_members(current_host, session)

    return StandardResponse[SessionInfo](
        success=True,
        message="Group members added successfully",
        data=_to_session_info(session),
    )


@router.post("/groups/{session_id}/members/remove", response_model=StandardResponse[SessionInfo | dict[str, Any]])
@exception_wrapper(catch_http_exc=True)
async def remove_group_member(
    entity_uid: str,
    session_id: str,
    request_data: RemoveGroupMemberRequest,
    target_entity: Annotated[Entity, Depends(get_target_entity)],
    current_host: Annotated[Host, Depends(get_host_runtime)],
) -> StandardResponse[SessionInfo | dict[str, Any]]:
    """Remove one member from a group session."""
    session, removed_address = SessionService(target_entity).remove_group_member(
        session_id=session_id,
        member_spec=request_data.member,
    )
    SessionService.sync_group_session_to_local_members(current_host, session)
    SessionService.delete_group_session_for_local_member(
        current_host,
        session.session_id,
        removed_address,
    )

    return StandardResponse[SessionInfo](
        success=True,
        message="Group member removed successfully",
        data=_to_session_info(session),
    )


@router.delete("/groups/{session_id}", response_model=StandardResponse[dict])
@exception_wrapper(catch_http_exc=True)
async def delete_group_session(
    entity_uid: str,
    session_id: str,
    target_entity: Annotated[Entity, Depends(get_target_entity)],
    current_host: Annotated[Host, Depends(get_host_runtime)],
) -> StandardResponse[dict]:
    """Delete a group session from all local known members."""
    service = SessionService(target_entity)
    session = service.get_group_session(session_id)
    service.require_group_remove_permission(session)
    SessionService.delete_group_session_from_local_members(current_host, session)

    return StandardResponse[dict](
        success=True,
        message="Group session deleted successfully",
        data={},
    )


@router.get("/{session_id}/usage", response_model=StandardResponse[TokenUsageSummary])
@exception_wrapper(catch_http_exc=True)
async def get_session_token_usage(
    entity_uid: str,
    session_id: str,
    target_entity: Annotated[Entity, Depends(get_target_entity)],
    current_host: Annotated[Host, Depends(get_host_runtime)],
) -> StandardResponse[TokenUsageSummary]:
    """Get actual provider token usage for one visible session."""
    if session_id not in target_entity.sessions:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")

    summary = TokenUsageService(current_host.uid).summarize_session(session_id)
    return StandardResponse[TokenUsageSummary](
        success=True,
        message=f"Token usage retrieved for session: {session_id}",
        data=summary,
    )


@router.post("/{session_id}/rename", response_model=StandardResponse[SessionInfo])
@exception_wrapper(catch_http_exc=True)
async def rename_session(
    entity_uid: str,
    session_id: str,
    request_data: RenameSessionRequest,
    target_entity: Annotated[Entity, Depends(get_target_entity)],
) -> StandardResponse[SessionInfo]:
    """Rename a session."""
    service = SessionService(target_entity)
    session = service.rename_manual_session(session_id, request_data.name)

    return StandardResponse[SessionInfo](
        success=True,
        message="Session renamed successfully",
        data=_to_session_info(session),
    )


@router.delete("/{session_id}", response_model=StandardResponse[dict])
@exception_wrapper(catch_http_exc=True)
async def delete_session(
    entity_uid: str,
    session_id: str,
    target_entity: Annotated[Entity, Depends(get_target_entity)],
) -> StandardResponse[dict]:
    """Delete a session."""
    SessionService(target_entity).delete_manual_session(session_id)

    return StandardResponse[dict](
        success=True,
        message="Session deleted successfully",
        data={},
    )
