"""`aln mail` command - Send text messages between entities."""

from __future__ import annotations

import click
from fp.utils import storage as fp_storage

from aln.app import HostClient

from .misc.message_input import MessageInputParser
from .misc.printer import CliPrinter
from .misc.wrappers import cli_exception_wrapper, get_cli_printer, resolve_entity_card


@click.command(
    name="mail",
    context_settings={"help_option_names": ["-h", "--help"]},
)
@click.option(
    "-e",
    "--entity",
    "from_entity_spec",
    required=True,
    help="Sender entity (host:entity or entity). Examples: 'Alice', 'default:Alice'",
)
@click.option(
    "--to",
    "to_address_spec",
    required=True,
    help="Recipient ADDRESS (use 'host:entity' or registered entity name, NOT arbitrary names). Examples: 'Bob' (if registered), 'default:Bob', 'test1:Alice'",
)
@click.option(
    "-m",
    "--message",
    "message_json",
    required=False,
    help='Message JSON (supports legacy format or simple {"text": "..."})',
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
@click.option(
    "--session-id",
    required=False,
    help="Conversation session id to preserve when replying.",
)
@cli_exception_wrapper(error_message="Failed to send mail")
@get_cli_printer
def command(
    from_entity_spec: str,
    to_address_spec: str,
    message_json: str | None,
    plain_text: str | None,
    text_stdin: bool,
    text_env: str | None,
    session_id: str | None,
    cli_printer: CliPrinter,
) -> None:
    """Send message — the ONLY way to reply to others and report to your owner.

    -e and --to take FP address: host_uid:entity_uid or entity_uid (default host).
    --to must be a valid entity address, use 'aln find' to discover entities first.

    Examples:

    \b
      # Send a text message (same host)
      aln mail -e bd19e57d --to 7d276024 -m '{"text": "Hello!"}'
      aln mail -e bd19e57d --to 7d276024 --text "Hello!"
      aln mail -e bd19e57d --to 7d276024 --text-env ALN_MESSAGE

    \b
      # Cross-host messaging
      aln mail -e 1ec0ed94:bd19e57d --to 12c9067b:a552e88d -m '{"text": "Hi!"}'

    \b
      # Discover first, then send
      aln find -e bd19e57d --name Coder
      aln mail -e bd19e57d --to a552e88d -m '{"text": "Write a sort algorithm"}'
    """
    # 解析发送方和接收方的 entity cards
    from_card = resolve_entity_card(from_entity_spec)
    to_card = resolve_entity_card(to_address_spec)

    # 创建发送方的 client
    storage = fp_storage.get_storage_manager()
    from_host_url = storage.get_host_url(from_card.host_uid)
    client = HostClient(base_url=from_host_url)

    # 使用 to_card 的完整地址
    to_address = to_card.address.address

    parsed = MessageInputParser().parse(
        message_json=message_json,
        text=plain_text,
        text_stdin=text_stdin,
        text_env=text_env,
        session_id=session_id,
    )

    # Use the new messages API endpoint
    send_kwargs = {
        "from_entity": from_card.entity_uid,
        "to_address": to_address,
        "text": parsed.text,
    }
    if parsed.session_id is not None:
        send_kwargs["session_id"] = parsed.session_id
    result = client.send_message(**send_kwargs)
    cli_printer.echo("Message sent successfully")
    cli_printer.echo(f"  Message ID: {result.get('message_id', 'N/A')}")
    cli_printer.echo(f"  From: {from_entity_spec}")
    cli_printer.echo(f"  To: {to_address_spec}")
