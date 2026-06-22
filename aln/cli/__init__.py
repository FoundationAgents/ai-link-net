"""Top-level FP CLI."""

from __future__ import annotations

import sys
from importlib.metadata import PackageNotFoundError, version

import click

from .entity import command as entity_command
from .find import command as find_command
from .friend import command as friend_command
from .group import command as group_command
from .host import command as host_command
from .init import command as init_command
from .contract import command as contract_command
from .mail import command as mail_command
from .mailbox import command as mailbox_command
from .market import command as market_command
from .misc.clistyle import CLIStyle
from .pay import command as pay_command
from .reset import command as reset_command
from .status import command as health_command
from .ui import command as ui_command
from .update import command as update_command
from .update_check import check_for_update, format_update_notice


def _resolve_version() -> str:
    try:
        return version("ai-link-net")
    except PackageNotFoundError:
        return "0.1.0"


@click.group(
    name="aln",
    cls=CLIStyle,
    invoke_without_command=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)
@click.option(
    "--host",
    "host_name",
    default="default",
    show_default=True,
    help="Host name to operate on",
)
@click.option(
    "--entity-name",
    help="Entity name filter",
)
@click.option(
    "-v",
    "--verbose",
    count=True,
    help="Increase verbosity (-v, -vv, -vvv)",
)
@click.option(
    "-q",
    "--quiet",
    is_flag=True,
    help="Suppress non-error output",
)
@click.version_option(version=_resolve_version(), prog_name="aln")
@click.pass_context
def cli(
    ctx: click.Context,
    host_name: str,
    entity_name: str | None,
    verbose: int,
    quiet: bool,
) -> None:
    """An extremely fast peer-to-peer communication system."""
    # Store global options in context for subcommands to use
    ctx.ensure_object(dict)
    ctx.obj["host_name"] = host_name
    ctx.obj["entity_name"] = entity_name
    ctx.obj["verbose"] = verbose
    ctx.obj["quiet"] = quiet

    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


for command in (
    init_command,
    host_command,
    entity_command,
    find_command,
    friend_command,
    group_command,
    contract_command,
    market_command,
    pay_command,
    mail_command,
    mailbox_command,
    health_command,
    ui_command,
    update_command,
    reset_command,
):
    cli.add_command(command)


def main(argv: list[str] | None = None) -> int:
    effective_argv = argv if argv is not None else sys.argv[1:]
    try:
        result = cli.main(args=effective_argv, prog_name="aln", standalone_mode=False)
    except click.UsageError as error:
        ctx = error.ctx
        if ctx is not None:
            click.echo(ctx.get_help(), err=True)
            click.echo("", err=True)
        click.echo(f"Error: {error.format_message()}", err=True)
        return int(error.exit_code)
    except click.ClickException as error:
        error.show()
        return int(error.exit_code)
    except click.exceptions.Exit as error:
        return int(error.exit_code)
    if isinstance(result, int):
        return result

    if "update" not in effective_argv:
        update_result = check_for_update()
        if update_result is not None:
            notice = format_update_notice(update_result)
            if notice is not None:
                click.echo(f"\n{notice}", err=True)

    return 0
