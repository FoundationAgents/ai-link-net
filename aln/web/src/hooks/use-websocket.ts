/* WebSocket connection hook for real-time messaging. */

import { useCallback, useEffect, useRef } from "react";

import { wsBaseUrl } from "@/api";
import { extractEntityUid } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import type { CarbonCopyMessage, Message, MessagePayload, MessageStatus } from "@/types";

const HEARTBEAT_MS = 20_000;
const RECONNECT_MS = 3_000;

export interface WsEvent {
  type: "new_message" | "delivery_status" | "status_update" | "carbon_copy";
  message?: Message;
  messageId?: string;
  mailId?: string;
  status?: MessageStatus;
  recipient?: string;
  reason?: string;
  carbonCopy?: CarbonCopyMessage;
}

export type WsEventListener = (event: WsEvent) => void;

export function useWebSocket() {
  const currentUser = useAppStore((s) => s.currentUser);
  const addUnreadMessage = useAppStore((s) => s.addUnreadMessage);
  const addCarbonCopy = useAppStore((s) => s.addCarbonCopy);
  const activeChatUid = useAppStore((s) => s.activeChatUid);
  const forgetCurrentUser = useAppStore((s) => s.forgetCurrentUser);
  const touchContactActivity = useAppStore((s) => s.touchContactActivity);

  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const aliveRef = useRef(true);
  const listenersRef = useRef<Set<WsEventListener>>(new Set<WsEventListener>());
  const activeChatRef = useRef(activeChatUid);

  useEffect(() => {
    activeChatRef.current = activeChatUid;
  }, [activeChatUid]);

  const addListener = useCallback((fn: WsEventListener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const handleMissingEntity = useCallback(() => {
    clearTimeout(reconnectRef.current);
    clearInterval(heartbeatRef.current);
    forgetCurrentUser();
  }, [forgetCurrentUser]);

  const connect = useCallback(() => {
    if (!currentUser) return;

    const base = wsBaseUrl();
    const url = `${base}api/v1/ws/messages/${currentUser.entity_uid}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, HEARTBEAT_MS);
    };

    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data as string) as Record<string, unknown>;
        if (raw.type === "pong") return;

        if (raw.type === "entity_not_found") {
          handleMissingEntity();
          return;
        }

        const wsData = raw.data as Record<string, unknown> | undefined;

        if (raw.type === "new_message" && wsData) {
          const kind = String(wsData.kind ?? "");
          const payloadRaw = wsData.payload as Record<string, unknown> | undefined;

          // Handle CarbonCopy messages specially
          if (kind === "carbon_copy" && payloadRaw) {
            const rawTs = String(payloadRaw.timestamp ?? wsData.timestamp ?? "");
            const cc: CarbonCopyMessage = {
              id: String(wsData.message_id ?? `cc-${Date.now()}`),
              originalMessageId: payloadRaw.original_message_id as string | undefined,
              direction: (payloadRaw.direction as "inbound" | "outbound") ?? "inbound",
              originalSender: String(payloadRaw.original_sender ?? ""),
              originalSenderName: payloadRaw.original_sender_name as string | undefined,
              originalRecipient: String(payloadRaw.original_recipient ?? ""),
              originalRecipientName: payloadRaw.original_recipient_name as string | undefined,
              messageKind: String(payloadRaw.original_kind ?? ""),
              payload: { text: String(payloadRaw.summary ?? "") },
              originalPayload: payloadRaw.original_payload as Record<string, unknown> | undefined,
              timestamp: rawTs.endsWith("Z") || rawTs.includes("+") ? rawTs : rawTs + "Z",
            };
            addCarbonCopy(cc);
            const wsEvent: WsEvent = { type: "carbon_copy", carbonCopy: cc };
            listenersRef.current.forEach((fn) => fn(wsEvent));
            return;
          }

          // Normal message
          const msg: Message = {
            message_id: String(wsData.message_id ?? ""),
            mail_id: wsData.mail_id ? String(wsData.mail_id) : undefined,
            kind: kind || undefined,
            sender: String(wsData.sender ?? ""),
            recipient: (wsData.recipient as string[]) ?? [],
            payload: (payloadRaw ?? { text: "" }) as unknown as MessagePayload,
            metadata: wsData.metadata as Record<string, unknown> | undefined,
            conversation_type: wsData.conversation_type as string | null | undefined,
            group_id: wsData.group_id as string | null | undefined,
            timestamp: String(wsData.timestamp ?? ""),
            status: (wsData.status as MessageStatus) ?? "received",
            session_id: payloadRaw?.session_id as string | undefined,
          };

          const wsEvent: WsEvent = { type: "new_message", message: msg };
          listenersRef.current.forEach((fn) => fn(wsEvent));

          const isGroupMessage =
            msg.conversation_type === "group" ||
            Boolean(msg.group_id) ||
            msg.metadata?.conversation_type === "group";
          if (isGroupMessage) return;

          const senderUid = extractEntityUid(msg.sender);
          const recipientUids = msg.recipient.map(extractEntityUid);
          const isFromCurrentUser = senderUid === currentUser.entity_uid;
          const contactUid = isFromCurrentUser
            ? recipientUids.find((uid) => uid !== currentUser.entity_uid) ?? null
            : senderUid;

          if (contactUid) {
            touchContactActivity(contactUid);
          }

          if (!isFromCurrentUser && contactUid && contactUid !== activeChatRef.current) {
            addUnreadMessage(contactUid, msg.message_id, msg.payload.text ?? "");
          }
        }

        if (raw.type === "delivery_status" && wsData) {
          const wsEvent: WsEvent = {
            type: "delivery_status",
            messageId: String(wsData.message_id ?? ""),
            status: String(wsData.status ?? "") as MessageStatus,
            recipient: String(wsData.recipient ?? ""),
            reason: wsData.reason ? String(wsData.reason) : undefined,
          };
          listenersRef.current.forEach((fn) => fn(wsEvent));
        }

        if (raw.type === "status_update" && wsData) {
          const wsEvent: WsEvent = {
            type: "status_update",
            mailId: String(wsData.mail_id ?? ""),
            status: String(wsData.status ?? "") as MessageStatus,
          };
          listenersRef.current.forEach((fn) => fn(wsEvent));
        }
      } catch {
        /* ignore parse errors */
      }
    };

    ws.onclose = (event) => {
      clearInterval(heartbeatRef.current);
      if (event.code === 1008 && event.reason.includes("Entity not found")) {
        handleMissingEntity();
        return;
      }
      if (aliveRef.current && event.code !== 1008) {
        reconnectRef.current = setTimeout(connect, RECONNECT_MS);
      }
    };

    ws.onerror = () => ws.close();
  }, [currentUser, addUnreadMessage, addCarbonCopy, touchContactActivity, handleMissingEntity]);

  useEffect(() => {
    aliveRef.current = true;
    connect();
    return () => {
      aliveRef.current = false;
      clearTimeout(reconnectRef.current);
      clearInterval(heartbeatRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return { addListener };
}
