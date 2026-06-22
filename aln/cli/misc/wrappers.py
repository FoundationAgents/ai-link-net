"""Common utilities for CLI commands."""

from __future__ import annotations

import inspect
import json
import sys
from functools import wraps
from typing import Any, Callable, TypeVar

import click
from fp import EntityCard
from fp.entity import FriendshipRequiredError
from fp.utils.storage import StorageManager, get_storage_manager

from aln.app import HostClient, HostClientError

from .printer import CliPrinter


F = TypeVar("F", bound=Callable)


def _is_hex_uid(s: str) -> bool:
    """Check if string is a hex UID (8-char hex)."""
    return len(s) == 8 and all(c in "0123456789abcdef" for c in s.lower())


def parse_entity_spec(entity_spec: str, default_host: str = "default") -> tuple[str, str]:
    """Parse entity spec string into (host_identifier, entity_identifier)."""
    if ":" in entity_spec:
        parts = entity_spec.split(":", 1)
        return (parts[0], parts[1])
    return (default_host, entity_spec)


def resolve_entity_uid(client: HostClient, entity_identifier: str) -> str:
    """Resolve entity_identifier to entity_uid (8-char hex UID only)."""
    if _is_hex_uid(entity_identifier):
        return entity_identifier

    matched = client.entity_search(name=entity_identifier)
    if matched:
        hints = [f"  {e.name} -> {e.address.address}" for e in matched]
        raise click.ClickException(
            f"Use FP address format, not names. Matching addresses:\n" + "\n".join(hints)
        )
    raise click.ClickException(f"Entity not found: {entity_identifier}")


def resolve_entity_card(entity_spec: str, default_host: str = "default"):
    """Resolve FP address to EntityCard. Accepts host_uid:entity_uid or entity_uid only."""
    storage = get_storage_manager()
    host_id, entity_id = parse_entity_spec(entity_spec, default_host)

    host_uid = storage.resolve_host_name(host_id)
    host_url = storage.get_host_url(host_uid)
    client = HostClient(base_url=host_url)

    if _is_hex_uid(entity_id):
        matched = client.entity_search(uid=entity_id)
        if not matched:
            raise click.ClickException(f"Entity not found: {entity_id}")
        return matched[0]

    matched = client.entity_search(name=entity_id)
    if matched:
        hints = [f"  {e.name} -> {e.address.address}" for e in matched]
        raise click.ClickException(
            f"Use FP address format (host_uid:entity_uid), not name '{entity_id}'.\n"
            f"Matching addresses:\n" + "\n".join(hints)
        )
    raise click.ClickException(
        f"Entity not found: '{entity_id}'. Use FP address format (host_uid:entity_uid)."
    )


def _host_has_arbiter(client: HostClient) -> bool:
    """Check if a host has an Arbiter entity."""
    try:
        return any(e.kind == "arbiter" for e in client.entity_list())
    except Exception:
        return False


def resolve_arbiter_client(entity_card: EntityCard) -> HostClient:
    """Discover Arbiter host from entity's host hierarchy (current → parent → children)."""
    storage = get_storage_manager()
    host_uid = entity_card.host_uid

    host_url = storage.get_host_url(host_uid)
    client = HostClient(base_url=host_url)
    if _host_has_arbiter(client):
        return client

    host_entry = storage.get_host(host_uid)
    if host_entry.parent_url:
        parent_client = HostClient(base_url=host_entry.parent_url)
        if _host_has_arbiter(parent_client):
            return parent_client

    for child_uid, child_entry in storage.get_all_hosts().items():
        if child_entry.parent_uid == host_uid:
            child_client = HostClient(base_url=storage.get_host_url(child_uid))
            if _host_has_arbiter(child_client):
                return child_client

    raise click.ClickException(
        f"No Arbiter found for entity '{entity_card.name}'"
    )


