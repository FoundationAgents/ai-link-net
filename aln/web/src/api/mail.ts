/* Message send & history API. */

import type { StandardResponse } from "@/types";
import { apiClient, unwrap } from "./client";

export interface SendMessageResponse {
  message_id: string;
  mail_id: string;
  from_entity_uid: string;
  to_address: string;
  session_id: string | null;
  delivery_status: "sent" | "offline" | "unreachable";
  warning: string | null;
  status: string;
}

export interface SendGroupMessageResponse {
  message_id: string;
  mail_id: string;
  from_entity_uid: string;
  session_id: string;
  group_name: string | null;
  recipient_count: number;
  recipients: Array<{
    address: string;
    entity_uid: string;
    host_uid: string;
  }>;
  status: string;
}

export interface MailboxMessage {
  message_id: string;
  mail_id: string;
  kind?: string;
  sender: string;
  recipient: string[];
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  conversation_type?: string | null;
  group_id?: string | null;
  timestamp: string;
  direction: "inbound" | "outbound";
  is_read: boolean;
  status: string;
}

export async function sendMessage(
  fromEntity: string,
  toAddress: string,
  payload: { text: string; metadata?: Record<string, unknown> },
  sessionId?: string,
): Promise<SendMessageResponse> {
  const { data } = await apiClient.post<StandardResponse<SendMessageResponse>>(
    "/messages/send",
    {
      from_entity: fromEntity,
      to_address: toAddress,
      text: payload.text,
      session_id: sessionId,
    },
  );
  return unwrap(data);
}

export async function sendGroupMessage(
  fromEntity: string,
  sessionId: string,
  text: string,
): Promise<SendGroupMessageResponse> {
  const { data } = await apiClient.post<StandardResponse<SendGroupMessageResponse>>(
    "/messages/send_group",
    {
      from_entity: fromEntity,
      session_id: sessionId,
      text,
    },
  );
  return unwrap(data);
}

export async function getMessages(
  entityUid: string,
  limit: number | null = null,
): Promise<MailboxMessage[]> {
  const { data } = await apiClient.get<StandardResponse<MailboxMessage[]>>(
    `/messages/${entityUid}`,
    { params: limit === null ? undefined : { limit } },
  );
  return data.data ?? [];
}

export async function markMessagesRead(
  entityUid: string,
  messageIds: string[],
): Promise<void> {
  await apiClient.post(`/messages/${entityUid}/mark_read`, {
    message_ids: messageIds,
  });
}
