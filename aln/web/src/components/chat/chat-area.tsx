/* Chat conversation area — message list + input + session history. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Camera,
  Send,
  Loader2,
  MoreVertical,
  UserMinus,
  History,
  Inbox,
  Plus,
} from "lucide-react";

import { cn, extractEntityUid, normalizeTimestamp } from "@/lib/utils";
import {
  createSession,
  deleteFriend,
  getMessages,
  listSessions,
  markMessagesRead,
  sendMessage,
  uploadAvatar,
} from "@/api";
import type { MailboxMessage } from "@/api";
import { useAppStore } from "@/stores/app";
import { useWsListener } from "@/providers/websocket-provider";
import type { WsEvent } from "@/hooks/use-websocket";
import { Button } from "@/components/ui/button";
import { PixelAvatar } from "@/components/ui/pixel-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageItem } from "./message-item";
import { SessionDialog } from "./session-panel";
import { CarbonCopyPanel } from "./carbon-copy-panel";
import type { CarbonCopyMessage, Contact, Message, MessagePayload } from "@/types";

interface ChatAreaProps {
  contact: Contact;
  onBack?: () => void;
}

function isImplicitSessionId(sessionId: string | null): boolean {
  return /^[a-f0-9]{16}$/i.test(sessionId ?? "");
}

/** Convert mailbox record to display Message, preserving mail_id. */
function toMessage(m: MailboxMessage): Message | null {
  const payload = m.payload as Record<string, unknown>;

  // CarbonCopy messages are handled by the sidebar panel, skip here
  if (payload?.original_sender || payload?.original_recipient) return null;

  return {
    message_id: m.message_id,
    mail_id: m.mail_id,
    kind: m.kind,
    sender: m.sender,
    recipient: m.recipient,
    payload: {
      ...payload,
      text: String(payload?.text ?? ""),
    } as MessagePayload,
    timestamp: normalizeTimestamp(m.timestamp),
    status: m.status as Message["status"],
    session_id: payload?.session_id as string | undefined,
  };
}

/** Extract CarbonCopy messages from mailbox records. */
function extractCarbonCopies(mailbox: MailboxMessage[]): CarbonCopyMessage[] {
  return mailbox
    .filter((m) => {
      const p = m.payload as Record<string, unknown>;
      return p?.original_sender || p?.original_recipient;
    })
    .map((m) => {
      const p = m.payload as Record<string, unknown>;
      return {
        id: m.message_id,
        originalMessageId: p.original_message_id as string | undefined,
        direction: (p.direction as "inbound" | "outbound") ?? "inbound",
        originalSender: String(p.original_sender ?? ""),
        originalSenderName: p.original_sender_name as string | undefined,
        originalRecipient: String(p.original_recipient ?? ""),
        originalRecipientName: p.original_recipient_name as string | undefined,
        messageKind: String(p.original_kind ?? ""),
        payload: { text: String(p.summary ?? "") },
        originalPayload: p.original_payload as Record<string, unknown> | undefined,
        timestamp: normalizeTimestamp(m.timestamp) ?? String(m.timestamp),
      };
    });
}

