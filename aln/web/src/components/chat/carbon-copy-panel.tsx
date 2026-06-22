/* CarbonCopy sidebar panel — displays CC messages from Zustand store (fed by WebSocket). */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Inbox, X } from "lucide-react";

import { listGroupSessions } from "@/api";
import type { SessionInfo } from "@/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, extractEntityUid } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import type { CarbonCopyMessage } from "@/types";
import { CarbonCopyItem } from "./message-item";

const MIN_WIDTH = 260;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;
const WIDTH_STORAGE_KEY = "fp_cc_panel_width";
const ALL_TAB_ID = "__all__";

interface CarbonCopyPanelProps {
  contactUid: string;
  onClose: () => void;
}

interface CarbonCopyTab {
  id: string;
  label: string;
  type: "all" | "group" | "direct";
  count: number;
  lastTimestamp: number;
}

interface GroupContext {
  contactGroupIds: Set<string>;
  groupNames: Map<string, string>;
  groupTabs: CarbonCopyTab[];
}

function loadSavedWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    return v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isGroupSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("group:");
}

function timestampValue(timestamp: string): number {
  const value = new Date(timestamp).getTime();
  return Number.isNaN(value) ? 0 : value;
}

function memberUid(address: string): string {
  return isGroupSessionId(address) ? address : extractEntityUid(address);
}

function groupIdFromCarbonCopy(cc: CarbonCopyMessage): string | null {
  const payload = cc.originalPayload ?? {};
  const sessionId =
    stringValue(payload.session_id) ??
    stringValue(payload.group_id) ??
    stringValue(cc.originalRecipient) ??
    stringValue(cc.originalSender);
  if (isGroupSessionId(sessionId)) return sessionId;
  if (isGroupSessionId(cc.originalRecipient)) return cc.originalRecipient;
  if (isGroupSessionId(cc.originalSender)) return cc.originalSender;
  return null;
}

function sessionIncludesContact(session: SessionInfo, contactUid: string): boolean {
  if (session.members?.some((member) => member.entity_uid === contactUid)) {
    return true;
  }
  return session.participants.some((address) => extractEntityUid(address) === contactUid);
}

function buildGroupContext(sessions: SessionInfo[], contactUid: string): GroupContext {
  const contactGroupIds = new Set<string>();
  const groupNames = new Map<string, string>();
  const groupTabs: CarbonCopyTab[] = [];

  for (const session of sessions) {
    if (session.session_type !== "group") continue;
    if (!isGroupSessionId(session.session_id)) continue;
    if (!sessionIncludesContact(session, contactUid)) continue;

    const label = session.name?.trim() || session.session_id;
    contactGroupIds.add(session.session_id);
    groupNames.set(session.session_id, label);
    groupTabs.push({
      id: `group:${session.session_id}`,
      label,
      type: "group",
      count: 0,
      lastTimestamp: session.updated_at * 1000,
    });
  }

  return { contactGroupIds, groupNames, groupTabs };
}

function groupLabel(cc: CarbonCopyMessage, groupId: string, groupNames: Map<string, string>): string {
  return (
    groupNames.get(groupId) ??
    (cc.originalRecipient === groupId ? cc.originalRecipientName?.trim() : undefined) ??
    (cc.originalSender === groupId ? cc.originalSenderName?.trim() : undefined) ??
    groupId
  );
}

function resolveOtherParticipant(
  cc: CarbonCopyMessage,
  contactUid: string,
): { uid: string; label: string } {
  const senderUid = extractEntityUid(cc.originalSender);
  const recipientUid = extractEntityUid(cc.originalRecipient);

  if (senderUid === contactUid) {
    return {
      uid: recipientUid,
      label: cc.originalRecipientName?.trim() || recipientUid,
    };
  }

  return {
    uid: senderUid,
    label: cc.originalSenderName?.trim() || senderUid,
  };
}

