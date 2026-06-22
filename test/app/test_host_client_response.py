"""HostClient response envelope tests."""

from __future__ import annotations

import pytest

from aln.app import HostClientError
from aln.app.service.host_client import HostClient


def test_extract_data_field_rejects_failed_standard_response() -> None:
    """Failed StandardResponse envelopes should raise a host client error."""
    with pytest.raises(HostClientError, match="send group message failed"):
        HostClient._extract_data_field(
            {
                "success": False,
                "message": "sender is not allowed",
                "data": {"error_code": 403},
            },
            context="send group message",
            expected_type=dict,
        )
