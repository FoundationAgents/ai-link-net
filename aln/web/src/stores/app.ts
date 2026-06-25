/* Global application store (Zustand). */

import { create } from "zustand";

import type {
  CarbonCopyMessage,
  Contact,
  ContactUnreadInfo,
  EntityTag,
  OnlineStatus,
  UserProfile,
} from "@/types";
import {
  fetchAvatarAsDataUrl,
  getEntity,
  getEntityCard,
  getFriendsStatus,
  listFriends,
} from "@/api";

const STORAGE_KEY_USER = "fp_current_user";
const STORAGE_KEY_USERS = "fp_saved_users";
const STORAGE_KEY_HOST_UID = "fp_current_host_uid";
const STORAGE_KEY_CONTACTS_CACHE = "fp_contacts_cache";
const STORAGE_KEY_AVATAR_CACHE = "fp_avatar_cache";

/* ---------- helpers ---------- */

function loadAvatarCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_AVATAR_CACHE);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function loadContactsCache(): Contact[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CONTACTS_CACHE);
    return raw ? (JSON.parse(raw) as Contact[]) : [];
  } catch {
    return [];
  }
}

function persistContactsCache(contacts: Contact[]) {
  try {
    localStorage.setItem(STORAGE_KEY_CONTACTS_CACHE, JSON.stringify(contacts));
  } catch {
    /* ignore quota errors */
  }
}

function persistAvatarCache(cache: Record<string, string>) {
  try {
    localStorage.setItem(STORAGE_KEY_AVATAR_CACHE, JSON.stringify(cache));
  } catch { /* ignore quota errors */ }
}

function loadCurrentUser(): UserProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER);
    if (!raw) {
      return null;
    }
    const user = JSON.parse(raw) as UserProfile;
    return user.kind === "human" ? user : null;
  } catch {
    return null;
  }
}

function persistCurrentUser(user: UserProfile | null) {
  if (user) {
    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
  } else {
    localStorage.removeItem(STORAGE_KEY_USER);
  }
}

export function loadSavedUsers(): UserProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USERS);
    const users = raw ? (JSON.parse(raw) as UserProfile[]) : [];
    return users.filter((user) => user.kind === "human");
  } catch {
    return [];
  }
}

function saveUserToList(user: UserProfile) {
  if (user.kind !== "human") {
    return;
  }
  // #15: uniqueness by BOTH entity_uid AND host_url
  const users = loadSavedUsers().filter(
    (u) => !(u.entity_uid === user.entity_uid && u.host_url === user.host_url),
  );
  users.unshift({ ...user, last_login: new Date().toISOString() });
  localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(users));
}

export function removeSavedUser(uid: string, hostUrl?: string) {
  // #15: remove by both entity_uid and host_url if provided
  const users = loadSavedUsers().filter((u) => {
    if (hostUrl) return !(u.entity_uid === uid && u.host_url === hostUrl);
    return u.entity_uid !== uid;
  });
  localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(users));
}

function mergeContactsByStoredOrder(
  contacts: Contact[],
  storedContacts: Contact[],
): Contact[] {
  if (storedContacts.length === 0) {
    return contacts;
  }

  const contactByUid = new Map(contacts.map((contact) => [contact.entity_uid, contact]));
  const orderedContacts: Contact[] = [];
  const seen = new Set<string>();

  for (const storedContact of storedContacts) {
    const contact = contactByUid.get(storedContact.entity_uid);
    if (!contact) {
      continue;
    }
    orderedContacts.push(contact);
    seen.add(contact.entity_uid);
  }

  for (const contact of contacts) {
    if (!seen.has(contact.entity_uid)) {
      orderedContacts.push(contact);
    }
  }

  return orderedContacts;
}

function moveContactToFront(contacts: Contact[], entityUid: string): Contact[] {
  const index = contacts.findIndex((contact) => contact.entity_uid === entityUid);
  if (index <= 0) {
    return contacts;
  }

  const nextContacts = [...contacts];
  const [contact] = nextContacts.splice(index, 1);
  nextContacts.unshift(contact);
  return nextContacts;
}

/* ---------- store ---------- */

interface AppState {
  /* auth */
  currentUser: UserProfile | null;
  currentHostUid: string | null;
  login: (user: UserProfile) => void;
  logout: () => void;
  forgetCurrentUser: () => void;

