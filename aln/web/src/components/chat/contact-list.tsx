/* Sidebar contact list — renders persisted contact order, with entity tags. */

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronRight, Users } from "lucide-react";

import { cn, EASE_SMOOTH } from "@/lib/utils";
import { useAppStore } from "@/stores/app";

import { Badge } from "@/components/ui/badge";
import { PixelAvatar } from "@/components/ui/pixel-avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Contact } from "@/types";

interface ContactListProps {
  onSelect: (contact: Contact) => void;
}

const PREVIEW_TEXT_CLASS =
  "min-w-0 flex-1 basis-0 truncate max-w-[14rem] md:max-w-[10rem]";

const TAG_STYLES: Record<string, string> = {
  private: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  public: "bg-green-500/10 text-green-400 border-green-500/20",
  foreign: "bg-orange-500/10 text-orange-400 border-orange-500/20",
};

export function ContactList({ onSelect }: ContactListProps) {
  const contacts = useAppStore((s) => s.contacts);
  const activeChatUid = useAppStore((s) => s.activeChatUid);
  const contactStatusMap = useAppStore((s) => s.contactStatusMap);
  const contactUnreadMap = useAppStore((s) => s.contactUnreadMap);
  const avatarCache = useAppStore((s) => s.avatarCache);

  const [expandedOrgs, setExpandedOrgs] = useState<Set<string>>(new Set());

  const { soloContacts, orgGroups } = useMemo(() => {
    const solo: Contact[] = [];
    const orgs: Array<{ id: string; name: string; members: Contact[]; totalUnread: number }> = [];
    const orgIndexMap = new Map<string, number>();

    for (const c of contacts) {
      const orgId = typeof c.metadata?.organization_id === "string" ? c.metadata.organization_id : "";
      const orgName = typeof c.metadata?.organization === "string" ? c.metadata.organization : "";
      if (orgId) {
        const existingIndex = orgIndexMap.get(orgId);
        if (existingIndex == null) {
          orgIndexMap.set(orgId, orgs.length);
          orgs.push({
            id: orgId,
            name: orgName,
            members: [c],
            totalUnread: contactUnreadMap[c.entity_uid]?.unread_count ?? 0,
          });
        } else {
          orgs[existingIndex].members.push(c);
          orgs[existingIndex].totalUnread += contactUnreadMap[c.entity_uid]?.unread_count ?? 0;
        }
      } else {
        solo.push(c);
      }
    }

    return { soloContacts: solo, orgGroups: orgs };
  }, [contacts, contactUnreadMap]);

  const toggleOrg = (id: string) =>
    setExpandedOrgs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const renderContact = (contact: Contact, i: number) => {
    const active = contact.entity_uid === activeChatUid;
    const isOnline =
      contact.online_status === "online" ||
      contactStatusMap[contact.entity_uid] === "online";
    const unread = contactUnreadMap[contact.entity_uid];
    const provider =
      typeof contact.metadata?.provider === "string"
        ? contact.metadata.provider
        : "";

    return (
      <motion.button
        key={contact.entity_uid}
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: i * 0.03, duration: 0.25, ease: EASE_SMOOTH }}
        whileTap={{ scale: 0.98 }}
        onClick={() => onSelect(contact)}
        className={cn(
          "w-full max-w-full overflow-hidden flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-150",
          active
            ? "bg-primary/10 border border-primary/10 text-foreground"
            : "border border-transparent text-muted-foreground hover:text-foreground hover:bg-surface",
        )}
      >
        <div className="relative flex-shrink-0">
          <PixelAvatar
            name={contact.name}
            kind={contact.kind}
            provider={provider}
            src={avatarCache[contact.entity_uid]}
            size="md"
          />
          {isOnline && (
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 border-2 border-sidebar" />
          )}
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{contact.name}</span>
            {contact.entity_tag && (
              <span
                className={cn(
                  "text-[9px] px-1 py-0.5 rounded border font-medium shrink-0",
                  TAG_STYLES[contact.entity_tag] ?? "",
                )}
              >
                {contact.entity_tag}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden">
            {unread?.last_message ? (
              <p className={cn(PREVIEW_TEXT_CLASS, "text-xs text-muted-foreground/60")}>
                {unread.last_message}
              </p>
            ) : (
              <p className={cn(PREVIEW_TEXT_CLASS, "text-[10px] text-muted-foreground/40")}>
                {contact.kind}
                {provider && `·${provider}`}
              </p>
            )}
            {unread && unread.unread_count > 0 && (
              <Badge className="ml-1 h-5 min-w-5 rounded-full bg-primary text-[10px] px-1.5 border-0 shrink-0">
                {unread.unread_count > 99 ? "99+" : unread.unread_count}
              </Badge>
            )}
          </div>
        </div>
      </motion.button>
    );
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-2 space-y-0.5">
        {soloContacts.length === 0 && orgGroups.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div className="h-12 w-12 rounded-xl bg-surface border border-border flex items-center justify-center mb-3">
              <svg className="h-6 w-6 text-muted-foreground/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" y1="8" x2="19" y2="14" />
                <line x1="22" y1="11" x2="16" y2="11" />
              </svg>
            </div>
            <p className="text-xs text-muted-foreground/60">No contacts yet</p>
            <p className="text-[10px] text-muted-foreground/40 mt-1">Discover entities to connect</p>
          </div>
        )}

        {soloContacts.map((c, i) => renderContact(c, i))}

        {orgGroups.map((org) => {
          const expanded = expandedOrgs.has(org.id);
          return (
            <div key={org.id}>
              <button
                onClick={() => toggleOrg(org.id)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left transition-colors hover:bg-surface group"
              >
                <Users className="h-4 w-4 text-primary/60 shrink-0" />
                <span className="text-xs font-semibold text-foreground/80 truncate flex-1">
                  {org.name}
                </span>
                {org.totalUnread > 0 && (
                  <Badge className="h-5 min-w-5 rounded-full bg-primary text-[10px] px-1.5 border-0 shrink-0">
                    {org.totalUnread > 99 ? "99+" : org.totalUnread}
                  </Badge>
                )}
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                )}
              </button>
              <AnimatePresence>
                {expanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: EASE_SMOOTH }}
                    className="overflow-hidden pl-3"
                  >
                    {org.members.map((c, i) => renderContact(c, i))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
