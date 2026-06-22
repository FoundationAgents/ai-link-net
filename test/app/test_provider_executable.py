"""Provider executable resolution tests."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from aln.app.adapters.provider_executable import ProviderExecutableResolver


def test_env_override_wins(tmp_path: Path) -> None:
    """Explicit provider path should take precedence."""
    executable = tmp_path / "claude.cmd"
    executable.write_text("@echo off\n", encoding="utf-8")
    resolver = ProviderExecutableResolver(
        cwd=tmp_path,
        env={"ALN_PROVIDER_CLAUDE_PATH": str(executable)},
        is_windows=True,
    )

    resolved = resolver.resolve("claude", "claude")

    assert resolved is not None
    assert resolved.command == str(executable)
    assert resolved.source == "ALN_PROVIDER_CLAUDE_PATH"


def test_windows_codex_avoids_windowsapps_path(tmp_path: Path) -> None:
    """Codex should prefer the real local binary over WindowsApps stubs."""
    codex_bin = tmp_path / "OpenAI" / "Codex" / "bin" / "abc"
    codex_bin.mkdir(parents=True)
    codex_exe = codex_bin / "codex.exe"
    codex_exe.write_text("", encoding="utf-8")
    resolver = ProviderExecutableResolver(
        cwd=tmp_path,
        env={"LOCALAPPDATA": str(tmp_path)},
        is_windows=True,
    )

    with patch("shutil.which", return_value=r"C:\Program Files\WindowsApps\codex.exe"):
        resolved = resolver.resolve("codex", "codex")

    assert resolved is not None
    assert resolved.command == str(codex_exe)
    assert resolved.source == "LOCALAPPDATA"


def test_windows_claude_finds_nodeenv_script(tmp_path: Path) -> None:
    """Claude installed in the project nodeenv should be discoverable."""
    scripts_dir = tmp_path / ".nodeenv" / "Scripts"
    scripts_dir.mkdir(parents=True)
    claude_cmd = scripts_dir / "claude.cmd"
    claude_cmd.write_text("@echo off\n", encoding="utf-8")
    resolver = ProviderExecutableResolver(cwd=tmp_path, env={}, is_windows=True)

    with patch("shutil.which", return_value=None):
        resolved = resolver.resolve("claude", "claude")

    assert resolved is not None
    assert resolved.command == str(claude_cmd)
    assert resolved.source == "known-windows-path"


def test_windows_claude_finds_nodeenv_package_binary(tmp_path: Path) -> None:
    """Claude npm global installs can place the binary under node_modules."""
    claude_bin = (
        tmp_path
        / ".nodeenv"
        / "Scripts"
        / "node_modules"
        / "@anthropic-ai"
        / "claude-code"
        / "bin"
    )
    claude_bin.mkdir(parents=True)
    claude_exe = claude_bin / "claude.exe"
    claude_exe.write_text("", encoding="utf-8")
    resolver = ProviderExecutableResolver(cwd=tmp_path, env={}, is_windows=True)

    with patch("shutil.which", return_value=None):
        resolved = resolver.resolve("claude", "claude")

    assert resolved is not None
    assert resolved.command == str(claude_exe)
    assert resolved.source == "known-windows-path"