export function ChatArea({ contact, onBack }: ChatAreaProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const currentHostUid = useAppStore((s) => s.currentHostUid);
  const contacts = useAppStore((s) => s.contacts);
  const clearUnread = useAppStore((s) => s.clearUnread);
  const refreshContact = useAppStore((s) => s.refreshContact);
  const avatarCache = useAppStore((s) => s.avatarCache);
  const fetchAndCacheAvatar = useAppStore((s) => s.fetchAndCacheAvatar);
  const contactSessionMap = useAppStore((s) => s.contactSessionMap);
  const setContactSession = useAppStore((s) => s.setContactSession);
  const carbonCopyMessages = useAppStore((s) => s.carbonCopyMessages);
  const ccLastViewedAt = useAppStore((s) => s.ccLastViewedAt);
  const loadCarbonCopies = useAppStore((s) => s.loadCarbonCopies);
  const markCcViewed = useAppStore((s) => s.markCcViewed);
  const { addListener } = useWsListener();

  // Use fresh contact data from store (fixes name not updating after edit)
  const freshContact = contacts.find((c) => c.entity_uid === contact.entity_uid) ?? contact;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [showSessionHistory, setShowSessionHistory] = useState(false);
  const [showCcPanel, setShowCcPanel] = useState(false);
  const [creatingSess, setCreatingSess] = useState(false);
  const justCreatedSessionRef = useRef<string | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const prevContactUidRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);
  const contactUid = extractEntityUid(contact.entity_uid);
  const hasContactSessionChoice = Object.prototype.hasOwnProperty.call(
    contactSessionMap,
    contactUid,
  );
  const rawActiveSessionId = contactSessionMap[contactUid] ?? null;

  const getViewport = useCallback((): HTMLElement | null => {
    return scrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']",
    ) ?? null;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const viewport = getViewport();
    if (!viewport) return;
    if (behavior === "auto") {
      viewport.scrollTop = viewport.scrollHeight;
      return;
    }
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, [getViewport]);

  // #5: human-to-human detection — no session management
  const isHumanToHuman =
    currentUser?.kind === "human" && contact.kind === "human";
  const isLocalEntity = currentHostUid != null && freshContact.host_uid === currentHostUid;
  const contactProvider =
    typeof freshContact.metadata?.provider === "string"
      ? freshContact.metadata.provider
      : undefined;

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await uploadAvatar(freshContact.entity_uid, file);
      await fetchAndCacheAvatar(freshContact.entity_uid);
      await refreshContact(freshContact.entity_uid);
    } catch { /* ignore */ }
  }

  // Hidden implicit sessions maintain backend continuity but should not become a visible filter.
  const activeSessionId =
    !isHumanToHuman && isImplicitSessionId(rawActiveSessionId)
      ? null
      : rawActiveSessionId;
  const setActiveSessionId = useCallback(
    (sessionId: string | null) => setContactSession(contactUid, sessionId),
    [contactUid, setContactSession],
  );

  useEffect(() => {
    if (!isHumanToHuman && rawActiveSessionId && isImplicitSessionId(rawActiveSessionId)) {
      setContactSession(contactUid, null);
    }
  }, [contactUid, isHumanToHuman, rawActiveSessionId, setContactSession]);

  useEffect(() => {
    if (isHumanToHuman || !currentUser || hasContactSessionChoice) return;

    let cancelled = false;
    listSessions(currentUser.entity_uid, contactUid)
      .then((sessions) => {
        const latestSession = sessions.find(
          (session) => !isImplicitSessionId(session.session_id),
        );
        if (!cancelled && latestSession) {
          setContactSession(contactUid, latestSession.session_id);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [
    contactUid,
    currentUser,
    hasContactSessionChoice,
    isHumanToHuman,
    setContactSession,
  ]);

  // refresh contact display info when selected (#10)
  useEffect(() => {
    refreshContact(contactUid);
  }, [contactUid, refreshContact]);

  // fetch avatar on entering chat if has_avatar but not cached
  useEffect(() => {
    if (freshContact.has_avatar && !avatarCache[contactUid]) {
      fetchAndCacheAvatar(contactUid);
    }
  }, [contactUid, freshContact.has_avatar, avatarCache, fetchAndCacheAvatar]);

  // load history when contact changes
  useEffect(() => {
    if (!currentUser) return;
    setLoadingHistory(true);
    setMessages([]);

    getMessages(currentUser.entity_uid)
      .then((mailbox) => {
        // Load CC messages into sidebar store
        const ccMsgs = extractCarbonCopies(mailbox);
        if (ccMsgs.length > 0) loadCarbonCopies(ccMsgs);

        const relevant = mailbox.filter((m) => {
          const senderUid = extractEntityUid(m.sender);
          const recipientUids = m.recipient.map(extractEntityUid);
          const payload = m.payload as Record<string, unknown>;

          // For CarbonCopy messages, route by direction:
          // CarbonCopy messages are handled by the sidebar panel
          if (payload?.original_sender || payload?.original_recipient) return false;

          // For regular messages, check sender and recipient
          return senderUid === contactUid || recipientUids.includes(contactUid);
        });

        const msgs = relevant.map(toMessage).filter((m): m is Message => m !== null);

        setMessages(msgs);

        // mark unread inbound messages as read (#20)
        const unreadIds = relevant
          .filter((m) => m.direction === "inbound" && !m.is_read)
          .map((m) => m.message_id);
        if (unreadIds.length > 0) {
          markMessagesRead(currentUser.entity_uid, unreadIds).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setLoadingHistory(false));
  }, [currentUser, contactUid]);

  // clear unread when viewing this contact
  useEffect(() => {
    clearUnread(contactUid);
  }, [contactUid, clearUnread]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    justCreatedSessionRef.current = null;
  }, [contactUid]);

  useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;

    const handleScroll = () => {
      const distanceToBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      shouldStickToBottomRef.current = distanceToBottom < 24;
    };

    handleScroll();
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [getViewport, messages.length, loadingHistory]);

  useEffect(() => {
    const viewport = getViewport();
    const messageList = messageListRef.current;
    if (!viewport || !messageList) return;

    const observer = new ResizeObserver(() => {
      if (!shouldStickToBottomRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(messageList);
    return () => observer.disconnect();
  }, [getViewport, contactUid]);

  // listen for WebSocket events
  useEffect(() => {
    return addListener((event: WsEvent) => {
      if (event.type === "new_message" && event.message) {
        const msg = event.message;
        const senderUid = extractEntityUid(msg.sender);
        const recipientUids = msg.recipient.map(extractEntityUid);

        if (senderUid === contactUid || recipientUids.includes(contactUid)) {
          if (msg.session_id && msg.session_id === justCreatedSessionRef.current) {
            justCreatedSessionRef.current = null;
          }

          setMessages((prev) => {
            // #14: dedup — try matching by message_id first
            if (prev.some((m) => m.message_id === msg.message_id)) {
              return prev.map((m) =>
                m.message_id === msg.message_id ? { ...m, ...msg } : m,
              );
            }

            // #14: for self-sent messages, match optimistic by text + timestamp proximity
            const isFromSelf =
              extractEntityUid(msg.sender) === currentUser?.entity_uid ||
              msg.sender === currentUser?.entity_uid;
            if (isFromSelf) {
              const now = Date.now();
              const idx = prev.findIndex(
                (m) =>
                  m.message_id.startsWith("tmp-") &&
                  m.payload.text === msg.payload.text &&
                  Math.abs(now - new Date(m.timestamp ?? "").getTime()) < 5000,
              );
              if (idx !== -1) {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], ...msg };
                return updated;
              }
            }

            return [...prev, msg];
          });
          clearUnread(contactUid);
        }
      }

      // #2: status_update matches by mail_id
      if (event.type === "status_update" && event.mailId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.mail_id === event.mailId
              ? { ...m, status: event.status }
              : m,
          ),
        );
      }

      // delivery_status matches by message_id
      if (event.type === "delivery_status" && event.messageId) {
        const deliveryToStatus: Record<string, Message["status"]> = {
          delivered: "received",
          queued: "queued",
          failed: "failed",
        };
        const newStatus = deliveryToStatus[event.status ?? ""] ?? event.status;
        setMessages((prev) =>
          prev.map((m) =>
            m.message_id === event.messageId
              ? { ...m, status: newStatus as Message["status"] }
              : m,
          ),
        );
      }

      // auto-open CC panel on new carbon_copy event for this contact
      if (event.type === "carbon_copy" && event.carbonCopy) {
        const cc = event.carbonCopy;
        const sUid = extractEntityUid(cc.originalSender);
        const rUid = extractEntityUid(cc.originalRecipient);
        if (sUid === contactUid || rUid === contactUid) {
          setShowCcPanel(true);
        }
      }

    });
  }, [contactUid, addListener, clearUnread, currentUser]);

  // Keep chat pinned to the bottom. Contact switch/history load jump immediately;
  // newly appended messages still use smooth scrolling.
  useLayoutEffect(() => {
    if (loadingHistory) return;
    const isContactChanged = prevContactUidRef.current !== contactUid;
    prevContactUidRef.current = contactUid;
    const prevMessageCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    const behavior = isContactChanged || messages.length <= prevMessageCount ? "auto" : "smooth";
    scrollToBottom(behavior);
  }, [contactUid, loadingHistory, messages, scrollToBottom]);

  // #8: filter displayed messages by session (unless human-to-human)
  // show messages matching active session + untagged messages (replies without session_id)
  // hide messages explicitly tagged with a different session
  const displayMessages = isHumanToHuman || !activeSessionId
    ? messages
    : messages.filter((m) => !m.session_id || m.session_id === activeSessionId);

  const paymentStates = new Map<string, "pending" | "claimed" | "completed">();
  const respondedApprovalIds = new Map<string, { action: string; inputData?: string }>();

  function resolvePaymentState(kind: string | undefined): "pending" | "claimed" | "completed" | null {
    if (kind === "pay_collect" || kind === "pay_request") return "pending";
    if (kind === "pay_claim_completed") return "claimed";
    if (kind === "pay_completed") return "completed";
    return null;
  }

  for (const m of displayMessages) {
    const p = m.payload as Record<string, unknown>;
    const kind = m.kind;
    if (kind === "approval_response") {
      const rid = p?.request_id;
      if (typeof rid === "string") respondedApprovalIds.set(rid, {
        action: (p?.action as string) ?? "approve",
        inputData: (p?.input_data as string) ?? undefined,
      });
    }
    const pid = p?.payment_id as string | undefined;
    if (!pid) continue;
    const paymentState = resolvePaymentState(kind);
    if (paymentState) paymentStates.set(pid, paymentState);
  }

  const handleSend = useCallback(async () => {
    if (!input.trim() || !currentUser || sending) return;

    const text = input.trim();
    setInput("");
    setSending(true);

    // #7: include session_id in optimistic message payload
    const sessionId = isHumanToHuman ? undefined : activeSessionId ?? undefined;
    const tmpId = `tmp-${Date.now()}`;
    const optimistic: Message = {
      message_id: tmpId,
      sender: currentUser.entity_uid,
      recipient: [contact.entity_uid],
      payload: { text },
      timestamp: new Date().toISOString(),
      status: "sent",
      session_id: sessionId,
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const address = contact.address?.address ?? contact.entity_uid;
      const res = await sendMessage(currentUser.entity_uid, address, { text }, sessionId);

      setMessages((prev) =>
        prev.map((m) =>
          m.message_id === tmpId
            ? {
                ...m,
                message_id: res.message_id,
                mail_id: res.mail_id,
                status: res.delivery_status === "sent" ? "delivering" : "queued",
              }
            : m,
        ),
      );
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.message_id === tmpId ? { ...m, status: "failed" } : m,
        ),
      );
    } finally {
      setSending(false);
    }
  }, [input, currentUser, contact, sending, activeSessionId, isHumanToHuman]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 128) + "px";
  }

  const currentUid = currentUser?.entity_uid ?? "";

  async function handleNewSession() {
    if (!currentUser || creatingSess) return;
    setCreatingSess(true);
    try {
      const session = await createSession(currentUser.entity_uid, contactUid);
      justCreatedSessionRef.current = session.session_id;
      setActiveSessionId(session.session_id);
    } catch {
      /* ignore */
    } finally {
      setCreatingSess(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      {/* Session history dialog */}
      {!isHumanToHuman && currentUser && (
        <SessionDialog
          open={showSessionHistory}
          onOpenChange={setShowSessionHistory}
          entityUid={currentUser.entity_uid}
          contactUid={contactUid}
          activeSessionId={activeSessionId}
          onSelectSession={setActiveSessionId}
        />
      )}

      <div className={cn(
        "flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden",
        showCcPanel ? "hidden md:flex" : "flex",
      )}>
        {/* Header */}
        <header className="flex items-center gap-3 px-4 md:px-5 h-14 border-b border-border shrink-0">
          {onBack && (
            <button
              onClick={onBack}
              className="md:hidden flex items-center justify-center h-8 w-8 -ml-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div className="relative group shrink-0">
            <PixelAvatar
              name={freshContact.name}
              kind={freshContact.kind}
              provider={contactProvider}
              src={avatarCache[freshContact.entity_uid]}
              size="sm"
            />
            {isLocalEntity && (
              <label className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity">
                <Camera className="h-3.5 w-3.5 text-white" />
                <input type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} />
              </label>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold truncate">{freshContact.name}</h2>
            <p className="text-[11px] text-muted-foreground">{freshContact.kind}</p>
          </div>

          {/* CarbonCopy inbox toggle */}
          <button
            onClick={() => {
              setShowCcPanel((v) => {
                if (!v) markCcViewed();
                return !v;
              });
            }}
            className={cn(
              "relative h-8 w-8 flex items-center justify-center rounded-lg transition-colors",
              showCcPanel
                ? "text-primary bg-primary/10"
                : "text-muted-foreground hover:text-foreground hover:bg-surface-hover",
            )}
            title="CarbonCopy"
          >
            <Inbox className="h-4 w-4" />
            {(() => {
              const groups = new Map<string, boolean>();
              for (const cc of carbonCopyMessages) {
                const sUid = extractEntityUid(cc.originalSender);
                const rUid = extractEntityUid(cc.originalRecipient);
                if (!(sUid === contactUid || rUid === contactUid)) continue;
                if (new Date(cc.timestamp).getTime() <= ccLastViewedAt) continue;
                const key = cc.originalMessageId ?? cc.id;
                if (groups.has(key)) continue;
                groups.set(key, true);
              }
              const unread = groups.size;
              return unread > 0 ? (
                <span className="absolute -top-0.5 -right-0.5 h-3.5 min-w-[14px] rounded-full bg-destructive text-[9px] font-medium text-destructive-foreground flex items-center justify-center px-1">
                  {unread > 99 ? "99+" : unread}
                </span>
              ) : null;
            })()}
          </button>

          {/* Actions */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors">
                <MoreVertical className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {!isHumanToHuman && (
                <>
                  <DropdownMenuItem
                    onClick={handleNewSession}
                    disabled={creatingSess}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    {creatingSess ? "Creating Session..." : "New Session"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setShowSessionHistory(true)}
                  >
                    <History className="h-4 w-4 mr-2" />
                    Session History
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={async () => {
                  if (!currentUser) return;
                  await deleteFriend(currentUser.entity_uid, contact.entity_uid);
                  await useAppStore.getState().loadContacts();
                  onBack?.();
                }}
              >
                <UserMinus className="h-4 w-4 mr-2" />
                Remove Friend
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Messages */}
        <div ref={scrollAreaRef} className="min-h-0 flex-1">
        <ScrollArea className="min-h-0 h-full px-4 md:px-5">
          <div ref={messageListRef} className="py-4 space-y-3">
            {loadingHistory && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loadingHistory && displayMessages.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-16">
                Start a conversation with {freshContact.name}
              </p>
            )}
            {displayMessages.map((msg) => {
              const pid = (msg.payload as Record<string, unknown>)?.payment_id as string | undefined;
              const paymentState = pid ? paymentStates.get(pid) : undefined;
              return (
                <MessageItem
                  key={msg.message_id}
                  message={msg}
                  isSelf={
                    extractEntityUid(msg.sender) === currentUid ||
                    msg.sender === currentUid
                  }
                  selfEntityUid={currentUid}
                  paymentState={paymentState}
                  respondedApprovalIds={respondedApprovalIds}
                  animateOnMount={false}
                />
              );
            })}
          </div>
        </ScrollArea>
        </div>

        {/* Input */}
        <div className="px-4 md:px-5 pt-2 pb-3 border-t border-border shrink-0">
          <div
            className={cn(
              "flex items-end gap-2 rounded-xl bg-surface p-2",
              "border border-transparent",
              "focus-within:border-primary/20 transition-colors",
            )}
          >
            <textarea
              ref={(el) => { if (el) autoResize(el); }}
              value={input}
              onChange={(e) => { setInput(e.target.value); autoResize(e.target); }}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              className={cn(
                "flex-1 resize-none bg-transparent text-sm outline-none focus:outline-none",
                "placeholder:text-muted-foreground/40 max-h-32 overflow-y-auto",
              )}
            />
            <Button
              size="icon"
              className="h-8 w-8 rounded-lg shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={!input.trim() || sending}
              onClick={handleSend}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* CarbonCopy sidebar panel */}
      {showCcPanel && <CarbonCopyPanel contactUid={contactUid} onClose={() => setShowCcPanel(false)} />}
    </div>
  );
}
