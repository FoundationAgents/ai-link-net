"""Shared helpers for app handler tests."""

from __future__ import annotations

from fp.handler import HandlerConfig


def make_handler_config(**overrides: object) -> HandlerConfig:
    """Create a default fully-trusted batch handler config."""
    defaults = {
        "trust_level": "fully_trusted",
        "interaction_mode": "batch",
        "output_format": "json",
    }
    defaults.update(overrides)
    return HandlerConfig.from_dict(defaults)
