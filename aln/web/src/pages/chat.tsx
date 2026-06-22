/* Chat page — contacts sidebar + conversation area. */

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, MessageSquare, Users } from "lucide-react";

import { cn, EASE_SMOOTH } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { ContactList } from "@/components/chat/contact-list";
import { ChatArea } from "@/components/chat/chat-area";
import {
  CreateGroupDialog,
  GroupRoom,
  GroupRoomList,
} from "@/components/chat/group-room";
import { listGroupSessions } from "@/api";
import { getApiErrorMessage } from "@/api/client";
import type { SessionInfo } from "@/api";
import type { Contact } from "@/types";

export function ChatPage() {
  const currentUser = useAppStore((s) => s.currentUser);
  const loadContacts = useAppStore((s) => s.loadContacts);
  const refreshOnlineStatus = useAppStore((s) => s.refreshOnlineStatus);
  const setActiveChatUid = useAppStore((s) => s.setActiveChatUid);

  const [viewMode, setViewMode] = useState<"contacts" | "rooms">("rooms");
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<SessionInfo | null>(null);
  const [rooms, setRooms] = useState<SessionInfo[]>([]);
  const [showChat, setShowChat] = useState(false);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [messagesPanelOpen, setMessagesPanelOpen] = useState(true);

  useEffect(() => {
    loadContacts();
    refreshOnlineStatus();
    const interval = setInterval(refreshOnlineStatus, 30_000);
    return () => clearInterval(interval);
  }, [loadContacts, refreshOnlineStatus]);

  const handleSelectContact = useCallback(
    (contact: Contact) => {
      setViewMode("contacts");
      setSelectedContact(contact);
      setSelectedRoom(null);
      setActiveChatUid(contact.entity_uid);
      setShowChat(true);
    },
    [setActiveChatUid],
  );

  const loadRooms = useCallback(async () => {
    if (!currentUser) return;
    setLoadingRooms(true);
    setRoomsError(null);
    try {
      const nextRooms = await listGroupSessions(currentUser.entity_uid);
      setRooms(nextRooms);
      setSelectedRoom((current) => {
        if (!current) return current;
        return nextRooms.find((room) => room.session_id === current.session_id) ?? null;
      });
    } catch (error) {
      setRoomsError(getApiErrorMessage(error));
    } finally {
      setLoadingRooms(false);
    }
  }, [currentUser]);

  useEffect(() => {
    if (viewMode === "rooms") {
      loadRooms();
    }
  }, [viewMode, loadRooms]);

  const handleSelectRoom = useCallback(
    (room: SessionInfo) => {
      setViewMode("rooms");
      setSelectedRoom(room);
      setSelectedContact(null);
      setActiveChatUid(`group:${room.session_id}`);
      setShowChat(true);
    },
    [setActiveChatUid],
  );

  const handleBack = useCallback(() => {
    setShowChat(false);
    setActiveChatUid(null);
  }, [setActiveChatUid]);

  const handleRoomUpdated = useCallback((room: SessionInfo) => {
    setRooms((prev) => [
      room,
      ...prev.filter((item) => item.session_id !== room.session_id),
    ]);
    setSelectedRoom(room);
  }, []);

  const handleRoomDeleted = useCallback(
    (roomId: string) => {
      setRooms((prev) => prev.filter((room) => room.session_id !== roomId));
      setSelectedRoom((current) => (
        current?.session_id === roomId ? null : current
      ));
      setShowChat(false);
      setActiveChatUid(null);
    },
    [setActiveChatUid],
  );

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      {/* Contact sidebar — hidden on mobile when chat is open */}
      <div
        className={cn(
          "min-h-0 border-r border-border bg-sidebar flex flex-col shrink-0 transition-[width] duration-200",
          messagesPanelOpen ? "w-full md:w-72" : "w-full md:w-12",
          showChat ? "hidden md:flex" : "flex",
        )}
      >
        <div className={cn("min-h-0 flex-1 flex-col", messagesPanelOpen ? "flex" : "flex md:hidden")}>
          <div className="px-4 h-14 flex items-center justify-between border-b border-sidebar-border shrink-0">
            <h1 className="font-heading text-sm font-semibold">Messages</h1>
            <button
              type="button"
              onClick={() => setMessagesPanelOpen(false)}
              className="hidden h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface hover:text-foreground md:flex"
              aria-label="Collapse messages panel"
              title="Collapse messages"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1 border-b border-sidebar-border p-2">
            <button
              type="button"
              onClick={() => setViewMode("contacts")}
              className={cn(
                "flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors",
                viewMode === "contacts"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-surface hover:text-foreground",
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Direct
            </button>
            <button
              type="button"
              onClick={() => setViewMode("rooms")}
              className={cn(
                "flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors",
                viewMode === "rooms"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-surface hover:text-foreground",
              )}
            >
              <Users className="h-3.5 w-3.5" />
              Rooms
            </button>
          </div>
          {viewMode === "contacts" ? (
            <ContactList onSelect={handleSelectContact} />
          ) : (
            <>
              {roomsError && (
                <div className="mx-2 mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                  {roomsError}
                </div>
              )}
              <GroupRoomList
                rooms={rooms}
                selectedRoomId={selectedRoom?.session_id}
                loading={loadingRooms}
                onSelect={handleSelectRoom}
                onCreate={() => setCreateRoomOpen(true)}
                onRefresh={loadRooms}
              />
            </>
          )}
        </div>
        {!messagesPanelOpen && (
          <div className="hidden h-full flex-col items-center gap-3 py-3 md:flex">
            <button
              type="button"
              onClick={() => setMessagesPanelOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
              aria-label="Expand messages panel"
              title="Expand messages"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setMessagesPanelOpen(true)}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg border border-sidebar-border transition-colors",
                viewMode === "rooms"
                  ? "bg-primary/15 text-primary"
                  : "bg-sidebar-accent text-muted-foreground hover:text-foreground",
              )}
              aria-label="Open messages"
              title="Messages"
            >
              {viewMode === "rooms" ? (
                <Users className="h-4 w-4" />
              ) : (
                <MessageSquare className="h-4 w-4" />
              )}
            </button>
            <span className="mt-1 select-none text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground [writing-mode:vertical-rl]">
              Messages
            </span>
          </div>
        )}
      </div>

      {/* Chat area — full width on mobile, flex on desktop */}
      <div
        className={cn(
          "flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden",
          showChat ? "flex" : "hidden md:flex",
        )}
      >
        {selectedContact ? (
          <ChatArea contact={selectedContact} onBack={handleBack} />
        ) : selectedRoom ? (
          <GroupRoom
            room={selectedRoom}
            onBack={handleBack}
            onRefreshRooms={loadRooms}
            onRoomUpdated={handleRoomUpdated}
            onRoomDeleted={handleRoomDeleted}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
            {/* Animated network icon with layered glow */}
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.6, ease: EASE_SMOOTH }}
              className="relative"
            >
              <div className="h-24 w-24 rounded-2xl bg-muted border border-border flex items-center justify-center relative overflow-hidden">
                <svg
                  className="h-12 w-12 text-muted-foreground/30"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeLinecap="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <circle cx="4" cy="6" r="1.5" />
                  <circle cx="20" cy="6" r="1.5" />
                  <circle cx="4" cy="18" r="1.5" />
                  <circle cx="20" cy="18" r="1.5" />
                  <line x1="9.5" y1="10.5" x2="5.5" y2="7" />
                  <line x1="14.5" y1="10.5" x2="18.5" y2="7" />
                  <line x1="9.5" y1="13.5" x2="5.5" y2="17" />
                  <line x1="14.5" y1="13.5" x2="18.5" y2="17" />
                </svg>
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.4 }}
              className="text-center"
            >
              <p className="text-sm font-medium text-foreground/60">
                {viewMode === "rooms" ? "Select a room" : "Select a contact"}
              </p>
              <p className="text-xs text-muted-foreground/40 mt-1">
                {viewMode === "rooms" ? "to enter the meeting room" : "to start a conversation"}
              </p>
            </motion.div>
          </div>
        )}
      </div>

      <CreateGroupDialog
        open={createRoomOpen}
        onOpenChange={setCreateRoomOpen}
        onCreated={(room) => {
          setRooms((prev) => [room, ...prev.filter((item) => item.session_id !== room.session_id)]);
          handleSelectRoom(room);
        }}
      />
    </div>
  );
}
