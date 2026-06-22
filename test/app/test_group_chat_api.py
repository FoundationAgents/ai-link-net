"""Group chat API regression tests."""

from __future__ import annotations

import asyncio
from pathlib import Path

from aln.app.api.v1.messages import (
    SendGroupMessageRequest,
    get_messages,
    send_group_message,
)
from aln.app.api.v1.sessions import (
    AddGroupMembersRequest,
    CreateGroupSessionRequest,
    RemoveGroupMemberRequest,
    add_group_members,
    create_group_session,
    delete_group_session,
    list_group_sessions,
    remove_group_member,
)
from fp import Entity, EntityKind, Host
from fp.mailbox import Mailbox


def _create_group_members() -> tuple[Host, Entity, Entity, Entity]:
    """Create three local entities with full-mesh friendship."""
    host = Host(name="GroupHub")
    alice = host.register_entity(name="Alice", kind=EntityKind.HUMAN)
    bob = host.register_entity(name="Bob", kind=EntityKind.AGENT)
    carol = host.register_entity(name="Carol", kind=EntityKind.AGENT)

    for entity in (alice, bob, carol):
        for friend in (alice, bob, carol):
            if entity.uid != friend.uid:
                entity.add_friend(friend.entity_card)
        entity.save()

    return host, alice, bob, carol


def _create_invited_group_members() -> tuple[Host, Entity, Entity, Entity]:
    """Create a creator who is friends with invitees before they meet each other."""
    host = Host(name="GroupHub")
    alice = host.register_entity(name="Alice", kind=EntityKind.HUMAN)
    bob = host.register_entity(name="Bob", kind=EntityKind.AGENT)
    carol = host.register_entity(name="Carol", kind=EntityKind.AGENT)

    alice.add_friend(bob.entity_card)
    alice.add_friend(carol.entity_card)
    bob.add_friend(alice.entity_card)
    carol.add_friend(alice.entity_card)
    for entity in (alice, bob, carol):
        entity.save()

    return host, alice, bob, carol


def test_create_group_session_syncs_local_members() -> None:
    """Creating a group should persist a copy for every local active member."""

    async def run() -> tuple[str, list[str], bool, str]:
        host, alice, bob, carol = _create_group_members()
        response = await create_group_session(
            alice.uid,
            CreateGroupSessionRequest(
                name="Launch Room",
                members=[bob.uid, carol.uid],
                member_roles={carol.uid: "admin"},
            ),
            target_entity=alice,
            current_host=host,
        )
        assert response.data is not None

        listed = await list_group_sessions(alice.uid, target_entity=alice)
        assert listed.data is not None
        return (
            response.data.session_id,
            [session.session_id for session in listed.data],
            response.data.session_id in bob.sessions,
            carol.sessions[response.data.session_id].metadata["members"][
                carol.address.address
            ]["role"],
        )

    session_id, listed_ids, bob_has_copy, carol_role = asyncio.run(run())
    assert session_id in listed_ids
    assert bob_has_copy is True
    assert carol_role == "admin"


def test_create_group_session_auto_friends_local_members_for_replies() -> None:
    """Local group members should be able to route later group replies."""

    async def run() -> tuple[bool, bool, dict]:
        host, alice, bob, carol = _create_invited_group_members()
        created = await create_group_session(
            alice.uid,
            CreateGroupSessionRequest(
                name="Launch Room",
                members=[bob.uid, carol.uid],
            ),
            target_entity=alice,
            current_host=host,
        )
        assert created.data is not None

        sent = await send_group_message(
            SendGroupMessageRequest(
                from_entity=bob.uid,
                session_id=created.data.session_id,
                text="I can now reply to the group.",
            ),
            current_host=host,
        )
        assert sent.data is not None
        return carol.uid in bob.friends, bob.uid in carol.friends, sent.data

    bob_has_carol, carol_has_bob, sent = asyncio.run(run())
    assert bob_has_carol is True
    assert carol_has_bob is True
    assert sent["recipient_count"] == 2


def test_group_send_repairs_existing_local_member_friendships() -> None:
    """Existing groups created before auto-friend logic should heal on send."""

    async def run() -> tuple[bool, bool, dict]:
        host, alice, bob, carol = _create_invited_group_members()
        created = await create_group_session(
            alice.uid,
            CreateGroupSessionRequest(
                name="Legacy Room",
                members=[bob.uid, carol.uid],
            ),
            target_entity=alice,
            current_host=host,
        )
        assert created.data is not None

        bob.remove_friend(carol.uid)
        carol.remove_friend(bob.uid)
        bob.save()
        carol.save()

        sent = await send_group_message(
            SendGroupMessageRequest(
                from_entity=bob.uid,
                session_id=created.data.session_id,
                text="Legacy group reply still works.",
            ),
            current_host=host,
        )
        assert sent.data is not None
        return carol.uid in bob.friends, bob.uid in carol.friends, sent.data

    bob_has_carol, carol_has_bob, sent = asyncio.run(run())
    assert bob_has_carol is True
    assert carol_has_bob is True
    assert sent["recipient_count"] == 2


