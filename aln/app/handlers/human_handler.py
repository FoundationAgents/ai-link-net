"""Default handler for HUMAN entities."""

from __future__ import annotations

from loguru import logger

from aln.app.service.session_service import SessionService
from fp.handler import BaseHandler
from fp.message import Message


class HumanHandler(BaseHandler):
    """Human entities receive messages and notify web UI via host."""

    async def handle(self, message: Message) -> None:
        self._log_message(message, handler_name="HumanHandler")
        SessionService(self.entity).sync_group_session_from_message(message)
        await self.entity.host.push_to_web(self.entity.uid, message)
