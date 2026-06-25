"""`aln group` command group for multi-entity group chat."""

from __future__ import annotations

import json

import click
from fp.utils import storage as fp_storage

from aln.app import HostClient

from .misc.message_input import MessageInputParser
from .misc.printer import CliPrinter
from .misc.wrappers import cli_exception_wrapper, get_cli_printer, resolve_entity_card


@click.group(
    name="group",
    invoke_without_command=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)
@click.pass_context
def command(ctx: click.Context) -> None:
    """Group chat commands for multi-agent collaboration.

    Examples:

      aln group create -e default:Alice -n "Launch room" --member default:Coder --member default:Reviewer
      aln group list -e default:Alice
      aln group send -e default:Alice --session group:abc123 --text "Please compare plans."
      aln group history -e default:Alice --session group:abc123
    """
    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


def _client_for_entity(entity_spec: str) -> tuple[HostClient, str]:
    """Resolve sender card and return a client bound to its host."""
    card = resolve_entity_card(entity_spec)
    storage = fp_storage.get_storage_manager()
    host_url = storage.get_host_url(card.host_uid)
    return HostClient(base_url=host_url), card.entity_uid


def _message_text(message: dict) -> str:
    """Extract display text from a formatted mailbox message."""
    payload = message.get("payload")
    if isinstance(payload, dict):
        text = payload.get("text")
        if isinstance(text, str):
            return text
        return json.dumps(payload, ensure_ascii=False)
    return ""


def _message_sender(message: dict) -> str:
    """Extract sender label from a formatted mailbox message."""
    sender = message.get("sender")
    return sender if isinstance(sender, str) and sender else "unknown"


@command.command("create", help="Create a group chat session.")
@click.option(
    "-e",
    "--entity",
    "entity_spec",
    required=True,
    help="Group creator entity (host:entity or entity uid).",
)
@click.option("-n", "--name", required=True, help="Group name.")
@click.option(
    "--member",
    "members",
    multiple=True,
    required=True,
    help="Friend uid, friend name, or full FP address. Repeat for multiple members.",
)
@cli_exception_wrapper(error_message="Failed to create group")
@get_cli_printer
def create_command(
    entity_spec: str,
    name: str,
    members: tuple[str, ...],
    cli_printer: CliPrinter,
) -> None:
    """Create a group chat session.

    Examples:
      aln group create -e 4e591b23 -n "Research room" --member 7d276024 --member 9a81beef
      aln group create -e host1:alice123 --member host2:bob456 -n "Cross-host room"
    """
    client, entity_uid = _client_for_entity(entity_spec)
    group = client.create_group_session(
        entity_uid=entity_uid,
        name=name,
        members=list(members),
    )
    cli_printer.echo("Group created successfully")
    cli_printer.echo(f"  Session: {group.get('session_id')}")
    cli_printer.echo(f"  Name: {group.get('name')}")
    cli_printer.echo(f"  Members: {len(group.get('members') or [])}")


@command.command("list", help="List group chat sessions.")
@click.option(
    "-e",
    "--entity",
    "entity_spec",
    required=True,
    help="Entity to query (host:entity or entity uid).",
)
@cli_exception_wrapper(error_message="Failed to list groups")
@get_cli_printer
def list_command(entity_spec: str, cli_printer: CliPrinter) -> None:
    """List group chat sessions.

    Examples:
      aln group list -e 4e591b23
      aln group list -e host1:alice123
    """
    client, entity_uid = _client_for_entity(entity_spec)
    groups = client.list_group_sessions(entity_uid)
    if not groups:
        cli_printer.echo("No group sessions found")
        return

    for group in groups:
        cli_printer.echo(f"{group.get('session_id')}  {group.get('name')}  status={group.get('status', 'active')}")
        for member in group.get("members") or []:
            cli_printer.echo(
                f"  - {member.get('name')} ({member.get('address')}) "
                f"role={member.get('role')} status={member.get('status')}"
            )


@command.command("send", help="Send a text message to a group chat session.")
@click.option(
    "-e",
    "--entity",
    "entity_spec",
    required=True,
    help="Sender entity (host:entity or entity uid).",
)
@click.option("--session", "session_id", required=True, help="Group session id.")
@click.option(
    "-m",
    "--message",
    "message_json",
    required=False,
    help='Message JSON object with "text", e.g. {"text":"hello"}',
)
@click.option(
    "-t",
    "--text",
    "plain_text",
    required=False,
    help="Plain text message. Prefer this on Windows to avoid JSON shell escaping.",
)
@click.option(
    "--text-stdin",
    is_flag=True,
    help="Read plain text message from stdin.",
)
@click.option(
    "--text-env",
    required=False,
    help="Read plain text message from an environment variable.",
)
@cli_exception_wrapper(error_message="Failed to send group message")
@get_cli_printer
def send_command(
    entity_spec: str,
    session_id: str,
    message_json: str | None,
    plain_text: str | None,
    text_stdin: bool,
    text_env: str | None,
    cli_printer: CliPrinter,
) -> None:
    """Send a text message to all active group members.

    Examples:
      aln group send -e 4e591b23 --session group:abc123 -m '{"text":"Start review"}'
      aln group send -e 4e591b23 --session group:abc123 --text "Start review"
      aln group send -e 4e591b23 --session group:abc123 --text-env ALN_MESSAGE
    """
    parsed = MessageInputParser().parse(
        message_json=message_json,
        text=plain_text,
        text_stdin=text_stdin,
        text_env=text_env,
    )

    client, entity_uid = _client_for_entity(entity_spec)
    result = client.send_group_message(
        from_entity=entity_uid,
        session_id=session_id,
        text=parsed.text,
    )
    cli_printer.echo("Group message sent successfully")
    cli_printer.echo(f"  Message ID: {result.get('message_id')}")
    cli_printer.echo(f"  Recipients: {result.get('recipient_count')}")


