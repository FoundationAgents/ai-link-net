/* API type definitions — mirrors backend schemas. */

export interface StandardResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
}

/* --- Entity --- */

export type EntityKind =
  | "agent"
  | "human"
  | "tool"
  | "resource"
  | "service"
  | "organization"
  | "arbiter";
export type EntityTag = "private" | "public" | "foreign";
export type OnlineStatus = "online" | "offline" | "deleted" | "unknown";

export interface EntityCard {
  entity_uid: string;
  host_uid: string;
  name: string;
  kind: EntityKind;
  address: { address: string };
  sign_public_key: string;
  encrypt_public_key: string;
  description: string;
  is_public: boolean;
  has_avatar: boolean;
  metadata?: { avatar_url?: string; [key: string]: unknown };
}

export interface Contact extends EntityCard {
  entity_tag?: EntityTag;
  online_status?: OnlineStatus;
}

/* --- Message & Mail --- */

export type MessageStatus =
  | "sent"
  | "delivering"
  | "queued"
  | "failed"
  | "received"
  | "processing"
  | "done";

export interface MessagePayload {
  text?: string;
  metadata?: Record<string, unknown>;
  sender_card?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ApprovalFlowSide = "outbound" | "inbound";
export type ApprovalFlowStatus = "pending" | "approved" | "rejected";
export type ApprovalAudience = "sender" | "recipient" | "self";

export interface ApprovalStatusPayload extends MessagePayload {
  request_id: string;
  original_kind: string;
  message: string;
  flow_side?: ApprovalFlowSide;
  status?: ApprovalFlowStatus;
  audience?: ApprovalAudience;
  original_preview?: string;
  decision?: string;
}

export interface Message {
  message_id: string;
  mail_id?: string;
  kind?: string;
  sender: string;
  recipient: string[];
  payload: MessagePayload;
  metadata?: Record<string, unknown>;
  conversation_type?: string | null;
  group_id?: string | null;
  timestamp?: string;
  status?: MessageStatus;
  session_id?: string;
}

/* --- Session --- */

export interface Session {
  id: string;
  name: string;
  created_at: number;
}

/* --- User Profile (localStorage) --- */

export interface UserProfile {
  entity_uid: string;
  name: string;
  kind: EntityKind;
  host_url: string;
  last_login?: string;
  metadata?: { avatar?: string; [key: string]: unknown };
}

/* --- Contact Unread --- */

export interface ContactUnreadInfo {
  entity_uid: string;
  unread_count: number;
  last_message: string;
  last_message_time: number;
}

/* --- Host --- */

export interface HostWellKnown {
  name: string;
  uid: string;
  url: string;
  public_entities: EntityCard[];
}

/* --- CarbonCopy --- */

export type CarbonCopyDirection = "inbound" | "outbound";

export interface CarbonCopyPayload {
  original_sender: string;
  original_sender_name?: string;
  original_recipient: string;
  original_recipient_name?: string;
  original_kind: string;
  original_message_id: string;
  direction: CarbonCopyDirection;
  timestamp: string;
  cost?: number;
  summary?: string;
  original_payload?: Record<string, unknown>;
}

export interface CarbonCopyMessage {
  id: string;
  originalMessageId?: string;
  direction: CarbonCopyDirection;
  originalSender: string;
  originalSenderName?: string;
  originalRecipient: string;
  originalRecipientName?: string;
  messageKind: string;
  payload: MessagePayload;
  originalPayload?: Record<string, unknown>;
  timestamp: string;
}
