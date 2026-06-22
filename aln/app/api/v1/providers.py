"""Provider health check API endpoints."""

from __future__ import annotations

import subprocess

from fastapi import APIRouter
from loguru import logger

from aln.app.adapters.cli_adapter import CLIMapping
from aln.app.adapters.provider_executable import ProviderExecutableResolver
from aln.app.schemas.provider import ProviderCheckRequest, ProviderCheckResponse

router = APIRouter(prefix="/providers", tags=["providers"])


@router.post("/check", response_model=ProviderCheckResponse)
async def check_provider(request: ProviderCheckRequest) -> ProviderCheckResponse:
    """Check if provider CLI is available and get version info."""
    provider = request.provider
    mapping = CLIMapping.from_yaml(provider)
    resolved = ProviderExecutableResolver().resolve(provider, mapping.executable)

    if resolved is None:
        logger.warning(f"Provider '{provider}' not found in PATH")
        return ProviderCheckResponse(
            available=False,
            provider=provider,
            error=f"Command not found: {provider}",
        )

    # Different providers use different version check commands
    version_commands = {
        "claude": ["--version"],
        "codex": ["--version"],
        "autowork": ["-h"],  # autowork doesn't support --version
        "openclaw": ["--version"],
        "hermes": ["--version"],
    }

    cmd_args = version_commands.get(provider, ["--version"])

    # Try to get version
    try:
        result = subprocess.run(
            [resolved.command] + cmd_args,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=5.0,
        )

        if result.returncode == 0:
            version = result.stdout.strip() or result.stderr.strip()
            # For autowork, extract first line as version indicator
            if provider == "autowork":
                version = version.split("\n")[0] if version else "available"
            logger.info(f"Provider '{provider}' available: {version}")
            return ProviderCheckResponse(
                available=True,
                provider=provider,
                version=version,
                executable_path=resolved.command,
            )
        else:
            error_msg = result.stderr.strip() or result.stdout.strip() or "Unknown error"
            logger.warning(f"Provider '{provider}' check failed: {error_msg}")
            return ProviderCheckResponse(
                available=False,
                provider=provider,
                error=error_msg,
            )

    except subprocess.TimeoutExpired:
        logger.warning(f"Provider '{provider}' check timed out")
        return ProviderCheckResponse(
            available=False,
            provider=provider,
            error="Command execution timed out",
        )

    except Exception as e:
        logger.error(f"Error checking provider '{provider}': {e}")
        return ProviderCheckResponse(
            available=False,
            provider=provider,
            error=str(e),
        )
