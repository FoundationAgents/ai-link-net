"""Tests for mail CLI command."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from aln.cli.mail import command as mail_command
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


class TestMail:
    """Test mail command."""

    @patch("fp.utils.storage.get_storage_manager")
    @patch("aln.cli.mail.HostClient")
    @patch("aln.cli.mail.resolve_entity_card")
    def test_send_mail_success(
        self,
        mock_resolve_entity_card,
        mock_host_client_cls,
        mock_get_storage,
        runner: CliRunner,
    ):
        """Test sending mail successfully."""
        from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
        to_card = _build_entity_card(name="bob", entity_uid="bob_uid", host_uid="host2")
        mock_resolve_entity_card.side_effect = [from_card, to_card]

        mock_storage = MagicMock()
        mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
        mock_get_storage.return_value = mock_storage

        mock_client = MagicMock()
        mock_client.send_message.return_value = {"message_id": "msg1"}
        mock_host_client_cls.return_value = mock_client

        message_json = '{"kind": "invoke", "payload": {"text": "Hello"}}'
        result = runner.invoke(
            mail_command,
            [
                "--entity",
                "host1:alice",
                "--to",
                "host2:bob",
                "-m",
                message_json,
            ],
        )

        assert result.exit_code == 0
        mock_client.send_message.assert_called_once_with(
            from_entity="alice_uid",
            to_address="host2:bob_uid",
            text="Hello",
        )

    @patch("fp.utils.storage.get_storage_manager")
    @patch("aln.cli.mail.HostClient")
    @patch("aln.cli.mail.resolve_entity_card")
    def test_send_mail_invalid_json(
        self,
        mock_resolve_entity_card,
        mock_host_client_cls,
        mock_get_storage,
        runner: CliRunner,
    ):
        """Test sending mail with invalid JSON."""
        from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
        to_card = _build_entity_card(name="bob", entity_uid="bob_uid", host_uid="host2")
        mock_resolve_entity_card.side_effect = [from_card, to_card]
        mock_storage = MagicMock()
        mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
        mock_get_storage.return_value = mock_storage
        mock_host_client_cls.return_value = MagicMock()

        result = runner.invoke(
            mail_command,
            [
                "--entity",
                "host1:alice",
                "--to",
                "host2:bob",
                "-m",
                "not valid json",
            ],
        )

        assert result.exit_code == 1
        assert "Invalid JSON" in result.output

    @patch("fp.utils.storage.get_storage_manager")
    @patch("aln.cli.mail.HostClient")
    @patch("aln.cli.mail.resolve_entity_card")
    def test_send_mail_non_dict_message(
        self,
        mock_resolve_entity_card,
        mock_host_client_cls,
        mock_get_storage,
        runner: CliRunner,
    ):
        """Test sending mail with non-dict message."""
        from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
        to_card = _build_entity_card(name="bob", entity_uid="bob_uid", host_uid="host2")
        mock_resolve_entity_card.side_effect = [from_card, to_card]
        mock_storage = MagicMock()
        mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
        mock_get_storage.return_value = mock_storage
        mock_host_client_cls.return_value = MagicMock()

        result = runner.invoke(
            mail_command,
            [
                "--entity",
                "host1:alice",
                "--to",
                "host2:bob",
                "-m",
                '"just a string"',
            ],
        )

        assert result.exit_code == 1
        assert "must be a JSON object" in result.output

    @patch("fp.utils.storage.get_storage_manager")
    @patch("aln.cli.mail.HostClient")
    @patch("aln.cli.mail.resolve_entity_card")
    def test_send_mail_with_invoke_message(
        self,
        mock_resolve_entity_card,
        mock_host_client_cls,
        mock_get_storage,
        runner: CliRunner,
    ):
        """Test sending mail with invoke message."""
        from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
        to_card = _build_entity_card(name="bob", entity_uid="bob_uid", host_uid="host2")
        mock_resolve_entity_card.side_effect = [from_card, to_card]

        mock_storage = MagicMock()
        mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
        mock_get_storage.return_value = mock_storage

        mock_client = MagicMock()
        mock_client.send_message.return_value = {"message_id": "msg2"}
        mock_host_client_cls.return_value = mock_client

        message_json = '{"kind": "invoke", "payload": {"tool": "search", "params": {"query": "test"}, "text": "hello"}}'
        result = runner.invoke(
            mail_command,
            [
                "--entity",
                "host1:alice",
                "--to",
                "host2:bob",
                "-m",
                message_json,
            ],
        )

        assert result.exit_code == 0
        mock_client.send_message.assert_called_once()

    @patch("fp.utils.storage.get_storage_manager")
    @patch("aln.cli.mail.HostClient")
    @patch("aln.cli.mail.resolve_entity_card")
    def test_send_mail_passes_session_id(
        self,
        mock_resolve_entity_card,
        mock_host_client_cls,
        mock_get_storage,
        runner: CliRunner,
    ):
        """Test sending mail preserves session_id from payload JSON."""
        from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
        to_card = _build_entity_card(name="bob", entity_uid="bob_uid", host_uid="host2")
        mock_resolve_entity_card.side_effect = [from_card, to_card]

        mock_storage = MagicMock()
        mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
        mock_get_storage.return_value = mock_storage

        mock_client = MagicMock()
        mock_client.send_message.return_value = {"message_id": "msg3"}
        mock_host_client_cls.return_value = mock_client

        message_json = '{"payload": {"text": "Hello", "session_id": "sess-123"}}'
        result = runner.invoke(
            mail_command,
            [
                "--entity",
                "host1:alice",
                "--to",
                "host2:bob",
                "-m",
                message_json,
            ],
        )

        assert result.exit_code == 0
        mock_client.send_message.assert_called_once_with(
            from_entity="alice_uid",
            to_address="host2:bob_uid",
            text="Hello",
            session_id="sess-123",
        )

    @patch("fp.utils.storage.get_storage_manager")
    @patch("aln.cli.mail.HostClient")
    @patch("aln.cli.mail.resolve_entity_card")
    def test_send_mail_with_plain_text_and_session_id(
        self,
        mock_resolve_entity_card,
        mock_host_client_cls,
        mock_get_storage,
        runner: CliRunner,
    ):
        """Plain text input should avoid JSON shell escaping."""
        from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
        to_card = _build_entity_card(name="bob", entity_uid="bob_uid", host_uid="host2")
        mock_resolve_entity_card.side_effect = [from_card, to_card]

        mock_storage = MagicMock()
        mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
        mock_get_storage.return_value = mock_storage

        mock_client = MagicMock()
        mock_client.send_message.return_value = {"message_id": "msg4"}
        mock_host_client_cls.return_value = mock_client

        result = runner.invoke(
            mail_command,
            [
                "--entity",
                "host1:alice",
                "--to",
                "host2:bob",
                "--session-id",
                "sess-456",
                "--text",
                "Hello without JSON",
            ],
        )

        assert result.exit_code == 0
        mock_client.send_message.assert_called_once_with(
            from_entity="alice_uid",
            to_address="host2:bob_uid",
            text="Hello without JSON",
            session_id="sess-456",
        )

    @patch("fp.utils.storage.get_storage_manager")
    @patch("aln.cli.mail.HostClient")
    @patch("aln.cli.mail.resolve_entity_card")
    def test_send_mail_reads_plain_text_from_stdin(
        self,
        mock_resolve_entity_card,
        mock_host_client_cls,
        mock_get_storage,
        runner: CliRunner,
    ):
        """Stdin text supports robust multi-line replies."""
        from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
        to_card = _build_entity_card(name="bob", entity_uid="bob_uid", host_uid="host2")
        mock_resolve_entity_card.side_effect = [from_card, to_card]

        mock_storage = MagicMock()
        mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
        mock_get_storage.return_value = mock_storage

        mock_client = MagicMock()
        mock_client.send_message.return_value = {"message_id": "msg5"}
        mock_host_client_cls.return_value = mock_client

        result = runner.invoke(
            mail_command,
            [
                "--entity",
                "host1:alice",
                "--to",
                "host2:bob",
                "--text-stdin",
            ],
            input="Line 1\nLine 2\n",
        )

        assert result.exit_code == 0
        mock_client.send_message.assert_called_once_with(
            from_entity="alice_uid",
            to_address="host2:bob_uid",
            text="Line 1\nLine 2",
        )

    @patch("fp.utils.storage.get_storage_manager")
    @patch("aln.cli.mail.HostClient")
    @patch("aln.cli.mail.resolve_entity_card")
    def test_send_mail_reads_unicode_plain_text_from_env(
        self,
        mock_resolve_entity_card,
        mock_host_client_cls,
        mock_get_storage,
        runner: CliRunner,
    ):
        """Environment text preserves Unicode on Windows."""
        from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
        to_card = _build_entity_card(name="bob", entity_uid="bob_uid", host_uid="host2")
        mock_resolve_entity_card.side_effect = [from_card, to_card]

        mock_storage = MagicMock()
        mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
        mock_get_storage.return_value = mock_storage

        mock_client = MagicMock()
        mock_client.send_message.return_value = {"message_id": "msg6"}
        mock_host_client_cls.return_value = mock_client

        result = runner.invoke(
            mail_command,
            [
                "--entity",
                "host1:alice",
                "--to",
                "host2:bob",
                "--text-env",
                "ALN_MESSAGE",
            ],
            env={"ALN_MESSAGE": "中文多行\n第二行"},
        )

        assert result.exit_code == 0
        mock_client.send_message.assert_called_once_with(
            from_entity="alice_uid",
            to_address="host2:bob_uid",
            text="中文多行\n第二行",
        )

    @patch("fp.utils.storage.get_storage_manager")
    @patch("aln.cli.mail.HostClient")
    @patch("aln.cli.mail.resolve_entity_card")
    def test_send_mail_invalid_message_format(
        self,
        mock_resolve_entity_card,
        mock_host_client_cls,
        mock_get_storage,
        runner: CliRunner,
    ):
        """Test sending mail with payload missing text."""
        from_card = _build_entity_card(name="alice", entity_uid="alice_uid", host_uid="host1")
        to_card = _build_entity_card(name="bob", entity_uid="bob_uid", host_uid="host2")
        mock_resolve_entity_card.side_effect = [from_card, to_card]
        mock_storage = MagicMock()
        mock_storage.get_host_url.return_value = "http://0.0.0.0:7001"
        mock_get_storage.return_value = mock_storage
        mock_host_client_cls.return_value = MagicMock()

        message_json = '{"invalid": "field"}'
        result = runner.invoke(
            mail_command,
            [
                "--entity",
                "host1:alice",
                "--to",
                "host2:bob",
                "-m",
                message_json,
            ],
        )

        assert result.exit_code == 1
        assert "must contain \"text\"" in result.output