  /* contacts */
  contacts: Contact[];
  contactStatusMap: Record<string, OnlineStatus>;
  contactUnreadMap: Record<string, ContactUnreadInfo>;
  unreadMessageIds: Record<string, Set<string>>;
  loadContacts: () => Promise<void>;
  refreshOnlineStatus: () => Promise<void>;
  refreshContact: (entityUid: string) => Promise<void>;
  touchContactActivity: (entityUid: string) => void;
  addUnreadMessage: (senderUid: string, messageId: string, text: string) => void;
  clearUnread: (uid: string) => void;

  /* avatar cache */
  avatarCache: Record<string, string>;
  fetchAndCacheAvatar: (uid: string) => Promise<void>;
  removeAvatarCache: (uid: string) => void;

  /* active chat */
  activeChatUid: string | null;
  setActiveChatUid: (uid: string | null) => void;

  /* session per contact */
  contactSessionMap: Record<string, string | null>;
  setContactSession: (contactUid: string, sessionId: string | null) => void;
  getContactSession: (contactUid: string) => string | null;

  /* carbon copy */
  carbonCopyMessages: CarbonCopyMessage[];
  ccLastViewedAt: number;
  addCarbonCopy: (msg: CarbonCopyMessage) => void;
  loadCarbonCopies: (msgs: CarbonCopyMessage[]) => void;
  markCcViewed: () => void;
  clearCarbonCopies: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  /* --- auth --- */
  currentUser: loadCurrentUser(),
  currentHostUid: localStorage.getItem(STORAGE_KEY_HOST_UID),

  login(user) {
    if (user.kind !== "human") {
      persistCurrentUser(null);
      set({ currentUser: null });
      return;
    }
    persistCurrentUser(user);
    saveUserToList(user);
    set({ currentUser: user });
    // fetch host_uid for contact classification
    getEntity(user.entity_uid)
      .then((entity) => {
        if (entity.kind !== "human") {
          persistCurrentUser(null);
          set({ currentUser: null, currentHostUid: null });
          return;
        }
        set({ currentHostUid: entity.host_uid });
        localStorage.setItem(STORAGE_KEY_HOST_UID, entity.host_uid);
        // also update user profile with real data from server (#6)
        if (entity.name !== user.name || entity.kind !== user.kind) {
          const updated = { ...user, name: entity.name, kind: entity.kind };
          persistCurrentUser(updated);
          set({ currentUser: updated });
        }
      })
      .catch(() => {});
  },

  logout() {
    persistCurrentUser(null);
    localStorage.removeItem(STORAGE_KEY_CONTACTS_CACHE);
    localStorage.removeItem(STORAGE_KEY_AVATAR_CACHE);
    localStorage.removeItem(STORAGE_KEY_HOST_UID);
    set({
      currentUser: null,
      currentHostUid: null,
      contacts: [],
      contactStatusMap: {},
      contactUnreadMap: {},
      unreadMessageIds: {},
      avatarCache: {},
      activeChatUid: null,
      carbonCopyMessages: [],
    });
  },

  forgetCurrentUser() {
    const user = get().currentUser;
    if (user) {
      removeSavedUser(user.entity_uid, user.host_url);
    }
    get().logout();
  },

  /* --- contacts --- */
  contacts: [],
  contactStatusMap: {},
  contactUnreadMap: {},
  unreadMessageIds: {},

  async loadContacts() {
    const user = get().currentUser;
    if (!user) return;

    // Ensure currentHostUid is available (may be null after refresh)
    let hostUid = get().currentHostUid;
    if (!hostUid) {
      try {
        const entity = await getEntity(user.entity_uid);
        hostUid = entity.host_uid;
        set({ currentHostUid: hostUid });
        localStorage.setItem(STORAGE_KEY_HOST_UID, hostUid);
      } catch {
        // Entity no longer exists on host — clean up stale session
        get().forgetCurrentUser();
        return;
      }
    }

    const classify = (contacts: Contact[]): Contact[] =>
      contacts.map((c) => {
        let tag: EntityTag | undefined;
        if (hostUid) {
          tag = c.host_uid === hostUid ? (c.is_public ? "public" : "private") : "foreign";
        }
        return {
          ...c,
          entity_tag: tag,
          online_status: hostUid && c.host_uid === hostUid ? "online" : c.online_status,
        };
      });

    try {
      const friends = await listFriends(user.entity_uid);
      const classified = classify(friends).filter((c) => c.kind !== "arbiter");
      const orderedContacts = mergeContactsByStoredOrder(classified, loadContactsCache());
      set({ contacts: orderedContacts });
      persistContactsCache(orderedContacts);
    } catch {
      const cachedContacts = loadContactsCache();
      if (cachedContacts.length > 0) {
        set({ contacts: classify(cachedContacts) });
      }
    }
  },

