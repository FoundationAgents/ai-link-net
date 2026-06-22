"""Session lifecycle and classification helpers."""

from __future__ import annotations

import hashlib
import time
from uuid import uuid4

from fastapi import HTTPException

from fp import Entity, EntityCard, FPAddress, Host, Message, Session
from fp.core.session import SessionKind


GROUP_SESSION_TYPE = "group"
DIRECT_SESSION_TYPE = "direct"

GROUP_OWNER = "owner"
GROUP_ADMIN = "admin"
GROUP_MEMBER = "member"
GROUP_OBSERVER = "observer"

GROUP_ROLES = {GROUP_OWNER, GROUP_ADMIN, GROUP_MEMBER, GROUP_OBSERVER}
GROUP_ACTIVE = "active"
GROUP_REMOVED = "removed"

GROUP_ROLE_PERMISSIONS: dict[str, dict[str, bool]] = {
    GROUP_OWNER: {"can_send": True, "can_invite": True, "can_remove": True},
    GROUP_ADMIN: {"can_send": True, "can_invite": True, "can_remove": True},
    GROUP_MEMBER: {"can_send": True, "can_invite": False, "can_remove": False},
    GROUP_OBSERVER: {"can_send": False, "can_invite": False, "can_remove": False},
}


class SessionService:
    """Encapsulate chat session rules for one entity."""

    def __init__(self, entity: Entity):
        """Bind the service to one entity."""
        self.entity = entity

    @staticmethod
    def build_implicit_session_id(sender: FPAddress, recipient: FPAddress) -> str:
        """Build the stable implicit session id for one sender-recipient pair."""
        participants = sorted([sender.address, recipient.address])
        raw = "|".join(participants)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    @staticmethod
    def session_matches_contact(session: Session, contact_uid: str) -> bool:
        """Check whether the session belongs to the given contact."""
        return any(participant.entity_uid == contact_uid for participant in session.participants)

    @staticmethod
    def session_type(session: Session) -> str:
        """Return the application-level session type."""
        raw = session.metadata.get("session_type")
        return raw if isinstance(raw, str) and raw else DIRECT_SESSION_TYPE

    @staticmethod
    def is_group_session(session: Session) -> bool:
        """Return whether this session is a group chat session."""
        return SessionService.session_type(session) == GROUP_SESSION_TYPE

    @staticmethod
    def role_permissions(role: str) -> dict[str, bool]:
        """Return normalized permissions for one group role."""
        return dict(GROUP_ROLE_PERMISSIONS.get(role, GROUP_ROLE_PERMISSIONS[GROUP_MEMBER]))

    @staticmethod
    def group_members(session: Session) -> dict[str, dict]:
        """Return group members keyed by FP address."""
        members = session.metadata.get("members")
        return members if isinstance(members, dict) else {}

    @staticmethod
    def active_group_members(session: Session) -> list[dict]:
        """Return active group member records."""
        return [
            member
            for member in SessionService.group_members(session).values()
            if member.get("status", GROUP_ACTIVE) == GROUP_ACTIVE
        ]

    @staticmethod
    def _address_key(address: FPAddress | str) -> str:
        return address.address if isinstance(address, FPAddress) else str(address)

    def list_manual_sessions(self, contact_uid: str | None = None) -> list[Session]:
        """Return visible chat sessions, newest first."""
        sessions = [
            session
            for session in self.entity.sessions.values()
            if session.kind == SessionKind.MANUAL
        ]
        if contact_uid:
            sessions = [
                session
                for session in sessions
                if self.session_matches_contact(session, contact_uid)
            ]
        return sorted(sessions, key=lambda session: session.updated_at, reverse=True)

    def create_manual_session(self, contact_uid: str, name: str | None = None) -> Session:
        """Create and persist one user-visible session."""
        contact_card = self.entity.friends.get(contact_uid)
        if contact_card is None:
            raise HTTPException(status_code=404, detail=f"Contact not found: {contact_uid}")

        now = time.time()
        session = Session(
            session_id=f"{contact_uid}-{int(now * 1000)}",
            name=name or f"Chat with {contact_card.name}",
            participants=[contact_card.address],
            kind=SessionKind.MANUAL,
            created_at=now,
            updated_at=now,
        )
        self.entity.sessions[session.session_id] = session
        self.entity.save()
        return session

    def list_group_sessions(self) -> list[Session]:
        """Return visible group sessions, newest first."""
        sessions = [
            session
            for session in self.entity.sessions.values()
            if (
                session.kind == SessionKind.MANUAL
                and self.is_group_session(session)
                and self._self_is_active_group_member(session)
            )
        ]
        return sorted(sessions, key=lambda session: session.updated_at, reverse=True)

    def create_group_session(
        self,
        *,
        name: str,
        members: list[str],
        member_roles: dict[str, str] | None = None,
    ) -> Session:
        """Create and persist one group session owned by this entity."""
        member_roles = member_roles or {}
        member_entries: dict[str, dict] = {}

        creator_entry = self._member_entry_from_entity(self.entity, GROUP_OWNER)
        member_entries[creator_entry["address"]] = creator_entry

        for member_spec in members:
            role = member_roles.get(member_spec, GROUP_MEMBER)
            entry = self._resolve_group_member(member_spec, role)
            member_entries[entry["address"]] = entry

        if len(member_entries) < 2:
            raise HTTPException(status_code=400, detail="A group requires at least two members")

        now = time.time()
        participants = [
            FPAddress(address=address)
            for address in sorted(member_entries)
        ]
        session_id = f"group:{uuid4().hex[:12]}"
        session = Session(
            session_id=session_id,
            name=name,
            participants=participants,
            kind=SessionKind.MANUAL,
            metadata={
                "session_type": GROUP_SESSION_TYPE,
                "group_id": session_id,
                "name": name,
                "created_by": self.entity.address.address,
                "members": member_entries,
                "policy": {
                    "require_friendship": True,
                    "default_role": GROUP_MEMBER,
                    "allow_member_invite": False,
                },
            },
            created_at=now,
            updated_at=now,
        )
        self.entity.sessions[session.session_id] = session
        self.entity.save()
        return session

    def upsert_group_session(self, source_session: Session) -> Session:
        """Create or update a local copy of a group session."""
        if not self.is_group_session(source_session):
            raise HTTPException(status_code=400, detail="Session is not a group session")

        existing = self.entity.sessions.get(source_session.session_id)
        session_data = source_session.model_dump()
        if existing is not None:
            session_data["created_at"] = existing.created_at
        session_data["updated_at"] = time.time()
        session = Session(**session_data)
        self.entity.sessions[session.session_id] = session
        self.entity.save()
        return session

    def get_group_session(self, session_id: str) -> Session:
        """Load one group session or raise a user-facing error."""
        session = self.entity.sessions.get(session_id)
        if session is None or not self.is_group_session(session):
            raise HTTPException(status_code=404, detail=f"Group session not found: {session_id}")
        return session

    def require_group_send_permission(self, session: Session) -> dict:
        """Return this entity's group member record if it can send."""
        return self._require_group_permission(session, "can_send", "send in this group")

    def require_group_invite_permission(self, session: Session) -> dict:
        """Return this entity's group member record if it can invite."""
        return self._require_group_permission(session, "can_invite", "invite members")

    def require_group_remove_permission(self, session: Session) -> dict:
        """Return this entity's group member record if it can remove."""
        return self._require_group_permission(session, "can_remove", "remove members")

    def _require_group_permission(
        self,
        session: Session,
        permission: str,
        action: str,
    ) -> dict:
        """Return this entity's group member record if one permission is present."""
        member = self._get_self_group_member(session)
        if member is None:
            raise HTTPException(status_code=403, detail="Sender is not a member of this group")
        if member.get("status", GROUP_ACTIVE) != GROUP_ACTIVE:
            raise HTTPException(status_code=403, detail="Sender is not active in this group")
        if not bool(member.get(permission)):
            raise HTTPException(status_code=403, detail=f"Sender does not have permission to {action}")
        return member

    def add_group_members(
        self,
        *,
        session_id: str,
        members: list[str],
        member_roles: dict[str, str] | None = None,
    ) -> Session:
        """Invite new members into an existing group session."""
        if not members:
            raise HTTPException(status_code=400, detail="At least one member is required")

        session = self.get_group_session(session_id)
        self.require_group_invite_permission(session)
        member_roles = member_roles or {}
        member_entries = dict(self.group_members(session))

        for member_spec in members:
            role = member_roles.get(member_spec, GROUP_MEMBER)
            entry = self._resolve_group_member(member_spec, role)
            existing = member_entries.get(entry["address"])
            if existing and existing.get("status", GROUP_ACTIVE) == GROUP_ACTIVE:
                continue
            member_entries[entry["address"]] = entry

        self._replace_group_members(session, member_entries)
        self.entity.save()
        return session

    def remove_group_member(self, session_id: str, member_spec: str) -> tuple[Session, str]:
        """Mark one group member as removed and return its address."""
        session = self.get_group_session(session_id)
        self.require_group_remove_permission(session)
        member_entries = dict(self.group_members(session))
        member_address = self._resolve_existing_group_member_address(session, member_spec)
        member = member_entries[member_address]

        if member_address == self.entity.address.address:
            raise HTTPException(status_code=400, detail="Use delete room instead of removing yourself")
        if member.get("role") == GROUP_OWNER:
            raise HTTPException(status_code=400, detail="Group owner cannot be removed")
        if member.get("status", GROUP_ACTIVE) != GROUP_ACTIVE:
            return session, member_address

        active_after_removal = [
            entry
            for address, entry in member_entries.items()
            if address != member_address and entry.get("status", GROUP_ACTIVE) == GROUP_ACTIVE
        ]
        if len(active_after_removal) < 2:
            raise HTTPException(status_code=400, detail="A group requires at least two active members")

        member_entries[member_address] = {
            **member,
            "status": GROUP_REMOVED,
            "can_send": False,
            "can_invite": False,
            "can_remove": False,
        }
        self._replace_group_members(session, member_entries)
        self.entity.save()
        return session, member_address

    def build_group_message_metadata(self, session: Session, sender_member: dict) -> dict:
        """Build portable group metadata for a message."""
        return {
            "conversation_type": GROUP_SESSION_TYPE,
            "group_id": session.session_id,
            "group": {
                "session_id": session.session_id,
                "name": session.name,
                "created_by": session.metadata.get("created_by"),
                "sender_role": sender_member.get("role", GROUP_MEMBER),
                "members": self.group_members(session),
                "policy": session.metadata.get("policy", {}),
            },
        }

    def sync_group_session_from_message(self, message: Message) -> Session | None:
        """Import group session metadata carried by an inbound message."""
        group_meta = message.metadata.get("group") if isinstance(message.metadata, dict) else None
        if not isinstance(group_meta, dict):
            return None

        session_id = group_meta.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            return None

        members_raw = group_meta.get("members")
        if not isinstance(members_raw, dict):
            return None

        participants = [
            FPAddress(address=address)
            for address in sorted(members_raw)
        ]
        now = time.time()
        existing = self.entity.sessions.get(session_id)
        session = Session(
            session_id=session_id,
            name=group_meta.get("name") or session_id,
            participants=participants,
            kind=SessionKind.MANUAL,
            metadata={
                "session_type": GROUP_SESSION_TYPE,
                "group_id": session_id,
                "name": group_meta.get("name") or session_id,
                "created_by": group_meta.get("created_by"),
                "members": members_raw,
                "policy": group_meta.get("policy") if isinstance(group_meta.get("policy"), dict) else {},
            },
            created_at=existing.created_at if existing else now,
            updated_at=now,
        )
        self.entity.sessions[session_id] = session
        self.entity.save()
        return session

    @classmethod
    def sync_group_session_to_local_members(
        cls,
        current_host: Host,
        session: Session,
    ) -> None:
        """Persist a group session copy for every local active member."""
        cls.ensure_local_group_member_friendships(current_host, session)
        for entity in cls._local_active_group_entities(current_host, session):
            cls(entity).upsert_group_session(session)

    @classmethod
    def ensure_local_group_member_friendships(
        cls,
        current_host: Host,
        session: Session,
    ) -> None:
        """Ensure local group members can route messages to each other."""
        entities = cls._local_active_group_entities(current_host, session)
        for entity in entities:
            changed = False
            for peer in entities:
                if peer.uid == entity.uid or peer.uid in entity.friends:
                    continue
                entity.add_friend(peer.entity_card)
                changed = True
            if changed:
                entity.save()

    @classmethod
    def delete_group_session_from_local_members(
        cls,
        current_host: Host,
        session: Session,
    ) -> None:
        """Delete a group session copy from every local known member."""
        for entity in cls._local_group_entities(current_host, session, include_removed=True):
            if session.session_id not in entity.sessions:
                continue
            del entity.sessions[session.session_id]
            entity.save()

    @classmethod
    def delete_group_session_for_local_member(
        cls,
        current_host: Host,
        session_id: str,
        member_address: str,
    ) -> None:
        """Delete one group session copy when a local member is removed."""
        address = FPAddress(address=member_address)
        if address.host_uid != current_host.uid:
            return
        entity = current_host.get_entity(address.entity_uid)
        if entity is None or session_id not in entity.sessions:
            return
        del entity.sessions[session_id]
        entity.save()

    @classmethod
    def _local_active_group_entities(
        cls,
        current_host: Host,
        session: Session,
    ) -> list[Entity]:
        """Return active group members that belong to the current host."""
        return cls._local_group_entities(current_host, session, include_removed=False)

    @classmethod
    def _local_group_entities(
        cls,
        current_host: Host,
        session: Session,
        *,
        include_removed: bool,
    ) -> list[Entity]:
        """Return group members that belong to the current host."""
        entities: list[Entity] = []
        seen: set[str] = set()
        for member in cls.group_members(session).values():
            if not include_removed and member.get("status", GROUP_ACTIVE) != GROUP_ACTIVE:
                continue
            if member.get("host_uid") != current_host.uid:
                continue
            entity_uid = member.get("entity_uid")
            if not isinstance(entity_uid, str) or entity_uid in seen:
                continue
            entity = current_host.get_entity(entity_uid)
            if entity is not None:
                entities.append(entity)
                seen.add(entity_uid)
        return entities

    def rename_manual_session(self, session_id: str, name: str) -> Session:
        """Rename and persist one visible session."""
        session = self._get_manual_session(session_id)
        session.name = name
        session.updated_at = time.time()
        self.entity.save()
        return session

    def delete_manual_session(self, session_id: str) -> None:
        """Delete and persist one visible session."""
        self._get_manual_session(session_id)
        del self.entity.sessions[session_id]
        self.entity.save()

    def resolve_outbound_session_id(
        self,
        recipient: FPAddress,
        requested_session_id: str | None,
    ) -> str:
        """Resolve which session id should be attached to one outbound message."""
        if requested_session_id:
            return self._touch_existing_session(requested_session_id, recipient)
        return self._touch_implicit_session(recipient)

    def _get_manual_session(self, session_id: str) -> Session:
        """Load one visible session or raise a user-facing error."""
        session = self.entity.sessions.get(session_id)
        if session is None or session.kind != SessionKind.MANUAL:
            raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
        return session

    def _touch_existing_session(self, session_id: str, recipient: FPAddress) -> str:
        """Refresh one explicit session before use."""
        session = self.entity.sessions.get(session_id)
        if session is None:
            implicit_session_id = self.build_implicit_session_id(self.entity.address, recipient)
            if session_id == implicit_session_id:
                return self._touch_implicit_session(recipient)
            raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")

        self._touch_session(session, recipient)
        self.entity.save()
        return session.session_id

    def _touch_implicit_session(self, recipient: FPAddress) -> str:
        """Refresh the hidden per-contact session used for continuous context."""
        session_id = self.build_implicit_session_id(self.entity.address, recipient)
        session = self.entity.sessions.get(session_id)
        if session is None:
            now = time.time()
            session = Session(
                session_id=session_id,
                participants=[recipient],
                kind=SessionKind.IMPLICIT,
                created_at=now,
                updated_at=now,
            )
            self.entity.sessions[session_id] = session
        else:
            self._touch_session(session, recipient)
        self.entity.save()
        return session_id

    @staticmethod
    def _touch_session(session: Session, recipient: FPAddress) -> None:
        """Update session membership and activity timestamp."""
        if not SessionService.session_matches_contact(session, recipient.entity_uid):
            session.participants.append(recipient)
        session.updated_at = time.time()

    def _replace_group_members(self, session: Session, members: dict[str, dict]) -> None:
        """Replace group membership metadata and active participants."""
        session.metadata["members"] = members
        session.participants = [
            FPAddress(address=address)
            for address, member in sorted(members.items())
            if member.get("status", GROUP_ACTIVE) == GROUP_ACTIVE
        ]
        session.updated_at = time.time()

    def _member_entry_from_entity(self, entity: Entity, role: str) -> dict:
        return self._member_entry(
            address=entity.address,
            name=entity.name,
            kind=entity.kind.value if hasattr(entity.kind, "value") else str(entity.kind),
            role=role,
        )

    def _member_entry_from_card(self, card: EntityCard, role: str) -> dict:
        return self._member_entry(
            address=card.address,
            name=card.name,
            kind=card.kind,
            role=role,
        )

    def _member_entry(
        self,
        *,
        address: FPAddress,
        name: str,
        kind: str,
        role: str,
    ) -> dict:
        if role not in GROUP_ROLES:
            raise HTTPException(status_code=400, detail=f"Invalid group role: {role}")
        permissions = self.role_permissions(role)
        return {
            "address": address.address,
            "entity_uid": address.entity_uid,
            "host_uid": address.host_uid,
            "name": name,
            "kind": kind,
            "role": role,
            "status": GROUP_ACTIVE,
            **permissions,
        }

    def _resolve_group_member(self, member_spec: str, role: str) -> dict:
        normalized = member_spec.strip()
        if not normalized:
            raise HTTPException(status_code=400, detail="Group member cannot be empty")

        if normalized in {self.entity.uid, self.entity.address.address}:
            return self._member_entry_from_entity(self.entity, GROUP_OWNER if role == GROUP_OWNER else role)

        if ":" in normalized:
            address = FPAddress(address=normalized)
            card = self.entity.friends.get(address.entity_uid)
            if card is None:
                raise HTTPException(
                    status_code=403,
                    detail=f"Group member must be a friend before invitation: {normalized}",
                )
            if card.address.address != address.address:
                raise HTTPException(
                    status_code=400,
                    detail=f"Friend address mismatch for member: {normalized}",
                )
            return self._member_entry_from_card(card, role)

        card = self.entity.friends.get(normalized)
        if card is not None:
            return self._member_entry_from_card(card, role)

        matches = [card for card in self.entity.friends.values() if card.name == normalized]
        if len(matches) == 1:
            return self._member_entry_from_card(matches[0], role)
        if len(matches) > 1:
            raise HTTPException(status_code=400, detail=f"Ambiguous group member name: {normalized}")

        raise HTTPException(
            status_code=403,
            detail=f"Group member must be a friend before invitation: {normalized}",
        )

    def _resolve_existing_group_member_address(self, session: Session, member_spec: str) -> str:
        """Resolve an existing group member spec to its FP address."""
        normalized = member_spec.strip()
        members = self.group_members(session)
        if normalized in members:
            return normalized

        uid = FPAddress(address=normalized).entity_uid if ":" in normalized else normalized
        uid_matches = [
            address
            for address, member in members.items()
            if member.get("entity_uid") == uid
        ]
        if len(uid_matches) == 1:
            return uid_matches[0]

        name_matches = [
            address
            for address, member in members.items()
            if member.get("name") == normalized
        ]
        if len(name_matches) == 1:
            return name_matches[0]
        if len(uid_matches) > 1 or len(name_matches) > 1:
            raise HTTPException(status_code=400, detail=f"Ambiguous group member: {normalized}")

        raise HTTPException(status_code=404, detail=f"Group member not found: {normalized}")

    def _get_self_group_member(self, session: Session) -> dict | None:
        return self.group_members(session).get(self.entity.address.address)

    def _self_is_active_group_member(self, session: Session) -> bool:
        member = self._get_self_group_member(session)
        return bool(member and member.get("status", GROUP_ACTIVE) == GROUP_ACTIVE)
