/* Group collaboration room: member roster + virtual meeting room + history. */

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Gauge,
  GripVertical,
  History,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  Send,
  Shield,
  Trash2,
  UserMinus,
  UserPlus,
  UserRound,
  Users,
  Zap,
} from "lucide-react";

import {
  addGroupMembers,
  createGroupSession,
  deleteGroupSession,
  getMessages,
  getSessionTokenUsage,
  markMessagesRead,
  removeGroupMember,
  sendGroupMessage,
} from "@/api";
import { getApiErrorMessage } from "@/api/client";
import type { MailboxMessage, SessionInfo, GroupMemberInfo, TokenUsageSummary } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PixelOfficeRoom } from "@/components/chat/pixel-office-room";
import { PixelAvatar } from "@/components/ui/pixel-avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWsListener } from "@/providers/websocket-provider";
import { useAppStore } from "@/stores/app";
import type { Contact, Message, MessagePayload } from "@/types";
import {
  cn,
  extractEntityUid,
  formatCompactTokenCount,
  formatInteger,
  normalizeTimestamp,
} from "@/lib/utils";
import type { WsEvent } from "@/hooks/use-websocket";

interface GroupRoomListProps {
  rooms: SessionInfo[];
  selectedRoomId?: string | null;
  loading?: boolean;
  onSelect: (room: SessionInfo) => void;
  onCreate: () => void;
  onRefresh: () => void;
}

interface CreateGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (room: SessionInfo) => void;
}

interface AddGroupMembersDialogProps {
  open: boolean;
  room: SessionInfo;
  activeMemberIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  onUpdated: (room: SessionInfo) => void;
}

interface GroupRoomProps {
  room: SessionInfo;
  onBack?: () => void;
  onRefreshRooms?: () => void;
  onRoomUpdated?: (room: SessionInfo) => void;
  onRoomDeleted?: (roomId: string) => void;
}

interface ContactPickerProps {
  contacts: Contact[];
  selectedMemberIds: Set<string>;
  emptyText: string;
  onToggle: (uid: string) => void;
}

const ROLE_STYLES: Record<string, string> = {
  owner: "border-accent/30 bg-accent/10 text-accent",
  admin: "border-success/30 bg-success/10 text-success",
  member: "border-border bg-surface text-muted-foreground",
  observer: "border-warning/30 bg-warning/10 text-warning",
};

const KIND_ICONS: Record<string, typeof Bot> = {
  agent: Bot,
  human: UserRound,
  tool: Zap,
  service: Radio,
  resource: Shield,
};

function memberIcon(kind: string) {
  return KIND_ICONS[kind] ?? Users;
}

function roomTimeLabel(timestamp?: string): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function groupIdFromMailbox(m: MailboxMessage): string | null {
  const payload = m.payload as Record<string, unknown>;
  const metadata = m.metadata ?? {};
  const raw =
    m.group_id ??
    metadata.group_id ??
    payload.session_id ??
    null;
  return typeof raw === "string" ? raw : null;
}

function mailboxToGroupMessage(m: MailboxMessage, roomId: string): Message | null {
  if (groupIdFromMailbox(m) !== roomId) return null;
  const payload = m.payload as Record<string, unknown>;
  const text = String(payload.text ?? "");

  return {
    message_id: m.message_id,
    mail_id: m.mail_id,
    kind: m.kind,
    sender: m.sender,
    recipient: m.recipient,
    payload: {
      ...payload,
      text,
    } as MessagePayload,
    metadata: m.metadata,
    conversation_type: m.conversation_type,
    group_id: m.group_id ?? roomId,
    timestamp: normalizeTimestamp(m.timestamp),
    status: m.status as Message["status"],
    session_id: typeof payload.session_id === "string" ? payload.session_id : roomId,
  };
}

function isRoomWsMessage(message: Message, roomId: string): boolean {
  const metadata = message.metadata ?? {};
  return (
    message.group_id === roomId ||
    message.session_id === roomId ||
    metadata.group_id === roomId
  );
}

