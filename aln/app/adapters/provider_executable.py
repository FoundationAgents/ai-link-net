"""Resolve provider CLI executables for checks and agent turns."""

from __future__ import annotations

import os
import shutil
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class ProviderExecutable:
    """Resolved provider command and its source."""

    command: str
    source: str


class ProviderExecutableResolver:
    """Resolve provider commands with Windows-friendly fallbacks."""

    def __init__(
        self,
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        is_windows: bool | None = None,
    ) -> None:
        self.cwd = cwd or Path.cwd()
        self.env = env or os.environ
        self.is_windows = os.name == "nt" if is_windows is None else is_windows

    def resolve(self, provider: str, executable: str) -> ProviderExecutable | None:
        """Return the executable command used for a provider, if available."""
        normalized_provider = provider.strip().upper().replace("-", "_")
        override = self._resolve_override(normalized_provider, executable)
        if override:
            return override

        which_path = shutil.which(executable)
        if which_path and not self._is_blocked_windowsapps_path(which_path):
            return ProviderExecutable(command=which_path, source="PATH")

        fallback = self._resolve_windows_fallback(provider, executable)
        if fallback:
            return fallback

        if which_path:
            return ProviderExecutable(command=which_path, source="PATH")
        return None

    def _resolve_override(
        self,
        normalized_provider: str,
        executable: str,
    ) -> ProviderExecutable | None:
        override_keys = (
            f"ALN_PROVIDER_{normalized_provider}_PATH",
            f"ALN_{executable.strip().upper().replace('-', '_')}_PATH",
        )
        for key in override_keys:
            raw_value = self.env.get(key)
            if not raw_value:
                continue
            command = self._existing_command(raw_value.strip()) or shutil.which(raw_value)
            if command:
                return ProviderExecutable(command=command, source=key)
        return None

    def _resolve_windows_fallback(
        self,
        provider: str,
        executable: str,
    ) -> ProviderExecutable | None:
        if not self.is_windows:
            return None

        normalized = provider.strip().lower()
        executable_name = Path(executable).name.lower()

        if normalized == "codex" or executable_name == "codex":
            return self._resolve_windows_codex()
        if normalized == "claude" or executable_name == "claude":
            return self._resolve_windows_claude()
        return None

    def _resolve_windows_codex(self) -> ProviderExecutable | None:
        local_app_data = self.env.get("LOCALAPPDATA")
        if not local_app_data:
            return None

        bin_root = Path(local_app_data) / "OpenAI" / "Codex" / "bin"
        candidates = sorted(
            bin_root.glob("*/codex.exe"),
            key=lambda path: path.stat().st_mtime if path.exists() else 0,
            reverse=True,
        )
        for candidate in candidates:
            command = self._existing_command(str(candidate))
            if command:
                return ProviderExecutable(command=command, source="LOCALAPPDATA")
        return None

    def _resolve_windows_claude(self) -> ProviderExecutable | None:
        candidates: list[Path] = []
        for script_name in ("claude.cmd", "claude.exe", "claude"):
            candidates.append(self.cwd / ".nodeenv" / "Scripts" / script_name)

            app_data = self.env.get("APPDATA")
            if app_data:
                candidates.append(Path(app_data) / "npm" / script_name)

        candidates.append(
            self.cwd
            / ".nodeenv"
            / "Scripts"
            / "node_modules"
            / "@anthropic-ai"
            / "claude-code"
            / "bin"
            / "claude.exe"
        )

        for candidate in candidates:
            command = self._existing_command(str(candidate))
            if command:
                return ProviderExecutable(command=command, source="known-windows-path")
        return None

    def _existing_command(self, raw_value: str) -> str | None:
        if not raw_value:
            return None
        candidate = Path(raw_value).expanduser()
        if candidate.exists():
            return str(candidate)
        return None

    @staticmethod
    def _is_blocked_windowsapps_path(path_value: str) -> bool:
        return "\\windowsapps\\" in path_value.lower()
