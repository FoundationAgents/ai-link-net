"""CLI adapter for mapping HandlerConfig to provider-specific CLI commands."""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml
from loguru import logger

from aln.app.adapters.provider_executable import ProviderExecutableResolver

if TYPE_CHECKING:
    from fp.handler import HandlerConfig


@dataclass(slots=True)
class CLIMapping:
    """CLI field and value mapping rules."""

    # Required fields (no defaults)
    provider_name: str
    executable: str
    base_command: list[str]  # e.g., ["exec"] for codex
    field_mapping: dict[str, dict[str, Any]]
    output_format: str  # json / text / jsonl
    text_path: list[str]
    session_id_path: list[str]
    resume_flag: str
    resume_use_session_id: bool

    # Optional fields (with defaults)
    prompt_via_stdin: bool = False  # Whether to pass prompt via stdin
    prompt_flag: str | None = None  # Optional flag before prompt, e.g., "--message"
    json_on_stderr: bool = False  # Whether JSON output is on stderr (e.g., openclaw)

    # Text output cleanup
    text_session_id_regex: str | None = None
    text_strip_patterns: list[str] = field(default_factory=list)
    text_frame_separator: str | None = None

    # Extra environment variables for subprocess
    env: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_yaml(cls, provider: str) -> CLIMapping:
        """Load mapping rules from YAML."""
        yaml_file = Path(__file__).parent / "providers.yaml"
        if not yaml_file.exists():
            raise ValueError(f"Provider config file not found: {yaml_file}")

        with open(yaml_file, encoding="utf-8") as f:
            all_providers = yaml.safe_load(f)

        if provider not in all_providers:
            raise ValueError(f"Provider '{provider}' not found in providers.yaml")

        data = all_providers[provider]
        output = data.get("output", {})
        resume = data.get("resume", {})

        return cls(
            provider_name=data["provider_name"],
            executable=data["executable"],
            base_command=data.get("base_command", []),
            prompt_via_stdin=data.get("prompt_via_stdin", False),
            prompt_flag=data.get("prompt_flag"),
            json_on_stderr=data.get("json_on_stderr", False),
            field_mapping=data.get("field_mapping", {}),
            output_format=output.get("format", "json"),
            text_path=output.get("text_path", ["result"]),
            session_id_path=output.get("session_id_path", ["session_id"]),
            resume_flag=resume.get("flag", "-r"),
            resume_use_session_id=resume.get("use_session_id_arg", False),
            text_session_id_regex=output.get("session_id_regex"),
            text_strip_patterns=output.get("strip_patterns", []),
            text_frame_separator=output.get("frame_separator"),
            env=data.get("env", {}),
        )


@dataclass(slots=True)
class CLIResult:
    """CLI execution result."""

    text: str
    provider_session_id: str | None = None
    return_code: int = 0
    raw_stdout: str = ""
    raw_stderr: str = ""

    # Metadata extracted from CLI output
    metadata: dict[str, Any] = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}