def test_group_message_broadcasts_to_active_members_and_formats_history() -> None:
    """A group send should create one outbound mail and one inbound mail per peer."""

    async def run() -> tuple[dict, list[dict], list[dict], list[dict]]:
        host, alice, bob, carol = _create_group_members()
        created = await create_group_session(
            alice.uid,
            CreateGroupSessionRequest(
                name="Launch Room",
                members=[bob.uid, carol.uid],
            ),
            target_entity=alice,
            current_host=host,
        )
        assert created.data is not None

        sent = await send_group_message(
            SendGroupMessageRequest(
                from_entity=alice.uid,
                session_id=created.data.session_id,
                text="Please compare launch plans.",
            ),
            current_host=host,
        )
        assert sent.data is not None
        await asyncio.sleep(0.2)

        alice_mails = Mailbox(alice.uid, Path(alice.mailbox_path)).list_mails()
        bob_history = await get_messages(bob.uid, current_host=host, limit=100)
        carol_history = await get_messages(carol.uid, current_host=host, limit=100)
        assert bob_history.data is not None
        assert carol_history.data is not None
        return sent.data, alice_mails, bob_history.data, carol_history.data

    sent, alice_mails, bob_messages, carol_messages = asyncio.run(run())
    assert sent["recipient_count"] == 2

    outbound = [
        entry
        for entry in alice_mails
        if entry.get("metadata", {}).get("direction") == "outbound"
        and entry.get("mail", {}).get("mail_id") == sent["mail_id"]
    ]
    assert len(outbound) == 1
    assert len(outbound[0]["mail"]["recipient"]) == 2

    for history in (bob_messages, carol_messages):
        group_messages = [
            message
            for message in history
            if message["mail_id"] == sent["mail_id"]
        ]
        assert len(group_messages) == 1
        message = group_messages[0]
        assert message["conversation_type"] == "group"
        assert message["group_id"] == sent["session_id"]
        assert message["payload"]["text"] == "Please compare launch plans."


def test_observer_cannot_send_group_message() -> None:
    """Observer role is visible in a group but cannot publish to it."""

    async def run() -> None:
        host, alice, bob, carol = _create_group_members()
        created = await create_group_session(
            alice.uid,
            CreateGroupSessionRequest(
                name="Observer Room",
                members=[bob.uid, carol.uid],
                member_roles={bob.uid: "observer"},
            ),
            target_entity=alice,
            current_host=host,
        )
        assert created.data is not None

        response = await send_group_message(
            SendGroupMessageRequest(
                from_entity=bob.uid,
                session_id=created.data.session_id,
                text="I should not be able to send this.",
            ),
            current_host=host,
        )
        assert response.success is False
        assert response.data == {"error_code": 403}
        assert "permission" in response.message

    asyncio.run(run())


def test_group_members_can_be_added_and_synced() -> None:
    """Inviting a new local member should create its group session copy."""

    async def run() -> tuple[int, bool, bool]:
        host, alice, bob, carol = _create_group_members()
        created = await create_group_session(
            alice.uid,
            CreateGroupSessionRequest(
                name="Hiring Room",
                members=[bob.uid],
            ),
            target_entity=alice,
            current_host=host,
        )
        assert created.data is not None

        updated = await add_group_members(
            alice.uid,
            created.data.session_id,
            AddGroupMembersRequest(members=[carol.uid]),
            target_entity=alice,
            current_host=host,
        )
        assert updated.data is not None

        return (
            len(updated.data.members),
            created.data.session_id in carol.sessions,
            carol.uid in bob.friends,
        )

    member_count, carol_has_copy, bob_has_carol = asyncio.run(run())
    assert member_count == 3
    assert carol_has_copy is True
    assert bob_has_carol is True


def test_group_member_can_be_removed_from_future_broadcasts() -> None:
    """Removing a member should hide its local room and exclude it from sends."""

    async def run() -> tuple[str, bool, int, str, str]:
        host, alice, bob, carol = _create_group_members()
        created = await create_group_session(
            alice.uid,
            CreateGroupSessionRequest(
                name="Review Room",
                members=[bob.uid, carol.uid],
            ),
            target_entity=alice,
            current_host=host,
        )
        assert created.data is not None

        removed = await remove_group_member(
            alice.uid,
            created.data.session_id,
            RemoveGroupMemberRequest(member=carol.uid),
            target_entity=alice,
            current_host=host,
        )
        assert removed.data is not None

        sent = await send_group_message(
            SendGroupMessageRequest(
                from_entity=alice.uid,
                session_id=created.data.session_id,
                text="Only Bob should receive this.",
            ),
            current_host=host,
        )
        assert sent.data is not None
        carol_status = next(
            member.status
            for member in removed.data.members
            if member.entity_uid == carol.uid
        )
        return (
            carol_status,
            created.data.session_id in carol.sessions,
            sent.data["recipient_count"],
            sent.data["recipients"][0]["entity_uid"],
            bob.uid,
        )

    carol_status, carol_has_copy, recipient_count, recipient_uid, bob_uid = asyncio.run(run())
    assert carol_status == "removed"
    assert carol_has_copy is False
    assert recipient_count == 1
    assert recipient_uid == bob_uid


def test_group_session_can_be_deleted_from_local_members() -> None:
    """Deleting a room should remove local session copies for every known member."""

    async def run() -> tuple[bool, bool, bool]:
        host, alice, bob, carol = _create_group_members()
        created = await create_group_session(
            alice.uid,
            CreateGroupSessionRequest(
                name="Disposable Room",
                members=[bob.uid, carol.uid],
            ),
            target_entity=alice,
            current_host=host,
        )
        assert created.data is not None

        deleted = await delete_group_session(
            alice.uid,
            created.data.session_id,
            target_entity=alice,
            current_host=host,
        )
        assert deleted.success is True

        return (
            created.data.session_id in alice.sessions,
            created.data.session_id in bob.sessions,
            created.data.session_id in carol.sessions,
        )

    alice_has_copy, bob_has_copy, carol_has_copy = asyncio.run(run())
    assert alice_has_copy is False
    assert bob_has_copy is False
    assert carol_has_copy is False
