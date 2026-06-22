"""HTTP client for host-to-host communication."""

from __future__ import annotations

import json
from typing import Any
from urllib import error, request

from fp import EntityCard, HostWellKnown, Mail

from aln.app.endpoint import ENDPOINT
from aln.app.schemas import (
    EntityUpdateRequest,
    HealthResponse,
    HostUpdateRequest,
    HostUpdateResponse,
    StandardResponse,
)


class HostClientError(RuntimeError):
    """Raised when host request fails."""


class HostClient:
    # NOTE:当设计访问其他 Host 的时候使用这个 client，封装了访问其他 Host 的细节，包括错误处理和 JSON 解析等。
    # HostClient 主要用于在需要与父 Host 通信时获取父 Host 的信息，以及在注册为子 Host 时向父 Host 发送注册请求。
    """HTTP client for communicating with other hosts."""
    #TODO[优化]：所有传递的消息的 schema 统一一下。
    def __init__(self, base_url: str, timeout: float = 5.0):
        """Initialize client."""
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        # Keep one opener instance to avoid rebuilding handlers per request.
        self._opener = request.build_opener(request.ProxyHandler({}))

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Execute HTTP request and return JSON response."""
        url = f"{self.base_url}{path}"

        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = request.Request(url=url, data=data, headers=headers, method=method)

        # Execute request
        try:
            with self._opener.open(req, timeout=self.timeout) as response:
                raw = response.read()
        except error.HTTPError as exc:
            error_body = exc.read().decode("utf-8") if exc.fp else ""
            parsed_error = self._parse_error_payload(error_body)
            raise HostClientError(
                f"HTTP Error {exc.code}: {exc.reason}. {parsed_error}"
            ) from exc
        except error.URLError as exc:
            raise HostClientError(str(exc)) from exc

        # Parse JSON
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise HostClientError(f"invalid JSON response from {url}") from exc

        if not isinstance(data, dict):
            raise HostClientError(f"response from {url} is not a JSON object")

        return data

    @staticmethod
    def _parse_error_payload(error_body: str) -> str:
        """Parse server error payload to extract concise detail/message."""
        payload = error_body.strip()
        if not payload:
            return "No error payload"

        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            return payload

        if isinstance(parsed, dict):
            detail = parsed.get("detail")
            if isinstance(detail, str) and detail:
                return detail
            message = parsed.get("message")
            if isinstance(message, str) and message:
                return message
            return json.dumps(parsed, ensure_ascii=False)

        return payload

    @staticmethod
    def _extract_data_field(
        response: dict[str, Any],
        *,
        context: str,
        expected_type: type,
    ) -> Any:
        if response.get("success") is False:
            message = response.get("message")
            detail = message if isinstance(message, str) and message else "request failed"
            raise HostClientError(f"{context} failed: {detail}")
        if "data" not in response:
            raise HostClientError(f"{context} response missing 'data' field")
        data = response["data"]
        if not isinstance(data, expected_type):
            raise HostClientError(
                f"{context} 'data' field is not a {expected_type.__name__}"
            )
        return data

    def get_wellknown(self) -> HostWellKnown:
        # NOTE:只写一行 docstring，保持简洁，其他细节放到 type hints 和代码里，符合 Pythonic 风格
        """Fetch host's .well-known discovery document."""
        response = self._request("GET", ENDPOINT.WELL_KNOWN)

        data = self._extract_data_field(
            response, context="wellknown", expected_type=dict
        )

        # Parse as HostWellKnown
        try:
            return HostWellKnown(**data)
        except Exception as exc:
            raise HostClientError(f"invalid wellknown format: {exc}") from exc

    def register_child(self, child_wellknown: HostWellKnown) -> HostWellKnown:
        """Register this host as a child to the parent, returns parent's wellknown."""
        response = self._request(
            "POST",
            ENDPOINT.CHILDREN,
            payload=child_wellknown.model_dump(),
        )
        data = self._extract_data_field(response, context="register_child", expected_type=dict)
        try:
            return HostWellKnown(**data)
        except Exception as exc:
            raise HostClientError(f"invalid register_child response: {exc}") from exc

    def unregister_child(self, child_uid: str) -> None:
        """Unregister a child host from this parent."""
        self._request("DELETE", f"{ENDPOINT.CHILDREN}/{child_uid}")

    def entity_list(self) -> list[EntityCard]:
        """List all entities on this host (local only)."""
        response = self._request("GET", ENDPOINT.ENTITIES)
        data = self._extract_data_field(
            response, context="entity list", expected_type=list
        )

        entities: list[EntityCard] = []
        for i, entity_data in enumerate(data):
            if not isinstance(entity_data, dict):
                raise HostClientError(
                    f"entity list item at index {i} is not an object"
                )
            try:
                entities.append(EntityCard(**entity_data))
            except Exception as exc:
                raise HostClientError(
                    f"invalid entity list item at index {i}: {exc}"
                ) from exc

        return entities

    def entity_search(
        self,
        query: str | None = None,
        uid: str | None = None,
        name: str | None = None,
        address: str | None = None,
    ) -> list[EntityCard]:
        """Search for public entities across the network (includes parent/children)."""
        try:
            response = self._request("GET", ENDPOINT.ENTITY_DISCOVER)
            data = self._extract_data_field(
                response, context="entity discover", expected_type=list
            )
            public_entities: list[EntityCard] = []
            for i, entity_data in enumerate(data):
                if not isinstance(entity_data, dict):
                    raise HostClientError(
                        f"entity discover item at index {i} is not an object"
                    )
                try:
                    public_entities.append(EntityCard(**entity_data))
                except Exception as exc:
                    raise HostClientError(
                        f"invalid entity discover item at index {i}: {exc}"
                    ) from exc
        except HostClientError:
            public_entities = self.get_wellknown().public_entities

        # Priority order: address > uid > name > query > all
        if address:
            return [
                entity
                for entity in public_entities
                if f"{entity.host_uid}:{entity.entity_uid}" == address
            ]

        if uid:
            return [entity for entity in public_entities if entity.entity_uid == uid]

        if name:
            name_lower = name.lower()
            return [
                entity
                for entity in public_entities
                if name_lower in entity.name.lower()
            ]

        if query:
            query_lower = query.lower()
            return [
                entity
                for entity in public_entities
                if (
                    query_lower in entity.entity_uid.lower()
                    or query_lower in entity.name.lower()
                    or query_lower in entity.address.lower()
                    or query_lower in f"{entity.host_uid}:{entity.entity_uid}".lower()
                )
            ]

        return public_entities

    def entity_friends(self, entity_uid: str) -> list[EntityCard]:
        """Get one entity's friends on target host."""
        response = self._request("GET", ENDPOINT.ENTITY_FRIENDS.format(entity_uid=entity_uid))
        data = self._extract_data_field(
            response, context="entity friends", expected_type=list
        )

        friends: list[EntityCard] = []
        for i, friend in enumerate(data):
            if not isinstance(friend, dict):
                raise HostClientError(
                    f"entity friends item at index {i} is not an object"
                )
            try:
                friends.append(EntityCard(**friend))
            except Exception as exc:
                raise HostClientError(
                    f"invalid entity friends item at index {i}: {exc}"
                ) from exc

        return friends

    def check_health(self) -> HealthResponse:
        """Call host health endpoint and parse HealthResponse."""
        response = self._request("GET", ENDPOINT.HEALTH)

        # Compatible with both direct HealthResponse payload and
        # StandardResponse[HealthResponse] wrapper.
        health_payload = response.get("data")
        if not isinstance(health_payload, dict):
            health_payload = response

        try:
            return HealthResponse(**health_payload)
        except Exception as exc:
            raise HostClientError(f"invalid health response: {exc}") from exc

    def entity_delete(self, entity_uid: str) -> dict[str, Any]:
        """Delete an entity from the host."""
        return self._request("DELETE", ENDPOINT.ENTITY_DETAIL.format(entity_uid=entity_uid))

    def entity_update(
        self,
        entity_uid: str,
        update_request: EntityUpdateRequest,
    ) -> EntityCard:
        """Update an entity's configuration."""
        response = self._request(
            "POST",
            ENDPOINT.ENTITY_DETAIL.format(entity_uid=entity_uid),
            payload=update_request.model_dump(exclude_none=True),
        )
        data = self._extract_data_field(
            response, context="entity update", expected_type=dict
        )

        try:
            return EntityCard(**data)
        except Exception as exc:
            raise HostClientError(f"invalid entity update response: {exc}") from exc

    def host_update(self, update_request: HostUpdateRequest) -> HostUpdateResponse:
        """Update host configuration."""
        data: dict[str, Any] = {"host_name": update_request.host_name}
        messages: list[str] = []

        if update_request.parent_url:
            response = self._request(
                "POST",
                ENDPOINT.PARENT,
                payload={"parent_url": update_request.parent_url},
            )
            parent_data = self._extract_data_field(
                response, context="set parent", expected_type=dict
            )
            data["parent"] = parent_data
            message = response.get("message")
            if isinstance(message, str) and message:
                messages.append(message)
            else:
                messages.append("Parent set successfully")

        unsupported_fields: list[str] = []
        if update_request.bind_host is not None:
            unsupported_fields.append("bind_host")
        if update_request.port is not None:
            unsupported_fields.append("port")
        if update_request.set_default:
            unsupported_fields.append("set_default")

        if unsupported_fields:
            data["unsupported_fields"] = unsupported_fields
            messages.append(
                "Ignored unsupported fields on remote host API: "
                + ", ".join(unsupported_fields)
            )

        if not messages:
            raise HostClientError("No host update options were provided")

        return HostUpdateResponse(
            success=True,
            message="; ".join(messages),
            data=data,
        )

    def send_mail(self, mail: Mail) -> dict[str, Any]:
        """Send mail to host for routing."""
        return self._request("POST", ENDPOINT.SEND_MAIL, payload=mail.to_dict())

    def entity_register(
        self,
        kind: str,
        name: str | None = None,
        is_private: bool = False,
        description: str = "",
        provider: str | None = None,
        workdir: str | None = None,
    ) -> EntityCard:
        """Register a new entity on the host."""
        payload: dict[str, Any] = {
            "kind": kind,
            "is_public": not is_private,
            "description": description,
        }
        if name is not None:
            payload["name"] = name
        if provider is not None:
            payload["provider"] = provider
        if workdir is not None:
            payload["workdir"] = workdir

        response = self._request(
            "POST",
            ENDPOINT.ENTITIES,
            payload=payload,
        )
        data = self._extract_data_field(response, context="entity_register", expected_type=dict)
        try:
            return EntityCard(**data)
        except Exception as exc:
            raise HostClientError(f"invalid entity_register response: {exc}") from exc

    def friend_add(
        self,
        from_entity: str,
        to_address: str,
        text: str | None = None,
    ) -> dict[str, Any]:
        """Send a friend request via host-side Entity.send_message."""
        payload: dict[str, Any] = {
            "from_entity": from_entity,
            "to_address": to_address,
        }
        if text is not None:
            payload["text"] = text
        response = self._request("POST", ENDPOINT.FRIEND_ADD, payload=payload)
        return self._extract_data_field(
            response,
            context="friend add",
            expected_type=dict,
        )

    def friend_delete(
        self,
        from_entity: str,
        friend_uid: str,
    ) -> dict[str, Any]:
        """Remove a friend from entity's friend list (one-sided)."""
        payload: dict[str, Any] = {
            "from_entity": from_entity,
            "friend_uid": friend_uid,
        }
        response = self._request("POST", ENDPOINT.FRIEND_DELETE, payload=payload)
        return self._extract_data_field(
            response,
            context="friend delete",
            expected_type=dict,
        )

    def start_ui(self, port: int) -> StandardResponse[dict[str, Any]]:
        """Start web UI on specified port."""
        response = self._request("POST", ENDPOINT.START_UI, payload={"port": port})
        try:
            return StandardResponse(**response)
        except Exception as exc:
            raise HostClientError(f"invalid start_ui response: {exc}") from exc

    def stop_ui(self) -> StandardResponse[dict[str, Any]]:
        """Stop web UI server."""
        response = self._request("POST", ENDPOINT.STOP_UI)
        try:
            return StandardResponse(**response)
        except Exception as exc:
            raise HostClientError(f"invalid stop_ui response: {exc}") from exc

    def send_message(
        self,
        from_entity: str,
        to_address: str,
        text: str,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        """Send text message from entity to address."""
        payload: dict[str, Any] = {
            "from_entity": from_entity,
            "to_address": to_address,
            "text": text,
        }
        if session_id is not None:
            payload["session_id"] = session_id

        response = self._request(
            "POST",
            "/api/v1/messages/send",
            payload=payload,
        )
        return self._extract_data_field(
            response,
            context="send message",
            expected_type=dict,
        )

    def create_group_session(
        self,
        entity_uid: str,
        name: str,
        members: list[str],
        member_roles: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Create a group session for an entity."""
        response = self._request(
            "POST",
            f"/api/v1/entities/{entity_uid}/sessions/groups",
            payload={
                "name": name,
                "members": members,
                "member_roles": member_roles or {},
            },
        )
        return self._extract_data_field(
            response,
            context="create group session",
            expected_type=dict,
        )

    def list_group_sessions(self, entity_uid: str) -> list[dict[str, Any]]:
        """List group sessions for an entity."""
        response = self._request(
            "GET",
            f"/api/v1/entities/{entity_uid}/sessions/groups",
        )
        return self._extract_data_field(
            response,
            context="list group sessions",
            expected_type=list,
        )

    def add_group_members(
        self,
        entity_uid: str,
        session_id: str,
        members: list[str],
        member_roles: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Invite members into a group session."""
        response = self._request(
            "POST",
            f"/api/v1/entities/{entity_uid}/sessions/groups/{session_id}/members",
            payload={
                "members": members,
                "member_roles": member_roles or {},
            },
        )
        return self._extract_data_field(
            response,
            context="add group members",
            expected_type=dict,
        )

    def remove_group_member(
        self,
        entity_uid: str,
        session_id: str,
        member: str,
    ) -> dict[str, Any]:
        """Remove one member from a group session."""
        response = self._request(
            "POST",
            f"/api/v1/entities/{entity_uid}/sessions/groups/{session_id}/members/remove",
            payload={"member": member},
        )
        return self._extract_data_field(
            response,
            context="remove group member",
            expected_type=dict,
        )

    def delete_group_session(self, entity_uid: str, session_id: str) -> dict[str, Any]:
        """Delete a group session."""
        response = self._request(
            "DELETE",
            f"/api/v1/entities/{entity_uid}/sessions/groups/{session_id}",
        )
        return self._extract_data_field(
            response,
            context="delete group session",
            expected_type=dict,
        )

    def send_group_message(
        self,
        from_entity: str,
        session_id: str,
        text: str,
    ) -> dict[str, Any]:
        """Send text message to a group session."""
        response = self._request(
            "POST",
            "/api/v1/messages/send_group",
            payload={
                "from_entity": from_entity,
                "session_id": session_id,
                "text": text,
            },
        )
        return self._extract_data_field(
            response,
            context="send group message",
            expected_type=dict,
        )

    # ==================== Trade ====================

    def trade_send(
        self,
        from_entity: str,
        kind: str,
        payload: dict[str, Any],
        to_entity: str | None = None,
    ) -> dict[str, Any]:
        """Send a trade message. If to_entity is given, send to that friend; else to Arbiter."""
        body: dict[str, Any] = {"from_entity": from_entity, "kind": kind, "payload": payload}
        if to_entity is not None:
            body["to_entity"] = to_entity
        response = self._request("POST", ENDPOINT.TRADE_SEND, payload=body)
        return self._extract_data_field(response, context="trade send", expected_type=dict)

    def trade_contracts(self) -> list[dict[str, Any]]:
        """List all contracts."""
        response = self._request("GET", ENDPOINT.TRADE_CONTRACTS)
        return self._extract_data_field(response, context="trade contracts", expected_type=list)

    def trade_contract(self, contract_id: str) -> dict[str, Any]:
        """Get contract details."""
        response = self._request(
            "GET", ENDPOINT.TRADE_CONTRACT_DETAIL.format(contract_id=contract_id)
        )
        return self._extract_data_field(response, context="trade contract", expected_type=dict)

    def trade_payments(self) -> list[dict[str, Any]]:
        """List all payments."""
        response = self._request("GET", ENDPOINT.TRADE_PAYMENTS)
        return self._extract_data_field(response, context="trade payments", expected_type=list)

    def trade_balance(self, entity_spec: str) -> dict[str, Any]:
        """Query entity balance on the Arbiter's ledger."""
        response = self._request(
            "GET", ENDPOINT.TRADE_BALANCE.format(entity_spec=entity_spec)
        )
        return self._extract_data_field(response, context="trade balance", expected_type=dict)

    # ==================== Market ====================

    def market_publish(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Publish a new market order."""
        response = self._request("POST", ENDPOINT.MARKET_ORDERS, payload=payload)
        return self._extract_data_field(response, context="market publish", expected_type=dict)

    def market_get(self, order_id: str) -> dict[str, Any]:
        """Get a single market order by ID."""
        url = ENDPOINT.MARKET_ORDER_DETAIL.format(order_id=order_id)
        response = self._request("GET", url)
        return self._extract_data_field(response, context="market get", expected_type=dict)

    def market_list(
        self,
        order_type: str | None = None,
        status: str | None = None,
        publisher: str | None = None,
        category: str | None = None,
        trade_mode: str | None = None,
    ) -> list[dict[str, Any]]:
        """List market orders with optional filters."""
        params: list[str] = []
        if order_type:
            params.append(f"type={order_type}")
        if status:
            params.append(f"status={status}")
        if publisher:
            params.append(f"publisher={publisher}")
        if category:
            params.append(f"category={category}")
        if trade_mode:
            params.append(f"trade_mode={trade_mode}")
        qs = f"?{'&'.join(params)}" if params else ""
        response = self._request("GET", f"{ENDPOINT.MARKET_ORDERS}{qs}")
        return self._extract_data_field(response, context="market list", expected_type=list)

    def market_archive(self, order_id: str, requester: str) -> dict[str, Any]:
        """Archive a market order."""
        url = ENDPOINT.MARKET_ORDER_ARCHIVE.format(order_id=order_id)
        response = self._request("POST", f"{url}?requester={requester}")
        return self._extract_data_field(response, context="market archive", expected_type=dict)

    def market_delete(self, order_id: str, requester: str) -> dict[str, Any]:
        """Delete a market order."""
        url = ENDPOINT.MARKET_ORDER_DETAIL.format(order_id=order_id)
        response = self._request("DELETE", f"{url}?requester={requester}")
        return self._extract_data_field(response, context="market delete", expected_type=dict)