function carbonCopyBelongsToContact(
  cc: CarbonCopyMessage,
  contactUid: string,
  contactGroupIds: Set<string>,
): boolean {
  const groupId = groupIdFromCarbonCopy(cc);
  if (groupId) {
    return (
      contactGroupIds.has(groupId) ||
      memberUid(cc.originalSender) === contactUid ||
      memberUid(cc.originalRecipient) === contactUid
    );
  }

  return (
    memberUid(cc.originalSender) === contactUid ||
    memberUid(cc.originalRecipient) === contactUid
  );
}

function contextTabForCarbonCopy(
  cc: CarbonCopyMessage,
  contactUid: string,
  groupNames: Map<string, string>,
): CarbonCopyTab {
  const groupId = groupIdFromCarbonCopy(cc);
  if (groupId) {
    return {
      id: `group:${groupId}`,
      label: groupLabel(cc, groupId, groupNames),
      type: "group",
      count: 0,
      lastTimestamp: 0,
    };
  }

  const participant = resolveOtherParticipant(cc, contactUid);
  return {
    id: `direct:${participant.uid}`,
    label: participant.label,
    type: "direct",
    count: 0,
    lastTimestamp: 0,
  };
}

function chooseCanonicalCarbonCopy(
  current: CarbonCopyMessage,
  next: CarbonCopyMessage,
): CarbonCopyMessage {
  const currentGroupId = groupIdFromCarbonCopy(current);
  const nextGroupId = groupIdFromCarbonCopy(next);
  if (currentGroupId || nextGroupId) {
    if (!currentGroupId && nextGroupId) return next;
    if (isGroupSessionId(next.originalRecipient) && !isGroupSessionId(current.originalRecipient)) {
      return next;
    }
    return current;
  }
  return current.direction === "outbound" ? current : next;
}