function memberAddress(member: GroupMemberInfo): string {
  return member.address || `${member.host_uid}:${member.entity_uid}`;
}

function memberByUid(
  members: GroupMemberInfo[],
  uidOrAddress: string,
): GroupMemberInfo | undefined {
  const uid = extractEntityUid(uidOrAddress);
  return members.find(
    (member) =>
      member.entity_uid === uid ||
      member.address === uidOrAddress,
  );
}

function mergeRoomMembers(room: SessionInfo): GroupMemberInfo[] {
  return (room.members ?? [])
    .filter((member) => member.status !== "removed")
    .sort((a, b) => {
      const roleOrder: Record<string, number> = { owner: 0, admin: 1, member: 2, observer: 3 };
      return (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9) || a.name.localeCompare(b.name);
    });
}

function canRemoveMember(
  currentMember: GroupMemberInfo | undefined,
  member: GroupMemberInfo,
): boolean {
  return Boolean(
    currentMember?.can_remove &&
    member.role !== "owner" &&
    member.address !== currentMember.address,
  );
}

function errorMessage(error: unknown): string {
  return getApiErrorMessage(error);
}

function ContactPicker({
  contacts,
  selectedMemberIds,
  emptyText,
  onToggle,
}: ContactPickerProps) {
  return (
    <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
      {contacts.length === 0 && (
        <div className="p-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      )}
      {contacts.map((contact) => {
        const selected = selectedMemberIds.has(contact.entity_uid);
        const Icon = memberIcon(contact.kind);
        return (
          <button
            key={contact.entity_uid}
            type="button"
            onClick={() => onToggle(contact.entity_uid)}
            className={cn(
              "flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface",
              selected && "bg-primary/5",
            )}
          >
            <div className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border">
              {selected && <Check className="h-3.5 w-3.5 text-primary" />}
            </div>
            <PixelAvatar
              name={contact.name}
              kind={contact.kind}
              provider={typeof contact.metadata?.provider === "string" ? contact.metadata.provider : undefined}
              size="sm"
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{contact.name}</span>
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </div>
              <p className="truncate text-[11px] text-muted-foreground">
                {contact.address?.address ?? contact.entity_uid}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function GroupRoomList({
  rooms,
  selectedRoomId,
  loading,
  onSelect,
  onCreate,
  onRefresh,
}: GroupRoomListProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <Button size="sm" className="flex-1" onClick={onCreate}>
          <Plus className="h-4 w-4" />
          Room
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onRefresh} disabled={loading} title="Refresh rooms">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {loading && rooms.length === 0 && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && rooms.length === 0 && (
            <div className="px-3 py-10 text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface">
                <Users className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-xs font-medium text-foreground/70">No rooms</p>
              <p className="mt-1 text-[11px] text-muted-foreground">Create one with friends</p>
            </div>
          )}
          {rooms.map((room, index) => {
            const active = room.session_id === selectedRoomId;
            const members = mergeRoomMembers(room);
            return (
              <motion.button
                key={room.session_id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.025, duration: 0.2 }}
                onClick={() => onSelect(room)}
                className={cn(
                  "w-full overflow-hidden rounded-lg border px-3 py-2.5 text-left transition-colors",
                  active
                    ? "border-primary/20 bg-primary/10 text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-surface hover:text-foreground",
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
                    <Users className="h-4 w-4 text-accent" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{room.name ?? "Untitled room"}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {members.length} members
                    </p>
                  </div>
                </div>
                <div className="mt-2 flex -space-x-1 overflow-hidden">
                  {members.slice(0, 5).map((member) => (
                    <PixelAvatar
                      key={member.address}
                      name={member.name}
                      kind={member.kind}
                      size="xs"
                      className="border-background"
                    />
                  ))}
                </div>
              </motion.button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

export function CreateGroupDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateGroupDialogProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const contacts = useAppStore((s) => s.contacts);
  const [name, setName] = useState("Research room");
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedMemberIds(new Set());
    setName("Research room");
  }, [open]);

  const availableContacts = contacts.filter((contact) => contact.kind !== "arbiter");

  const toggleMember = (uid: string) => {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!currentUser || creating || selectedMemberIds.size === 0 || !name.trim()) return;
    setCreating(true);
    try {
      const room = await createGroupSession(
        currentUser.entity_uid,
        name.trim(),
        Array.from(selectedMemberIds),
      );
      onCreated(room);
      onOpenChange(false);
    } catch (error) {
      alert(`Create failed: ${errorMessage(error)}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl rounded-lg">
        <DialogHeader>
          <DialogTitle>Create room</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Members</span>
              <Badge variant="outline" className="rounded-md">
                {selectedMemberIds.size} selected
              </Badge>
            </div>
            <ContactPicker
              contacts={availableContacts}
              selectedMemberIds={selectedMemberIds}
              emptyText="No friends available"
              onToggle={toggleMember}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={creating || selectedMemberIds.size === 0 || !name.trim()}
          >
            {creating && <Loader2 className="h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddGroupMembersDialog({
  open,
  room,
  activeMemberIds,
  onOpenChange,
  onUpdated,
}: AddGroupMembersDialogProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const contacts = useAppStore((s) => s.contacts);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedMemberIds(new Set());
  }, [open]);

  const availableContacts = contacts.filter(
    (contact) => contact.kind !== "arbiter" && !activeMemberIds.has(contact.entity_uid),
  );

  const toggleMember = (uid: string) => {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const handleSave = async () => {
    if (!currentUser || saving || selectedMemberIds.size === 0) return;
    setSaving(true);
    try {
      const updated = await addGroupMembers(
        currentUser.entity_uid,
        room.session_id,
        Array.from(selectedMemberIds),
      );
      onUpdated(updated);
      onOpenChange(false);
    } catch (error) {
      alert(`Invite failed: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl rounded-lg">
        <DialogHeader>
          <DialogTitle>Invite members</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {room.name ?? "Group room"}
            </span>
            <Badge variant="outline" className="rounded-md">
              {selectedMemberIds.size} selected
            </Badge>
          </div>
          <ContactPicker
            contacts={availableContacts}
            selectedMemberIds={selectedMemberIds}
            emptyText="No more friends available"
            onToggle={toggleMember}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || selectedMemberIds.size === 0}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GroupRoom({
  room,
  onBack,
  onRefreshRooms,
  onRoomUpdated,
  onRoomDeleted,
}: GroupRoomProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const contacts = useAppStore((s) => s.contacts);
  const avatarCache = useAppStore((s) => s.avatarCache);
  const { addListener } = useWsListener();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingTokenUsage, setLoadingTokenUsage] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsageSummary | null>(null);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [deletingRoom, setDeletingRoom] = useState(false);
  const [removingMemberAddress, setRemovingMemberAddress] = useState<string | null>(null);
  const [leftPanelWidth, setLeftPanelWidth] = useState(224);
  const [rightPanelWidth, setRightPanelWidth] = useState(300);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  const members = useMemo(() => mergeRoomMembers(room), [room]);
  const contactByUid = useMemo(
    () => new Map(contacts.map((contact) => [contact.entity_uid, contact])),
    [contacts],
  );
  const avatarByUid = useMemo(
    () =>
      new Map(
        members.map((member) => [
          member.entity_uid,
          contactByUid.get(member.entity_uid)?.has_avatar
            ? avatarCache[member.entity_uid]
            : undefined,
        ]),
      ),
    [avatarCache, contactByUid, members],
  );
  const providerByUid = useMemo(
    () =>
      new Map(
        members.map((member) => {
          const provider = contactByUid.get(member.entity_uid)?.metadata?.provider;
          return [
            member.entity_uid,
            typeof provider === "string" ? provider : undefined,
          ];
        }),
      ),
    [contactByUid, members],
  );
  const currentMember = currentUser
    ? memberByUid(members, currentUser.entity_uid)
    : undefined;
  const canSend = currentMember?.can_send ?? false;
  const canInvite = currentMember?.can_invite ?? false;
  const canRemove = currentMember?.can_remove ?? false;
  const activeMemberIds = useMemo(
    () => new Set(members.map((member) => member.entity_uid)),
    [members],
  );
  const roomGridStyle = {
    "--room-left-track": leftPanelOpen ? `${leftPanelWidth}px` : "2.75rem",
    "--room-left-resizer-width": leftPanelOpen ? "0.5rem" : "0rem",
    "--room-right-track": rightPanelOpen ? `${rightPanelWidth}px` : "2.75rem",
    "--room-right-resizer-width": rightPanelOpen ? "0.5rem" : "0rem",
  } as CSSProperties;

  const loadHistory = useCallback(async () => {
    if (!currentUser) return;
    setLoadingHistory(true);
    try {
      const mailbox = await getMessages(currentUser.entity_uid);
      const roomMessages = mailbox
        .map((entry) => mailboxToGroupMessage(entry, room.session_id))
        .filter((message): message is Message => message !== null);
      setMessages(roomMessages);

      const unreadIds = mailbox
        .filter((entry) => groupIdFromMailbox(entry) === room.session_id)
        .filter((entry) => entry.direction === "inbound" && !entry.is_read)
        .map((entry) => entry.message_id);
      if (unreadIds.length > 0) {
        markMessagesRead(currentUser.entity_uid, unreadIds).catch(() => {});
      }
    } finally {
      setLoadingHistory(false);
    }
  }, [currentUser, room.session_id]);

  const loadTokenUsage = useCallback(async () => {
    if (!currentUser) return;
    setLoadingTokenUsage(true);
    try {
      setTokenUsage(await getSessionTokenUsage(currentUser.entity_uid, room.session_id));
    } catch {
      setTokenUsage(null);
    } finally {
      setLoadingTokenUsage(false);
    }
  }, [currentUser, room.session_id]);

  useEffect(() => {
    setMessages([]);
    setTokenUsage(null);
    loadHistory();
    loadTokenUsage();
  }, [loadHistory, loadTokenUsage]);

  useEffect(() => {
    return addListener((event: WsEvent) => {
      if (event.type !== "new_message" || !event.message) return;
      if (!isRoomWsMessage(event.message, room.session_id)) return;
      setMessages((prev) => {
        if (prev.some((message) => message.message_id === event.message?.message_id)) {
          return prev;
        }
        return [...prev, event.message as Message];
      });
      loadTokenUsage();
    });
  }, [addListener, loadTokenUsage, room.session_id]);

  const latestMessage = messages[messages.length - 1];
  const activeSpeakerUid = latestMessage ? extractEntityUid(latestMessage.sender) : "";
  const hasActualTokenUsage = tokenUsage?.has_actual_usage ?? false;
  const actualTokenTotals = tokenUsage?.totals;
  const totalTokens = actualTokenTotals?.total_tokens ?? 0;
  const tokenRecordCount = tokenUsage?.records.length ?? 0;
  const tokenProviderCount = tokenUsage?.providers.length ?? 0;
  const compactTotalTokens = formatCompactTokenCount(totalTokens);
  const exactTotalTokens = formatInteger(totalTokens);
  const tokenBreakdown = [
    { label: "input", title: "input total", value: actualTokenTotals?.input_tokens ?? 0 },
    { label: "cache", title: "cache read", value: actualTokenTotals?.cached_input_tokens ?? 0 },
    { label: "output", title: "output", value: actualTokenTotals?.output_tokens ?? 0 },
    { label: "reqs", title: "requests", value: tokenRecordCount },
  ];
  const tokenUsageHint = hasActualTokenUsage
    ? `${formatInteger(tokenRecordCount)} provider usage ${tokenRecordCount === 1 ? "record" : "records"}.`
    : "Waiting for provider usage records.";

  const recentByMember = useMemo(() => {
    const map = new Map<string, Message>();
    for (const message of messages.slice(-8)) {
      map.set(extractEntityUid(message.sender), message);
    }
    return map;
  }, [messages]);

  const layout = useMemo(() => {
    const count = Math.max(members.length, 1);
    return members.map((member, index) => {
      const angle = (-90 + (index * 360) / count) * (Math.PI / 180);
      return {
        member,
        left: 50 + Math.cos(angle) * 38,
        top: 50 + Math.sin(angle) * 31,
      };
    });
  }, [members]);

  const handleSend = async () => {
    if (!currentUser || !input.trim() || sending || !canSend) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    const tmpId = `tmp-group-${Date.now()}`;
    const optimistic: Message = {
      message_id: tmpId,
      sender: currentUser.entity_uid,
      recipient: members
        .filter((member) => member.entity_uid !== currentUser.entity_uid)
        .map(memberAddress),
      payload: { text, session_id: room.session_id },
      metadata: { conversation_type: "group", group_id: room.session_id },
      conversation_type: "group",
      group_id: room.session_id,
      timestamp: new Date().toISOString(),
      status: "sent",
      session_id: room.session_id,
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const result = await sendGroupMessage(currentUser.entity_uid, room.session_id, text);
      setMessages((prev) =>
        prev.map((message) =>
          message.message_id === tmpId
            ? {
                ...message,
                message_id: result.message_id,
                mail_id: result.mail_id,
                status: "delivering",
              }
            : message,
        ),
      );
      onRefreshRooms?.();
    } catch {
      setMessages((prev) =>
        prev.map((message) =>
          message.message_id === tmpId ? { ...message, status: "failed" } : message,
        ),
      );
    } finally {
      setSending(false);
    }
  };

  const startPanelResize = useCallback(
    (panel: "left" | "right", event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panel === "left" ? leftPanelWidth : rightPanelWidth;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        const nextWidth = panel === "left" ? startWidth + delta : startWidth - delta;
        const clampedWidth = Math.min(460, Math.max(196, nextWidth));
        if (panel === "left") setLeftPanelWidth(clampedWidth);
        else setRightPanelWidth(clampedWidth);
      };

      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [leftPanelWidth, rightPanelWidth],
  );

  const handleRoomUpdated = (updatedRoom: SessionInfo) => {
    onRoomUpdated?.(updatedRoom);
    onRefreshRooms?.();
  };

  const handleRemoveMember = async (member: GroupMemberInfo) => {
    if (!currentUser || removingMemberAddress) return;
    if (!confirm(`Remove "${member.name}" from this room?`)) return;
    setRemovingMemberAddress(member.address);
    try {
      const updatedRoom = await removeGroupMember(
        currentUser.entity_uid,
        room.session_id,
        member.address,
      );
      handleRoomUpdated(updatedRoom);
    } catch (error) {
      alert(`Remove failed: ${errorMessage(error)}`);
    } finally {
      setRemovingMemberAddress(null);
    }
  };

  const handleDeleteRoom = async () => {
    if (!currentUser || deletingRoom) return;
    if (!confirm(`Delete "${room.name ?? "this room"}"?`)) return;
    setDeletingRoom(true);
    try {
      await deleteGroupSession(currentUser.entity_uid, room.session_id);
      onRoomDeleted?.(room.session_id);
      onRefreshRooms?.();
    } catch (error) {
      alert(`Delete failed: ${errorMessage(error)}`);
    } finally {
      setDeletingRoom(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        {onBack && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="md:hidden"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
          <Users className="h-4 w-4 text-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{room.name ?? "Group room"}</h2>
          <p className="text-[11px] text-muted-foreground">
            {members.length} members / shared context
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={handleDeleteRoom}
          disabled={!canRemove || deletingRoom}
          title={canRemove ? "Delete room" : "Only owners and admins can delete"}
        >
          {deletingRoom ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={loadHistory} title="Reload history">
          <RefreshCw className={cn("h-4 w-4", loadingHistory && "animate-spin")} />
        </Button>
      </header>

      <div
        className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[var(--room-left-track)_var(--room-left-resizer-width)_minmax(0,1fr)] xl:grid-cols-[var(--room-left-track)_var(--room-left-resizer-width)_minmax(0,1fr)_var(--room-right-resizer-width)_var(--room-right-track)]"
        style={roomGridStyle}
      >
        <aside className="hidden min-h-0 border-r border-border bg-sidebar/70 lg:col-start-1 lg:flex lg:flex-col">
          {leftPanelOpen ? (
            <>
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">Entities</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => setLeftPanelOpen(false)}
                  title="Hide entities panel"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-1 p-2">
                  {members.map((member) => {
                    const contact = contactByUid.get(member.entity_uid);
                    const Icon = memberIcon(member.kind);
                    const active = member.entity_uid === activeSpeakerUid;
                    const removable = canRemoveMember(currentMember, member);
                    return (
                      <div
                        key={member.address}
                        className={cn(
                          "group flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                          active ? "border-accent/30 bg-accent/10" : "border-transparent bg-transparent",
                        )}
                      >
                        <PixelAvatar
                          name={member.name}
                          kind={member.kind}
                          provider={providerByUid.get(member.entity_uid)}
                          src={contact?.has_avatar ? avatarCache[member.entity_uid] : undefined}
                          size="sm"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{member.name}</span>
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          </div>
                          <Badge
                            variant="outline"
                            className={cn("mt-1 rounded-md px-1.5 py-0 text-[10px]", ROLE_STYLES[member.role])}
                          >
                            {member.role}
                          </Badge>
                        </div>
                        {removable && (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => handleRemoveMember(member)}
                            disabled={removingMemberAddress === member.address}
                            title={`Remove ${member.name}`}
                            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                          >
                            {removingMemberAddress === member.address ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <UserMinus className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  <Button
                    size="sm"
                    onClick={() => setAddMembersOpen(true)}
                    disabled={!canInvite}
                    title={canInvite ? "Invite members" : "Only owners and admins can invite"}
                    className="mt-3 h-10 w-full justify-center rounded-lg bg-neutral-950 px-4 text-sm font-semibold text-white shadow-sm hover:bg-neutral-900 hover:text-white disabled:bg-muted disabled:text-muted-foreground"
                  >
                    <UserPlus className="h-4 w-4" />
                    Invite member
                  </Button>
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex h-full flex-col items-center gap-3 py-3">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setLeftPanelOpen(true)}
                title="Show entities panel"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Users className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
        </aside>

        <button
          type="button"
          className={cn(
            "hidden cursor-col-resize items-center justify-center border-r border-border bg-sidebar/50 text-muted-foreground hover:bg-surface hover:text-foreground",
            leftPanelOpen && "lg:col-start-2 lg:flex",
          )}
          onPointerDown={(event) => startPanelResize("left", event)}
          title="Resize entities panel"
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <main className="flex min-h-0 flex-col overflow-hidden bg-background lg:col-start-3">
          <div className="relative min-h-[28rem] flex-1 overflow-hidden border-b border-border">
            <PixelOfficeRoom
              roomName={room.name}
              seats={layout}
              latestMessage={latestMessage}
              recentByMember={recentByMember}
              activeSpeakerUid={activeSpeakerUid}
              avatarByUid={avatarByUid}
              providerByUid={providerByUid}
              tokenLabel={hasActualTokenUsage ? "actual tokens" : "tokens"}
              turnCount={messages.length}
              tokenCount={totalTokens}
            />
          </div>

          <div className="shrink-0 border-t border-border bg-background p-3">
            <div className="flex items-end gap-2 rounded-lg border border-input bg-surface px-3 py-2 focus-within:border-primary/25">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={canSend ? "Message the room..." : "Observer role cannot send"}
                disabled={!canSend}
                rows={1}
                className="max-h-28 min-h-8 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed"
              />
              <Button
                size="icon-sm"
                disabled={!input.trim() || sending || !canSend}
                onClick={handleSend}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </main>

        <button
          type="button"
          className={cn(
            "hidden cursor-col-resize items-center justify-center border-l border-border bg-sidebar/50 text-muted-foreground hover:bg-surface hover:text-foreground",
            rightPanelOpen && "xl:col-start-4 xl:flex",
          )}
          onPointerDown={(event) => startPanelResize("right", event)}
          title="Resize history panel"
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <aside className="hidden min-w-0 min-h-0 border-l border-border bg-sidebar/70 xl:col-start-5 xl:flex xl:flex-col">
          {rightPanelOpen ? (
            <>
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
                <History className="h-4 w-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">Chat History</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => setRightPanelOpen(false)}
                  title="Hide chat history panel"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="min-w-0 min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                <div className="min-w-0 space-y-2 p-3">
                  {loadingHistory && (
                    <div className="flex justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  {!loadingHistory && messages.length === 0 && (
                    <p className="py-8 text-center text-xs text-muted-foreground">No messages yet</p>
                  )}
                  {messages.map((message) => {
                    const sender = memberByUid(members, message.sender);
                    const isSelf = currentUser?.entity_uid === extractEntityUid(message.sender);
                    return (
                      <div
                        key={message.message_id}
                        className={cn(
                          "min-w-0 max-w-full overflow-hidden rounded-lg border px-3 py-2",
                          isSelf ? "border-primary/15 bg-primary/5" : "border-border bg-background",
                        )}
                      >
                        <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-xs font-semibold">
                            {sender?.name ?? extractEntityUid(message.sender)}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {roomTimeLabel(message.timestamp)}
                          </span>
                        </div>
                        <p className="w-full max-w-full whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/80 [overflow-wrap:anywhere] [word-break:break-word]">
                          {String(message.payload.text ?? "")}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="basis-[28%] min-h-[13.5rem] max-h-[16.5rem] shrink-0 overflow-hidden border-t border-sidebar-border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-semibold">Token Usage</span>
                </div>
                <div className="space-y-2">
                  <div className="rounded-lg border border-primary/20 bg-primary/10 p-2.5 shadow-inner shadow-primary/5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Actual usage
                          {loadingTokenUsage && <Loader2 className="h-3 w-3 animate-spin" />}
                        </p>
                        <motion.p
                          key={`${hasActualTokenUsage}-${totalTokens}`}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="truncate text-2xl font-semibold text-foreground"
                          title={`${exactTotalTokens} tokens`}
                        >
                          {compactTotalTokens}
                        </motion.p>
                      </div>
                      <Badge
                        variant={hasActualTokenUsage ? "default" : "outline"}
                        className={cn(
                          "rounded-md px-2 py-0.5 text-[10px]",
                          !hasActualTokenUsage && "text-muted-foreground",
                        )}
                      >
                        {hasActualTokenUsage ? "Live" : "Waiting"}
                      </Badge>
                    </div>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {exactTotalTokens} tokens recorded
                    </p>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {tokenBreakdown.map((item) => (
                      <div
                        key={item.label}
                        className="min-w-0 rounded-md border border-border bg-background px-2 py-1.5"
                        title={item.title}
                      >
                        <p className="truncate text-xs font-semibold" title={formatInteger(item.value)}>
                          {formatCompactTokenCount(item.value)}
                        </p>
                        <p className="truncate text-[9px] text-muted-foreground">{item.label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-[10px]">
                    <span className="text-muted-foreground">Providers</span>
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="font-medium text-foreground">
                        {formatInteger(tokenProviderCount)}
                      </span>
                      {tokenUsage?.providers.slice(0, 2).map((provider) => (
                        <Badge
                          key={provider}
                          variant="outline"
                          className="max-w-20 truncate rounded-md px-1.5 py-0 text-[10px]"
                        >
                          {provider}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
                    <Clock3 className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <p className="truncate text-[10px] leading-tight text-muted-foreground">
                      {tokenUsageHint}
                    </p>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center gap-3 py-3">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setRightPanelOpen(true)}
                title="Show chat history panel"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <History className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
        </aside>
      </div>
      <AddGroupMembersDialog
        open={addMembersOpen}
        room={room}
        activeMemberIds={activeMemberIds}
        onOpenChange={setAddMembersOpen}
        onUpdated={handleRoomUpdated}
      />
    </div>
  );
}