@command.command("history", help="Show group chat history.")
@click.option(
    "-e",
    "--entity",
    "entity_spec",
    required=True,
    help="Entity whose mailbox should be queried.",
)
@click.option("--session", "session_id", required=True, help="Group session id.")
@click.option("--limit", type=int, default=None, help="Maximum messages to show. Omit to show all history.")
@cli_exception_wrapper(error_message="Failed to get group history")
@get_cli_printer
def history_command(
    entity_spec: str,
    session_id: str,
    limit: int | None,
    cli_printer: CliPrinter,
) -> None:
    """Show messages for one group session."""
    client, entity_uid = _client_for_entity(entity_spec)
    messages = client.get_group_history(
        entity_uid=entity_uid,
        session_id=session_id,
        limit=limit,
    )

    if not messages:
        cli_printer.echo("No group messages found")
        return

    for message in messages:
        timestamp = message.get("timestamp") or "-"
        direction = message.get("direction") or "-"
        sender = _message_sender(message)
        text = _message_text(message)
        cli_printer.echo(f"[{timestamp}] {direction} {sender}")
        cli_printer.echo(text)
        cli_printer.echo("")


@command.command("invite", help="Invite friends into a group chat session.")
@click.option(
    "-e",
    "--entity",
    "entity_spec",
    required=True,
    help="Inviting entity (must have invite permission).",
)
@click.option("--session", "session_id", required=True, help="Group session id.")
@click.option(
    "--member",
    "members",
    multiple=True,
    required=True,
    help="Friend uid, friend name, or full FP address. Repeat for multiple members.",
)
@cli_exception_wrapper(error_message="Failed to invite group members")
@get_cli_printer
def invite_command(
    entity_spec: str,
    session_id: str,
    members: tuple[str, ...],
    cli_printer: CliPrinter,
) -> None:
    """Invite friends into an existing group session."""
    client, entity_uid = _client_for_entity(entity_spec)
    group = client.add_group_members(
        entity_uid=entity_uid,
        session_id=session_id,
        members=list(members),
    )
    cli_printer.echo("Group members invited successfully")
    cli_printer.echo(f"  Session: {group.get('session_id')}")
    cli_printer.echo(f"  Members: {len(group.get('members') or [])}")


@command.command("remove", help="Remove one member from a group chat session.")
@click.option(
    "-e",
    "--entity",
    "entity_spec",
    required=True,
    help="Removing entity (must have remove permission).",
)
@click.option("--session", "session_id", required=True, help="Group session id.")
@click.option("--member", "member", required=True, help="Member uid, name, or full FP address.")
@cli_exception_wrapper(error_message="Failed to remove group member")
@get_cli_printer
def remove_command(
    entity_spec: str,
    session_id: str,
    member: str,
    cli_printer: CliPrinter,
) -> None:
    """Remove one active member from an existing group session."""
    client, entity_uid = _client_for_entity(entity_spec)
    group = client.remove_group_member(
        entity_uid=entity_uid,
        session_id=session_id,
        member=member,
    )
    cli_printer.echo("Group member removed successfully")
    cli_printer.echo(f"  Session: {group.get('session_id')}")
    cli_printer.echo(f"  Members: {len(group.get('members') or [])}")


@command.command("stop", help="Stop a group chat session.")
@click.option(
    "-e",
    "--entity",
    "entity_spec",
    required=True,
    help="Entity with group remove/admin permission.",
)
@click.option("--session", "session_id", required=True, help="Group session id.")
@cli_exception_wrapper(error_message="Failed to stop group")
@get_cli_printer
def stop_command(
    entity_spec: str,
    session_id: str,
    cli_printer: CliPrinter,
) -> None:
    """Stop a group session without deleting its history."""
    client, entity_uid = _client_for_entity(entity_spec)
    group = client.stop_group_session(entity_uid=entity_uid, session_id=session_id)
    cli_printer.echo("Group stopped successfully")
    cli_printer.echo(f"  Session: {group.get('session_id')}")
    cli_printer.echo(f"  Status: {group.get('status')}")


@command.command("resume", help="Resume a stopped group chat session.")
@click.option(
    "-e",
    "--entity",
    "entity_spec",
    required=True,
    help="Entity with group remove/admin permission.",
)
@click.option("--session", "session_id", required=True, help="Group session id.")
@cli_exception_wrapper(error_message="Failed to resume group")
@get_cli_printer
def resume_command(
    entity_spec: str,
    session_id: str,
    cli_printer: CliPrinter,
) -> None:
    """Resume a stopped group session."""
    client, entity_uid = _client_for_entity(entity_spec)
    group = client.resume_group_session(entity_uid=entity_uid, session_id=session_id)
    cli_printer.echo("Group resumed successfully")
    cli_printer.echo(f"  Session: {group.get('session_id')}")
    cli_printer.echo(f"  Status: {group.get('status')}")
