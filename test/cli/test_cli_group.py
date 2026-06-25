"""Tests for group chat CLI commands."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from aln.app import HostClientError
from aln.cli.group import command as group_command
from fp import EntityCard, FPAddress


@pytest.fixture
def runner() -> CliRunner:
    """Create CLI test runner."""
    return CliRunner()


def _build_entity_card(
    *,
    name: str,
    entity_uid: str,
    host_uid: str,
) -> EntityCard:
    """Build one entity card for test stubs."""
    return EntityCard(
        name=name,
        address=FPAddress(address=f"{host_uid}:{entity_uid}"),
        kind="agent",
        sign_public_key="key",
        encrypt_public_key="key",
        description="",
        is_public=True,
        entity_uid=entity_uid,
        host_uid=host_uid,
    )


@patch("fp.utils.storage.get_storage_manager")
@patch("aln.cli.group.HostClient")
@patch("aln.cli.group.resolve_entity_card")
def test_group_create_calls_host_client(
    mock_resolve_entity_card,
    mock_host_client_cls,
    mock_get_storage,
    runner: CliRunner,
) -> None:
    """`aln group create` should call the group session API."""
    from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
    mock_resolve_entity_card.return_value = from_card

    mock_storage = MagicMock()
    mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
    mock_get_storage.return_value = mock_storage

    mock_client = MagicMock()
    mock_client.create_group_session.return_value = {
        "session_id": "group:abc123",
        "name": "Launch Room",
        "members": [{}, {}],
    }
    mock_host_client_cls.return_value = mock_client

    result = runner.invoke(
        group_command,
        [
            "create",
            "-e",
            "host1:alice",
            "-n",
            "Launch Room",
            "--member",
            "bob_uid",
            "--member",
            "carol_uid",
        ],
    )

    assert result.exit_code == 0
    mock_client.create_group_session.assert_called_once_with(
        entity_uid="alice_uid",
        name="Launch Room",
        members=["bob_uid", "carol_uid"],
    )


@patch("fp.utils.storage.get_storage_manager")
@patch("aln.cli.group.HostClient")
@patch("aln.cli.group.resolve_entity_card")
def test_group_send_calls_host_client(
    mock_resolve_entity_card,
    mock_host_client_cls,
    mock_get_storage,
    runner: CliRunner,
) -> None:
    """`aln group send` should call the group message API."""
    from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
    mock_resolve_entity_card.return_value = from_card

    mock_storage = MagicMock()
    mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
    mock_get_storage.return_value = mock_storage

    mock_client = MagicMock()
    mock_client.send_group_message.return_value = {
        "message_id": "msg1",
        "recipient_count": 2,
    }
    mock_host_client_cls.return_value = mock_client

    result = runner.invoke(
        group_command,
        [
            "send",
            "-e",
            "host1:alice",
            "--session",
            "group:abc123",
            "-m",
            '{"text":"hello group"}',
        ],
    )

    assert result.exit_code == 0
    mock_client.send_group_message.assert_called_once_with(
        from_entity="alice_uid",
        session_id="group:abc123",
        text="hello group",
    )


@patch("fp.utils.storage.get_storage_manager")
@patch("aln.cli.group.HostClient")
@patch("aln.cli.group.resolve_entity_card")
def test_group_send_accepts_plain_text(
    mock_resolve_entity_card,
    mock_host_client_cls,
    mock_get_storage,
    runner: CliRunner,
) -> None:
    """`aln group send --text` should avoid JSON quoting issues."""
    from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
    mock_resolve_entity_card.return_value = from_card

    mock_storage = MagicMock()
    mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
    mock_get_storage.return_value = mock_storage

    mock_client = MagicMock()
    mock_client.send_group_message.return_value = {
        "message_id": "msg1",
        "recipient_count": 2,
    }
    mock_host_client_cls.return_value = mock_client

    result = runner.invoke(
        group_command,
        [
            "send",
            "-e",
            "host1:alice",
            "--session",
            "group:abc123",
            "--text",
            "hello group",
        ],
    )

    assert result.exit_code == 0
    mock_client.send_group_message.assert_called_once_with(
        from_entity="alice_uid",
        session_id="group:abc123",
        text="hello group",
    )


@patch("fp.utils.storage.get_storage_manager")
@patch("aln.cli.group.HostClient")
@patch("aln.cli.group.resolve_entity_card")
def test_group_send_accepts_unicode_text_env(
    mock_resolve_entity_card,
    mock_host_client_cls,
    mock_get_storage,
    runner: CliRunner,
) -> None:
    """`aln group send --text-env` should preserve Unicode text."""
    from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
    mock_resolve_entity_card.return_value = from_card

    mock_storage = MagicMock()
    mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
    mock_get_storage.return_value = mock_storage

    mock_client = MagicMock()
    mock_client.send_group_message.return_value = {
        "message_id": "msg1",
        "recipient_count": 2,
    }
    mock_host_client_cls.return_value = mock_client

    result = runner.invoke(
        group_command,
        [
            "send",
            "-e",
            "host1:alice",
            "--session",
            "group:abc123",
            "--text-env",
            "ALN_MESSAGE",
        ],
        env={"ALN_MESSAGE": "中文群聊\n第二行"},
    )

    assert result.exit_code == 0
    mock_client.send_group_message.assert_called_once_with(
        from_entity="alice_uid",
        session_id="group:abc123",
        text="中文群聊\n第二行",
    )


@patch("fp.utils.storage.get_storage_manager")
@patch("aln.cli.group.HostClient")
@patch("aln.cli.group.resolve_entity_card")
def test_group_send_reports_host_client_error(
    mock_resolve_entity_card,
    mock_host_client_cls,
    mock_get_storage,
    runner: CliRunner,
) -> None:
    """Group send should surface backend authorization failures."""
    from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
    mock_resolve_entity_card.return_value = from_card

    mock_storage = MagicMock()
    mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
    mock_get_storage.return_value = mock_storage

    mock_client = MagicMock()
    mock_client.send_group_message.side_effect = HostClientError("sender is not a friend")
    mock_host_client_cls.return_value = mock_client

    result = runner.invoke(
        group_command,
        [
            "send",
            "-e",
            "host1:alice",
            "--session",
            "group:abc123",
            "--text",
            "hello group",
        ],
    )

    assert result.exit_code == 1
    assert "sender is not a friend" in result.output


def test_group_send_rejects_invalid_json(runner: CliRunner) -> None:
    """Invalid message JSON should fail before resolving entities."""
    result = runner.invoke(
        group_command,
        [
            "send",
            "-e",
            "host1:alice",
            "--session",
            "group:abc123",
            "-m",
            "not-json",
        ],
    )

    assert result.exit_code == 1
    assert "Invalid JSON message" in result.output


@patch("fp.utils.storage.get_storage_manager")
@patch("aln.cli.group.HostClient")
@patch("aln.cli.group.resolve_entity_card")
def test_group_history_calls_host_client(
    mock_resolve_entity_card,
    mock_host_client_cls,
    mock_get_storage,
    runner: CliRunner,
) -> None:
    """`aln group history` should query one group session mailbox view."""
    from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
    mock_resolve_entity_card.return_value = from_card

    mock_storage = MagicMock()
    mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
    mock_get_storage.return_value = mock_storage

    mock_client = MagicMock()
    mock_client.get_group_history.return_value = [
        {
            "timestamp": "2026-06-24T12:00:00",
            "direction": "inbound",
            "sender": "host1:bob_uid",
            "payload": {"text": "hello group"},
        }
    ]
    mock_host_client_cls.return_value = mock_client

    result = runner.invoke(
        group_command,
        [
            "history",
            "-e",
            "host1:alice",
            "--session",
            "group:abc123",
            "--limit",
            "10",
        ],
    )

    assert result.exit_code == 0
    assert "hello group" in result.output
    mock_client.get_group_history.assert_called_once_with(
        entity_uid="alice_uid",
        session_id="group:abc123",
        limit=10,
    )


@patch("fp.utils.storage.get_storage_manager")
@patch("aln.cli.group.HostClient")
@patch("aln.cli.group.resolve_entity_card")
def test_group_invite_calls_host_client(
    mock_resolve_entity_card,
    mock_host_client_cls,
    mock_get_storage,
    runner: CliRunner,
) -> None:
    """`aln group invite` should call the group membership API."""
    from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
    mock_resolve_entity_card.return_value = from_card

    mock_storage = MagicMock()
    mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
    mock_get_storage.return_value = mock_storage

    mock_client = MagicMock()
    mock_client.add_group_members.return_value = {"session_id": "group:abc123", "members": [{}, {}, {}]}
    mock_host_client_cls.return_value = mock_client

    result = runner.invoke(
        group_command,
        [
            "invite",
            "-e",
            "host1:alice",
            "--session",
            "group:abc123",
            "--member",
            "bob_uid",
            "--member",
            "carol_uid",
        ],
    )

    assert result.exit_code == 0
    mock_client.add_group_members.assert_called_once_with(
        entity_uid="alice_uid",
        session_id="group:abc123",
        members=["bob_uid", "carol_uid"],
    )


@patch("fp.utils.storage.get_storage_manager")
@patch("aln.cli.group.HostClient")
@patch("aln.cli.group.resolve_entity_card")
def test_group_remove_calls_host_client(
    mock_resolve_entity_card,
    mock_host_client_cls,
    mock_get_storage,
    runner: CliRunner,
) -> None:
    """`aln group remove` should remove one member through the API."""
    from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
    mock_resolve_entity_card.return_value = from_card

    mock_storage = MagicMock()
    mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
    mock_get_storage.return_value = mock_storage

    mock_client = MagicMock()
    mock_client.remove_group_member.return_value = {"session_id": "group:abc123", "members": [{}, {}]}
    mock_host_client_cls.return_value = mock_client

    result = runner.invoke(
        group_command,
        [
            "remove",
            "-e",
            "host1:alice",
            "--session",
            "group:abc123",
            "--member",
            "bob_uid",
        ],
    )

    assert result.exit_code == 0
    mock_client.remove_group_member.assert_called_once_with(
        entity_uid="alice_uid",
        session_id="group:abc123",
        member="bob_uid",
    )


@patch("fp.utils.storage.get_storage_manager")
@patch("aln.cli.group.HostClient")
@patch("aln.cli.group.resolve_entity_card")
def test_group_stop_calls_host_client(
    mock_resolve_entity_card,
    mock_host_client_cls,
    mock_get_storage,
    runner: CliRunner,
) -> None:
    """`aln group stop` should stop the room without deleting it."""
    from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
    mock_resolve_entity_card.return_value = from_card

    mock_storage = MagicMock()
    mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
    mock_get_storage.return_value = mock_storage

    mock_client = MagicMock()
    mock_client.stop_group_session.return_value = {"session_id": "group:abc123", "status": "stopped"}
    mock_host_client_cls.return_value = mock_client

    result = runner.invoke(
        group_command,
        [
            "stop",
            "-e",
            "host1:alice",
            "--session",
            "group:abc123",
        ],
    )

    assert result.exit_code == 0
    assert "stopped" in result.output
    mock_client.stop_group_session.assert_called_once_with(
        entity_uid="alice_uid",
        session_id="group:abc123",
    )


@patch("fp.utils.storage.get_storage_manager")
@patch("aln.cli.group.HostClient")
@patch("aln.cli.group.resolve_entity_card")
def test_group_resume_calls_host_client(
    mock_resolve_entity_card,
    mock_host_client_cls,
    mock_get_storage,
    runner: CliRunner,
) -> None:
    """`aln group resume` should re-enable a stopped room."""
    from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
    mock_resolve_entity_card.return_value = from_card

    mock_storage = MagicMock()
    mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
    mock_get_storage.return_value = mock_storage

    mock_client = MagicMock()
    mock_client.resume_group_session.return_value = {"session_id": "group:abc123", "status": "active"}
    mock_host_client_cls.return_value = mock_client

    result = runner.invoke(
        group_command,
        [
            "resume",
            "-e",
            "host1:alice",
            "--session",
            "group:abc123",
        ],
    )

    assert result.exit_code == 0
    assert "active" in result.output
    mock_client.resume_group_session.assert_called_once_with(
        entity_uid="alice_uid",
        session_id="group:abc123",
    )