class CLIAdapter:
    """CLI adapter - maps HandlerConfig to provider-specific CLI commands."""

    def __init__(self, provider: str):
        self.provider = provider
        self.mapping = CLIMapping.from_yaml(provider)
        resolved = ProviderExecutableResolver().resolve(provider, self.mapping.executable)
        self.executable = resolved.command if resolved else self.mapping.executable

    def run_turn(
        self,
        prompt: str,
        config: HandlerConfig,
        *,
        session_id: str | None = None,
        provider_session_id: str | None = None,
        system_prompt: str | None = None,
        entity_name: str | None = None,
    ) -> CLIResult:
        """Execute one CLI turn.

        Args:
            prompt: User input text
            config: Handler config (protocol layer)
            session_id: FP protocol session ID
            provider_session_id: Provider CLI session ID (for resumption)
            system_prompt: System prompt
            entity_name: Entity name for logging

        Returns:
            CLI execution result
        """
        is_resume = provider_session_id is not None
        effective_system = system_prompt if not is_resume else None

        # 1. Build command
        command = self._build_command(
            prompt=prompt,
            config=config,
            session_id=session_id,
            provider_session_id=provider_session_id,
            system_prompt=system_prompt,
        )

        # Prepare stdin input if needed
        stdin_input = None
        if self.mapping.prompt_via_stdin:
            final_prompt = self._prepare_prompt(prompt, effective_system, config)
            stdin_input = final_prompt

        # Log full executable command
        entity_prefix = f"[{entity_name}] " if entity_name else ""
        full_cli = self._format_command_for_log(command, stdin_input)
        logger.info(f"{entity_prefix}AgentHandler 执行命令:\n{full_cli}")

        # 2. Execute command
        result = self._execute_command(command, config, stdin_input)
        logger.info(
            f"{entity_prefix}AgentHandler CLI 原始返回:\n"
            f"{self._format_raw_result_for_log(result)}"
        )

        # 3. Parse output — only pass FP session_id as fallback if provider maps it
        fallback_sid = provider_session_id
        if fallback_sid is None:
            sid_mapping = self.mapping.field_mapping.get("session_id", {})
            if sid_mapping.get("type") != "no_mapping":
                fallback_sid = session_id
        parsed = self._parse_output(result, fallback_sid)
        logger.info(
            f"{entity_prefix}AgentHandler CLI 解析结果:\n"
            f"{self._format_parsed_result_for_log(parsed)}"
        )
        return parsed

    def _execute_command(
        self,
        command: list[str],
        config: HandlerConfig,
        stdin_input: str | None,
    ) -> subprocess.CompletedProcess[str]:
        """Execute a CLI command and return decoded result."""
        try:
            run_env = None
            if self.mapping.env:
                run_env = {**os.environ, **self.mapping.env}

            if stdin_input is not None:
                result = subprocess.run(
                    command,
                    input=stdin_input.encode("utf-8"),
                    capture_output=True,
                    timeout=config.timeout,
                    cwd=config.workdir,
                    env=run_env,
                    check=False,
                )
            else:
                result = subprocess.run(
                    command,
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    timeout=config.timeout,
                    cwd=config.workdir,
                    env=run_env,
                    check=False,
                )

            return subprocess.CompletedProcess(
                result.args,
                result.returncode,
                stdout=result.stdout.decode("utf-8", errors="replace"),
                stderr=result.stderr.decode("utf-8", errors="replace"),
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"{self.provider} CLI timeout after {config.timeout}s") from e
        except FileNotFoundError as e:
            raise RuntimeError(
                f"{self.provider} CLI not found: {self.executable}"
            ) from e
        except PermissionError as e:
            raise RuntimeError(
                f"{self.provider} CLI is not executable: {self.executable}"
            ) from e

    def compose_prompt(
        self, prompt: str, config: HandlerConfig, system_prompt: str | None = None
    ) -> str:
        """Compose the effective prompt passed to provider CLI."""
        return self._prepare_prompt(prompt, system_prompt, config)

    @staticmethod
    def _format_command_for_log(command: list[str], stdin_input: str | None) -> str:
        """Render command as reproducible shell text."""
        command_text = shlex.join(command)
        if stdin_input is None:
            return command_text

        delimiter = "__FP_PROMPT_EOF__"
        while delimiter in stdin_input:
            delimiter += "_X"
        return f"cat <<'{delimiter}' | {command_text}\n{stdin_input}\n{delimiter}"

    @staticmethod
    def _format_raw_result_for_log(result: subprocess.CompletedProcess[str]) -> str:
        """Render raw CLI stdout/stderr for debugging logs."""
        stdout = result.stdout if result.stdout else "<empty>"
        stderr = result.stderr if result.stderr else "<empty>"
        return (
            f"exit_code: {result.returncode}\n"
            f"stdout:\n{stdout}\n"
            f"stderr:\n{stderr}"
        )

    @staticmethod
    def _format_parsed_result_for_log(parsed: CLIResult) -> str:
        """Render parsed CLI result for debugging logs."""
        text = parsed.text if parsed.text else "<empty>"
        provider_session_id = parsed.provider_session_id or "<none>"
        metadata = parsed.metadata if parsed.metadata else {}
        return (
            f"return_code: {parsed.return_code}\n"
            f"provider_session_id: {provider_session_id}\n"
            f"metadata: {json.dumps(metadata, ensure_ascii=False)}\n"
            f"text:\n{text}"
        )

    def _build_command(
        self,
        prompt: str,
        config: HandlerConfig,
        session_id: str | None,
        provider_session_id: str | None,
        system_prompt: str | None,
    ) -> list[str]:
        """Build CLI command - core mapping logic."""
        cmd = [self.executable] + self.mapping.base_command
        is_resume = provider_session_id is not None

        # New session: map session_id if supported
        if not is_resume:
            self._map_field(cmd, "session_id", session_id, config)

        # Map HandlerConfig fields (before resume subcommand, so flags are global)
        config_dict = config.to_dict()
        for field_name in [
            "workdir",
            "trust_level",
            "interaction_mode",
            "stream_output",
            "output_format",
            "allowed_tools",
            "model",
            "max_budget_usd",
        ]:
            value = config_dict.get(field_name)
            self._map_field(cmd, field_name, value, config)

        # Resume subcommand comes after global flags
        if is_resume:
            cmd.append(self.mapping.resume_flag)
            if self.mapping.resume_use_session_id:
                cmd.append(provider_session_id)

        # System prompt only on first turn (resume already has context)
        if system_prompt and not is_resume:
            self._map_field(cmd, "system_prompt", system_prompt, config)

        # Prompt argument
        effective_system = system_prompt if not is_resume else None
        if self.mapping.prompt_via_stdin:
            cmd.append("-")
        elif self.mapping.prompt_flag:
            final_prompt = self._prepare_prompt(prompt, effective_system, config)
            cmd.extend([self.mapping.prompt_flag, final_prompt])
        else:
            final_prompt = self._prepare_prompt(prompt, effective_system, config)
            cmd.append(final_prompt)

        return cmd

    def _map_field(
        self, cmd: list[str], field_name: str, value: Any, config: HandlerConfig
    ) -> None:
        """Map single HandlerConfig field to CLI argument(s)."""
        if value is None:
            return

        field_config = self.mapping.field_mapping.get(field_name)
        if not field_config:
            return

        mapping_type = field_config.get("type")

        if mapping_type == "no_mapping":
            # This field is not supported by this provider
            return

        elif mapping_type == "inline":
            # Handled separately in _prepare_prompt
            return

        elif mapping_type == "value":
            # Simple flag + value
            flag = field_config["flag"]
            if field_config.get("mapping_fn") == "uuid_from_string":
                value = str(uuid.uuid5(uuid.NAMESPACE_DNS, str(value)))
            cmd.extend([flag, str(value)])

        elif mapping_type == "enum":
            # Enum mapping
            flag = field_config["flag"]
            value_str = value.value if hasattr(value, "value") else str(value)
            mapped_value = field_config["mapping"].get(value_str, value_str)
            cmd.extend([flag, mapped_value])

        elif mapping_type == "boolean_flag":
            # Boolean flag (only add if condition met)
            add_when = field_config.get("add_when")
            should_add = False

            if add_when == "true":
                should_add = bool(value)
            elif add_when is not None:
                # Check if value matches add_when condition
                value_str = value.value if hasattr(value, "value") else str(value)
                should_add = value_str == add_when
            else:
                should_add = bool(value)

            if should_add:
                cmd.append(field_config["flag"])

        elif mapping_type == "list":
            # List expansion
            flag = field_config["flag"]
            if isinstance(value, list):
                cmd.append(flag)
                cmd.extend(str(v) for v in value)

        elif mapping_type == "composite":
            # One field maps to multiple CLI args
            value_str = value.value if hasattr(value, "value") else str(value)
            mappings = field_config.get("mappings", {}).get(value_str, [])

            for mapping in mappings:
                if mapping.get("type") == "boolean_flag":
                    cmd.append(mapping["flag"])
                else:
                    cmd.extend([mapping["flag"], mapping["value"]])

    def _prepare_prompt(
        self, prompt: str, system_prompt: str | None, config: HandlerConfig
    ) -> str:
        """Prepare final prompt (handle inline system prompt)."""
        # Check if system_prompt needs inline injection
        system_config = self.mapping.field_mapping.get("system_prompt", {})
        if system_config.get("type") == "inline" and system_prompt:
            return f"<system>\n{system_prompt}\n</system>\n\n{prompt}"
        return prompt

    def _parse_output(
        self,
        result: subprocess.CompletedProcess[str],
        fallback_session_id: str | None,
    ) -> CLIResult:
        """Parse CLI output."""
        if result.returncode != 0:
            error_msg = result.stderr.strip() or result.stdout.strip() or "unknown error"
            if self.mapping.output_format == "json" and result.stdout.strip():
                try:
                    data = json.loads(result.stdout.strip())
                    if data.get("session_id"):
                        return CLIResult(
                            text=self._extract_by_path(data, self.mapping.text_path) or "",
                            provider_session_id=data["session_id"],
                            return_code=result.returncode,
                            raw_stdout=result.stdout,
                            raw_stderr=result.stderr,
                        )
                except (json.JSONDecodeError, KeyError):
                    pass
            raise RuntimeError(
                f"{self.provider} CLI failed (exit {result.returncode}): {error_msg}"
            )

        output = result.stdout.strip()
        if not output:
            # Fallback to stderr if stdout is empty (e.g., openclaw writes JSON to stderr)
            if self.mapping.json_on_stderr:
                output = self._extract_json_from_stderr(result.stderr)
            else:
                output = result.stderr.strip()
            if not output:
                raise RuntimeError(f"{self.provider} CLI returned empty output")

        # Parse by format
        if self.mapping.output_format == "json":
            return self._parse_json(output, result, fallback_session_id)
        elif self.mapping.output_format == "jsonl":
            return self._parse_jsonl(output, result, fallback_session_id)
        else:
            # text format — with optional cleanup
            return self._parse_text(output, result, fallback_session_id)

    def _parse_text(
        self,
        output: str,
        result: subprocess.CompletedProcess[str],
        fallback_session_id: str | None,
    ) -> CLIResult:
        """Parse text output with optional cleanup and session_id extraction."""
        text = output
        session_id = fallback_session_id

        # Take last frame if streaming produces multiple Rich panels
        if self.mapping.text_frame_separator:
            frames = re.split(self.mapping.text_frame_separator, text)
            if len(frames) > 1:
                text = frames[-1]

        # Strip lines containing \r (streaming intermediate chunks within a frame)
        lines = text.split("\n")
        text = "\n".join(line for line in lines if "\r" not in line)

        # Extract session_id via regex (and remove the line)
        if self.mapping.text_session_id_regex:
            match = re.search(self.mapping.text_session_id_regex, text)
            if match:
                session_id = match.group(1)
                text = text[:match.start()] + text[match.end():]

        # Strip patterns (e.g., Rich box-drawing decorations)
        for pattern in self.mapping.text_strip_patterns:
            text = re.sub(pattern, "", text)

        text = text.strip()
        if not text:
            text = output.strip()

        return CLIResult(
            text=text,
            provider_session_id=session_id,
            return_code=result.returncode,
            raw_stdout=result.stdout,
            raw_stderr=result.stderr,
        )

    def _parse_json(
        self,
        output: str,
        result: subprocess.CompletedProcess[str],
        fallback_session_id: str | None,
    ) -> CLIResult:
        """Parse JSON output."""
        try:
            data = json.loads(output)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"{self.provider} CLI returned invalid JSON: {e}") from e

        text = self._extract_by_path(data, self.mapping.text_path)
        session_id = self._extract_by_path(data, self.mapping.session_id_path)
        metadata = self._extract_usage_metadata(data)
        
        # Only use fallback if we actually mapped session_id to something
        # Otherwise, if provider doesn't output a session_id, don't poison it with the FP session_id
        # (e.g. Claude requires a UUID, FP session_ids are not UUIDs)
        final_provider_session_id = session_id
        if final_provider_session_id is None and "session_id" in self.mapping.field_mapping:
            if self.mapping.field_mapping["session_id"].get("type") != "no_mapping":
                final_provider_session_id = fallback_session_id

        return CLIResult(
            text=text or "",
            provider_session_id=final_provider_session_id,
            return_code=result.returncode if text else 1,
            raw_stdout=result.stdout,
            raw_stderr=result.stderr,
            metadata=metadata,
        )

    def _parse_jsonl(
        self,
        output: str,
        result: subprocess.CompletedProcess[str],
        fallback_session_id: str | None,
    ) -> CLIResult:
        """Parse JSONL output (one JSON per line).

        For codex-style JSONL, extracts:
        - text from item.completed events
        - session_id from thread.started
        - usage info from turn.completed
        """
        extracted_session_id: str | None = None
        text_parts = []
        metadata = {}

        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                event_type = event.get("type", "")

                # Extract provider session_id (always attempt, prefer output over fallback)
                if not extracted_session_id:
                    found = self._extract_by_path(event, self.mapping.session_id_path)
                    if found:
                        extracted_session_id = found

                # Extract text from item.completed events
                if event_type == "item.completed":
                    item = event.get("item", {})
                    if item.get("type") == "agent_message":
                        text = item.get("text", "")
                        if text:
                            text_parts.append(text)

                # Extract usage info
                if event_type == "turn.completed":
                    metadata.update(self._extract_usage_metadata(event))

                # Extract thread_id
                if event_type == "thread.started":
                    thread_id = event.get("thread_id")
                    if thread_id:
                        metadata["thread_id"] = thread_id

            except json.JSONDecodeError:
                continue

        # Join text parts or fallback to raw output
        final_text = "\n\n".join(text_parts) if text_parts else output

        # Prefer extracted provider session_id; only fallback if nothing was extracted
        final_provider_session_id = extracted_session_id or fallback_session_id

        return CLIResult(
            text=final_text,
            provider_session_id=final_provider_session_id,
            return_code=result.returncode,
            raw_stdout=result.stdout,
            raw_stderr=result.stderr,
            metadata=metadata,
        )

    @classmethod
    def _extract_usage_metadata(cls, data: dict[str, Any]) -> dict[str, Any]:
        """Extract normalized usage metadata from provider output."""
        raw_usage = data.get("usage")
        if isinstance(raw_usage, dict) and not raw_usage:
            return {}
        usage = raw_usage if isinstance(raw_usage, dict) else data
        input_tokens = cls._first_int(usage, ["input_tokens", "prompt_tokens"])
        cached_input_tokens = cls._first_int(
            usage,
            [
                "cached_input_tokens",
                "cache_read_input_tokens",
                "cached_tokens",
            ],
        )
        output_tokens = cls._first_int(usage, ["output_tokens", "completion_tokens"])
        total_tokens = cls._first_int(usage, ["total_tokens"])
        if total_tokens == 0:
            total_tokens = input_tokens + output_tokens

        if total_tokens == 0 and not isinstance(raw_usage, dict):
            return {}

        return {
            "usage": usage,
            "input_tokens": input_tokens,
            "cached_input_tokens": cached_input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
        }

    @staticmethod
    def _first_int(data: dict[str, Any], keys: list[str]) -> int:
        """Return the first non-negative integer-like value for keys."""
        for key in keys:
            value = data.get(key)
            if isinstance(value, bool) or value is None:
                continue
            if isinstance(value, int):
                return max(0, value)
            if isinstance(value, float):
                return max(0, int(value))
            if isinstance(value, str):
                try:
                    return max(0, int(float(value)))
                except ValueError:
                    continue
        return 0

    @staticmethod
    def _extract_by_path(data: dict, path: list[str]) -> Any:
        """Extract value from nested dict/list by path."""
        current = data
        for key in path:
            if isinstance(current, dict):
                current = current.get(key)
                if current is None:
                    return None
            elif isinstance(current, list):
                try:
                    current = current[int(key)]
                except (ValueError, IndexError):
                    return None
            else:
                return None
        return current

    @staticmethod
    def _extract_json_from_stderr(stderr: str) -> str:
        """Extract JSON from stderr that may have prefix text (e.g., openclaw).

        Finds the complete JSON object by locating the first '{' at line start
        and the last '}' followed by end of string or newline.
        """
        lines = stderr.split("\n")

        # Find the first line that starts with '{' - that's the JSON start
        json_start = -1
        for i, line in enumerate(lines):
            if line.strip().startswith("{"):
                # Find actual position in original stderr
                json_start = stderr.find(line)
                break

        if json_start < 0:
            return ""

        # Find the last '}' that could be the JSON end
        # It should be at the end of a line or followed by newline/end
        json_end = stderr.rfind("}")
        if json_end < 0:
            return ""

        # Extend to end of that line
        end_of_line = stderr.find("\n", json_end)
        if end_of_line < 0:
            end_of_line = len(stderr)

        return stderr[json_start:end_of_line].strip()
