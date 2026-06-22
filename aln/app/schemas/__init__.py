"""Schema package for host backend API."""
#TODO:确定Sever 的所有 request 和 Response 的标准的 sechemas
# 保持与 host server 代码一致，并添加必要的注释说明。

from .jsonrpc import (
    JSONRPCError,
    JSONRPCRequest,
    JSONRPCResponse,
    RPCErrorCode,
)
from .response import StandardResponse
from .host import HealthResponse, HostUpdateRequest, HostUpdateResponse
from .entity import EntityUpdateRequest, RegisterEntityRequest
from .token_usage import TokenUsageRecord, TokenUsageSummary, TokenUsageTotals
from .trade import (
    ContractActionRequest,
    ContractWorkMessageRequest,
    ContractWorkMessageResponse,
    TradeSendRequest,
    TradeSendResponse,
)

__all__ = [
    # Shared host schemas
    "StandardResponse",
    # JSON-RPC schemas
    "JSONRPCError",
    "JSONRPCRequest",
    "JSONRPCResponse",
    "RPCErrorCode",
    "HealthResponse",
    # Entity schemas
    "HostUpdateRequest",
    "HostUpdateResponse",
    "EntityUpdateRequest",
    "RegisterEntityRequest",
    "TokenUsageRecord",
    "TokenUsageSummary",
    "TokenUsageTotals",
    "TradeSendRequest",
    "TradeSendResponse",
    "ContractActionRequest",
    "ContractWorkMessageRequest",
    "ContractWorkMessageResponse",
]
