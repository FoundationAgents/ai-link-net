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
