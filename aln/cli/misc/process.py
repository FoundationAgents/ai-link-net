"""Process and port utilities."""

from __future__ import annotations

import ctypes
import os
import signal
import socket
import subprocess
import time

_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_STILL_ACTIVE = 259
_SYNCHRONIZE = 0x00100000

_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True) if os.name == "nt" else None


def _is_windows_pid_alive(pid: int) -> bool:
    """Check process liveness with Win32 process handles."""
    if pid <= 0 or _kernel32 is None:
        return False

    handle = _kernel32.OpenProcess(
        _PROCESS_QUERY_LIMITED_INFORMATION | _SYNCHRONIZE,
        False,
        pid,
    )
    if not handle:
        return ctypes.get_last_error() == 5

    try:
        exit_code = ctypes.c_ulong()
        if not _kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return False
        return exit_code.value == _STILL_ACTIVE
    finally:
        _kernel32.CloseHandle(handle)


def is_pid_alive(pid: int) -> bool:
    """Check if a process is running by PID."""
    if os.name == "nt":
        return _is_windows_pid_alive(pid)

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def is_port_open(host: str, port: int, timeout: float = 0.2) -> bool:
    """Check if a TCP port is accepting connections."""

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.connect((host, port))
            return True
        except OSError:
            return False


def stop_pid(pid: int, timeout: float = 3.0) -> bool:
    """Stop a process by PID, returns True if stopped.

    Args:
        pid: Process ID to stop.
        timeout: How long to wait for graceful shutdown before force kill.

    Returns:
        True if process was stopped, False otherwise.
    """
    if not is_pid_alive(pid):
        return True

    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            check=False,
            text=True,
        )
        deadline = time.time() + max(timeout, 0.1)
        while time.time() < deadline:
            if not is_pid_alive(pid):
                return True
            time.sleep(0.05)
        return not is_pid_alive(pid)

    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return not is_pid_alive(pid)

    deadline = time.time() + max(timeout, 0.1)
    while time.time() < deadline:
        if not is_pid_alive(pid):
            return True
        time.sleep(0.05)

    # Force kill if still alive
    try:
        os.kill(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
    except OSError:
        pass

    time.sleep(0.05)
    return not is_pid_alive(pid)