def _inject_keyword_argument(
    func: Callable[..., Any],
    kwargs: dict[str, Any],
    value: Any,
    preferred_name: str,
    fallback_name: str,
) -> dict[str, Any]:
    """Inject value into kwargs using a compatible parameter name."""
    injected_kwargs = dict(kwargs)
    parameters = inspect.signature(func).parameters

    if preferred_name in parameters:
        injected_kwargs[preferred_name] = value
        return injected_kwargs
    if fallback_name in parameters:
        injected_kwargs[fallback_name] = value
        return injected_kwargs

    injected_kwargs[preferred_name] = value
    return injected_kwargs


def cli_exception_wrapper(error_message: str | None = None) -> Callable:
    """Decorator to handle exceptions in CLI commands with unified error format.

    Args:
        error_message: Custom error message prefix

    Returns:
        Decorated function that catches exceptions and prints formatted errors
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapped(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except click.ClickException:
                # Let click handle its own exceptions
                raise
            except FriendshipRequiredError as e:
                click.echo(click.style("Error: friend required", fg="red", bold=True))
                click.echo(f"  {e.sender_name} -> {e.recipient_id} ({e.message_kind})")
                click.echo(f"  运行 aln friend request -e {e.sender_name} --to {e.recipient_id} 先添加好友")
                sys.exit(1)
            except HostClientError as e:
                # Handle host client errors
                click.echo(click.style("Host Error", fg="red", bold=True))
                click.echo(f"  {str(e)}")
                sys.exit(1)
            except (FileNotFoundError, json.JSONDecodeError) as e:
                # Handle config file errors
                click.echo(click.style("Config Error", fg="red", bold=True))
                click.echo(f"  {str(e)}")
                sys.exit(1)
            except Exception as e:
                # Handle all other exceptions
                click.echo(click.style("Error", fg="red", bold=True))
                if error_message:
                    click.echo(f"  {error_message}: {str(e)}")
                else:
                    click.echo(f"  {str(e)}")
                sys.exit(1)

        return wrapped

    return decorator


def get_host_client(f: F) -> F:
    """Decorator that provides a HostClient instance for the given host_name.

    Reads the config file, finds the host URL, and passes a HostClient instance
    to the decorated function.
    """

    @wraps(f)
    def wrapper(host_name: str, *args, **kwargs):
        storage = get_storage_manager()

        # Get host URL using StorageManager
        host_url = storage.get_host_url(host_name)

        # Create HostClient instance
        client = HostClient(base_url=host_url)

        injected_kwargs = _inject_keyword_argument(
            f,
            kwargs,
            client,
            preferred_name="client",
            fallback_name="host_client",
        )
        return f(host_name=host_name, *args, **injected_kwargs)

    return wrapper  # type: ignore


def get_cli_printer(f: F) -> F:
    """Decorator that injects a CliPrinter instance into CLI command handlers."""

    @wraps(f)
    def wrapper(*args, **kwargs):
        cli_printer = CliPrinter()
        return f(*args, cli_printer=cli_printer, **kwargs)

    return wrapper  # type: ignore


def get_storage(f: F) -> F:
    """Decorator that injects a StorageManager instance into CLI command handlers."""

    @wraps(f)
    def wrapper(*args, **kwargs):
        storage = get_storage_manager()
        return f(*args, storage=storage, **kwargs)

    return wrapper  # type: ignore


def trade_send(
    entity_spec: str,
    kind: str,
    payload: dict,
    to_entity: str | None = None,
) -> dict:
    """Resolve entity and send the trade command through the entity's own host."""
    card = resolve_entity_card(entity_spec)
    storage = get_storage_manager()
    host_url = storage.get_host_url(card.host_uid)
    local_client = HostClient(base_url=host_url)
    result = local_client.trade_send(
        from_entity=card.entity_uid,
        kind=kind,
        payload=payload,
        to_entity=to_entity,
    )
    arbiter_client = resolve_arbiter_client(card)
    if arbiter_client.base_url == local_client.base_url:
        return result

    contracts = arbiter_client.trade_contracts()
    payments = arbiter_client.trade_payments()
    result["contracts"] = {
        item["contract_id"]: item for item in contracts if isinstance(item, dict) and "contract_id" in item
    }
    result["payments"] = {
        item["payment_id"]: item for item in payments if isinstance(item, dict) and "payment_id" in item
    }
    return result