  async refreshOnlineStatus() {
    const user = get().currentUser;
    if (!user) return;

    try {
      const statusMap = await getFriendsStatus(user.entity_uid);
      set({ contactStatusMap: statusMap as Record<string, OnlineStatus> });
    } catch {
      /* ignore */
    }
  },

  // #10: refresh single contact via card API
  async refreshContact(entityUid: string) {
    const contacts = get().contacts;
    const contact = contacts.find((c) => c.entity_uid === entityUid);
    if (!contact?.address?.address) return;

    try {
      const card = await getEntityCard(contact.address.address);
      set((s) => {
        const nextContacts = s.contacts.map((c) =>
          c.entity_uid === entityUid
            ? { ...c, name: card.name, description: card.description, has_avatar: card.has_avatar, metadata: card.metadata }
            : c,
        );
        persistContactsCache(nextContacts);
        return { contacts: nextContacts };
      });
    } catch {
      /* ignore — remote entity may be unreachable */
    }
  },

  touchContactActivity(entityUid) {
    set((s) => {
      const nextContacts = moveContactToFront(s.contacts, entityUid);
      if (nextContacts === s.contacts) {
        return s;
      }
      persistContactsCache(nextContacts);
      return { contacts: nextContacts };
    });
  },

  // #4: accumulate unread count with message ID deduplication
  addUnreadMessage(senderUid, messageId, text) {
    set((s) => {
      const existing = s.contactUnreadMap[senderUid];
      const existingIds = s.unreadMessageIds[senderUid] ?? new Set<string>();

      // skip if already counted
      if (existingIds.has(messageId)) return s;

      const newIds = new Set(existingIds);
      newIds.add(messageId);

      return {
        contactUnreadMap: {
          ...s.contactUnreadMap,
          [senderUid]: {
            entity_uid: senderUid,
            unread_count: (existing?.unread_count ?? 0) + 1,
            last_message: text,
            last_message_time: Date.now(),
          },
        },
        unreadMessageIds: { ...s.unreadMessageIds, [senderUid]: newIds },
      };
    });
  },

  clearUnread(uid) {
    set((s) => {
      const nextUnread = { ...s.contactUnreadMap };
      delete nextUnread[uid];
      const nextIds = { ...s.unreadMessageIds };
      delete nextIds[uid];
      return { contactUnreadMap: nextUnread, unreadMessageIds: nextIds };
    });
  },

  /* --- avatar cache --- */
  avatarCache: loadAvatarCache(),

  async fetchAndCacheAvatar(uid: string) {
    const dataUrl = await fetchAvatarAsDataUrl(uid);
    set((s) => {
      const next = { ...s.avatarCache };
      if (dataUrl) {
        next[uid] = dataUrl;
      } else {
        delete next[uid];
      }
      persistAvatarCache(next);
      return { avatarCache: next };
    });
  },

  removeAvatarCache(uid: string) {
    set((s) => {
      const next = { ...s.avatarCache };
      delete next[uid];
      persistAvatarCache(next);
      return { avatarCache: next };
    });
  },

  /* --- active chat --- */
  activeChatUid: null,
  setActiveChatUid: (uid) => set({ activeChatUid: uid }),

  /* --- session per contact --- */
  contactSessionMap: {},
  setContactSession: (contactUid, sessionId) =>
    set((s) => ({
      contactSessionMap: { ...s.contactSessionMap, [contactUid]: sessionId },
    })),
  getContactSession: (contactUid) => get().contactSessionMap[contactUid] ?? null,

  /* --- carbon copy --- */
  carbonCopyMessages: [],
  ccLastViewedAt: Date.now(),
  addCarbonCopy: (msg) =>
    set((s) => {
      if (s.carbonCopyMessages.some((m) => m.id === msg.id)) return s;
      return { carbonCopyMessages: [...s.carbonCopyMessages, msg].slice(-200) };
    }),
  loadCarbonCopies: (msgs) =>
    set((s) => {
      const existingIds = new Set(s.carbonCopyMessages.map((m) => m.id));
      const fresh = msgs.filter((m) => !existingIds.has(m.id));
      if (fresh.length === 0) return s;
      return { carbonCopyMessages: [...s.carbonCopyMessages, ...fresh].slice(0, 200) };
    }),
  markCcViewed: () => set({ ccLastViewedAt: Date.now() }),
  clearCarbonCopies: () => set({ carbonCopyMessages: [], ccLastViewedAt: Date.now() }),
}));