export function CarbonCopyPanel({ contactUid, onClose }: CarbonCopyPanelProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const carbonCopyMessages = useAppStore((s) => s.carbonCopyMessages);
  const clearCarbonCopies = useAppStore((s) => s.clearCarbonCopies);
  const [groupSessions, setGroupSessions] = useState<SessionInfo[]>([]);
  const [width, setWidth] = useState(loadSavedWidth);
  const [activeTab, setActiveTab] = useState(ALL_TAB_ID);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(width);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentUser) {
      setGroupSessions([]);
      return;
    }

    let cancelled = false;
    listGroupSessions(currentUser.entity_uid)
      .then((sessions) => {
        if (!cancelled) setGroupSessions(sessions);
      })
      .catch(() => {
        if (!cancelled) setGroupSessions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  const groupContext = useMemo(
    () => buildGroupContext(groupSessions, contactUid),
    [contactUid, groupSessions],
  );

  const filtered = useMemo(() => {
    const byContext = carbonCopyMessages.filter((cc) =>
      carbonCopyBelongsToContact(cc, contactUid, groupContext.contactGroupIds),
    );
    const groups = new Map<string, CarbonCopyMessage>();
    for (const cc of byContext) {
      const key = cc.originalMessageId ?? cc.id;
      const existing = groups.get(key);
      if (!existing) { groups.set(key, cc); continue; }
      groups.set(key, chooseCanonicalCarbonCopy(existing, cc));
    }
    return Array.from(groups.values()).sort(
      (a, b) => timestampValue(a.timestamp) - timestampValue(b.timestamp),
    );
  }, [carbonCopyMessages, contactUid, groupContext.contactGroupIds]);

  const tabs = useMemo(() => {
    const groupMap = new Map<string, CarbonCopyTab>();
    for (const tab of groupContext.groupTabs) {
      groupMap.set(tab.id, { ...tab });
    }
    const directMap = new Map<string, CarbonCopyTab>();

    for (const cc of filtered) {
      const tab = contextTabForCarbonCopy(cc, contactUid, groupContext.groupNames);
      const targetMap = tab.type === "group" ? groupMap : directMap;
      const timestamp = timestampValue(cc.timestamp);
      const existing = targetMap.get(tab.id);
      if (!existing) {
        targetMap.set(tab.id, {
          id: tab.id,
          label: tab.label,
          type: tab.type,
          count: 1,
          lastTimestamp: timestamp,
        });
        continue;
      }
      existing.count += 1;
      existing.lastTimestamp = Math.max(existing.lastTimestamp, timestamp);
      if (existing.label === existing.id && tab.label !== tab.id) {
        existing.label = tab.label;
      }
    }

    const groupTabs = Array.from(groupMap.values())
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    const directTabs = Array.from(directMap.values())
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp);

    return [
      {
        id: ALL_TAB_ID,
        label: "All",
        type: "all" as const,
        count: filtered.length,
        lastTimestamp: filtered.length > 0
          ? timestampValue(filtered[filtered.length - 1].timestamp)
          : 0,
      },
      ...groupTabs,
      ...directTabs,
    ];
  }, [contactUid, filtered, groupContext]);

  const visibleMessages = useMemo(() => {
    if (activeTab === ALL_TAB_ID) {
      return filtered;
    }
    return filtered.filter((cc) =>
      contextTabForCarbonCopy(cc, contactUid, groupContext.groupNames).id === activeTab,
    );
  }, [activeTab, contactUid, filtered, groupContext.groupNames]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
  }, [width]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX.current - e.clientX;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta));
      setWidth(next);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      localStorage.setItem(WIDTH_STORAGE_KEY, String(document.querySelector<HTMLElement>("[data-cc-panel]")?.offsetWidth ?? DEFAULT_WIDTH));
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    return () => { localStorage.setItem(WIDTH_STORAGE_KEY, String(width)); };
  }, [width]);

  useEffect(() => {
    setActiveTab(ALL_TAB_ID);
  }, [contactUid]);

  useEffect(() => {
    if (tabs.some((tab) => tab.id === activeTab)) return;
    setActiveTab(ALL_TAB_ID);
  }, [activeTab, tabs]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleMessages]);

  return (
    <div
      data-cc-panel
      className={cn(
        "relative flex h-full shrink-0 flex-col border-l border-border bg-background overflow-hidden",
        "max-md:w-full max-md:border-l-0",
      )}
      style={{ width: undefined }}
    >
      <style>{`@media (min-width:768px){[data-cc-panel]{width:${width}px}}`}</style>
      {/* Resize handle (desktop only) */}
      <div
        onMouseDown={onMouseDown}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 z-10 max-md:hidden"
      />

      {/* Header */}
      <header className="flex items-center gap-2 px-4 h-14 border-b border-border shrink-0">
        <button
          onClick={onClose}
          className="md:hidden flex items-center justify-center h-8 w-8 -ml-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Inbox className="h-4 w-4 text-muted-foreground shrink-0" />
        <h3 className="text-sm font-semibold flex-1 min-w-0 truncate">
          CarbonCopy
          {filtered.length > 0 && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              ({filtered.length})
            </span>
          )}
        </h3>
        <button
          onClick={onClose}
          className={cn(
            "h-7 w-7 flex items-center justify-center rounded-lg shrink-0 max-md:hidden",
            "text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors",
          )}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {tabs.length > 1 && (
        <div className="border-b border-border px-3 pt-2 shrink-0">
          <div className="flex gap-1 overflow-x-auto pb-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                  activeTab === tab.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                <span className="ml-1 opacity-70">({tab.count})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Message list */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-2 min-w-0">
          {visibleMessages.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-12">
              No carbon copies yet
            </p>
          ) : (
            visibleMessages.map((cc) => (
              <CarbonCopyItem key={cc.id} cc={cc} contactUid={contactUid} />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Footer — clear button */}
      {filtered.length > 0 && (
        <div className="px-3 py-2 border-t border-border shrink-0">
          <button
            onClick={clearCarbonCopies}
            className="w-full text-xs text-muted-foreground hover:text-foreground py-1.5 rounded-lg hover:bg-surface-hover transition-colors"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
