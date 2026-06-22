/* Discover page — render host topology (parent/child) and entity mount relationships. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Compass,
  LayoutGrid,
  Loader2,
  Network,
  RefreshCw,
  Search,
  UserPlus,
} from "lucide-react";

import {
  addFriend,
  discoverEntities,
  fetchHostChildren,
  fetchHostParent,
  fetchHostWellKnown,
  getParentHost,
  listChildHosts,
  normalizeHostUrl,
} from "@/api";
import { NetworkGraph } from "@/components/effects/network-graph";
import { SpotlightCard } from "@/components/effects/spotlight-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PixelAvatar } from "@/components/ui/pixel-avatar";
import { cn, EASE_SMOOTH } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import type {
  Contact,
  DiscoverHost,
  HostEntityGroup,
  HostRelation,
  HostTopologyEdge,
  HostTopologySnapshot,
  HostWellKnown,
} from "@/types";

const STORAGE_KEY_VIEW = "fp_discover_view";
const MAX_TOPOLOGY_HOSTS = 32;

const EMPTY_TOPOLOGY: HostTopologySnapshot = {
  hosts: [],
  edges: [],
  selfUid: null,
  directParentUid: null,
  directChildUids: [],
};

const relationPriority: Record<HostRelation, number> = {
  self: 0,
  parent: 1,
  child: 2,
  remote: 3,
};

const relationLabel: Record<HostRelation, string> = {
  self: "Self",
  parent: "Parent",
  child: "Child",
  remote: "Remote",
};

const relationBadgeClass: Record<HostRelation, string> = {
  self: "bg-accent/12 text-accent",
  parent: "bg-warning/15 text-warning",
  child: "bg-success/15 text-success",
  remote: "bg-muted text-muted-foreground",
};

const cardVariants = {
  hidden: { opacity: 0, y: 16, scale: 0.98 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      delay: i * 0.04,
      duration: 0.32,
      ease: EASE_SMOOTH,
    },
  }),
};

type ViewMode = "network" | "grid";

type HostSeed = Omit<DiscoverHost, "relation">;

function fallbackHostName(uid: string): string {
  return `Host ${uid.slice(0, 8)}`;
}

function parseHostUidFromAddress(address: string | undefined): string | null {
  if (!address) return null;
  const [hostUid] = address.split(":");
  return hostUid || null;
}

function resolveEntityHostUid(entity: Contact): string {
  return parseHostUidFromAddress(entity.address?.address) ?? entity.host_uid;
}

function toHostSeed(host: HostWellKnown): HostSeed {
  return {
    uid: host.uid,
    name: host.name,
    url: normalizeHostUrl(host.url),
  };
}

function addHostSeed(hostMap: Map<string, HostSeed>, host: HostSeed): void {
  const existing = hostMap.get(host.uid);
  if (!existing) {
    hostMap.set(host.uid, host);
    return;
  }

  const nextName = existing.name || host.name;
  const nextUrl = existing.url || host.url;
  hostMap.set(host.uid, { uid: host.uid, name: nextName, url: nextUrl });
}

function addHostEdge(
  edgeSet: Set<string>,
  edges: HostTopologyEdge[],
  parentUid: string,
  childUid: string,
): void {
  if (!parentUid || !childUid || parentUid === childUid) return;
  const key = `${parentUid}->${childUid}`;
  if (edgeSet.has(key)) return;
  edgeSet.add(key);
  edges.push({ parentUid, childUid });
}

function resolveHostRelation(
  hostUid: string,
  selfUid: string | null,
  parentUid: string | null,
  childUids: Set<string>,
): HostRelation {
  if (selfUid && hostUid === selfUid) return "self";
  if (parentUid && hostUid === parentUid) return "parent";
  if (childUids.has(hostUid)) return "child";
  return "remote";
}

function byHostOrder(a: DiscoverHost, b: DiscoverHost): number {
  const relationDiff = relationPriority[a.relation] - relationPriority[b.relation];
  if (relationDiff !== 0) return relationDiff;
  return a.name.localeCompare(b.name);
}

function buildRenderedHostEdges(
  edges: HostTopologyEdge[],
  hostUidSet: Set<string>,
  selfUid: string | null,
  parentUid: string | null,
  directChildUids: Set<string>,
): HostTopologyEdge[] {
  const rendered: HostTopologyEdge[] = [];
  const edgeSet = new Set<string>();

  const addEdge = (parent: string, child: string) => {
    if (!hostUidSet.has(parent) || !hostUidSet.has(child) || parent === child) return;
    const key = `${parent}->${child}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    rendered.push({ parentUid: parent, childUid: child });
  };

  for (const edge of edges) {
    addEdge(edge.parentUid, edge.childUid);
  }

  if (!selfUid || !parentUid || !hostUidSet.has(parentUid)) {
    return rendered;
  }

  const normalized: HostTopologyEdge[] = [];
  const normalizedSet = new Set<string>();
  const addNormalizedEdge = (parent: string, child: string) => {
    if (!hostUidSet.has(parent) || !hostUidSet.has(child) || parent === child) return;
    const key = `${parent}->${child}`;
    if (normalizedSet.has(key)) return;
    normalizedSet.add(key);
    normalized.push({ parentUid: parent, childUid: child });
  };

  addNormalizedEdge(parentUid, selfUid);

  for (const childUid of directChildUids) {
    addNormalizedEdge(selfUid, childUid);
  }

  for (const hostUid of hostUidSet) {
    const isSelf = hostUid === selfUid;
    const isParent = hostUid === parentUid;
    const isDirectChild = directChildUids.has(hostUid);
    if (isSelf || isParent || isDirectChild) continue;
    addNormalizedEdge(parentUid, hostUid);
  }

  return normalized;
}

async function buildHostTopologySnapshot(
  currentHostUrl: string,
  currentHostUid: string | null,
): Promise<HostTopologySnapshot> {
  const hostMap = new Map<string, HostSeed>();
  const edges: HostTopologyEdge[] = [];
  const edgeSet = new Set<string>();
  const queue: string[] = [];
  const visited = new Set<string>();

  let selfUid: string | null = currentHostUid;
  let directParentUid: string | null = null;
  const directChildUids = new Set<string>();

  function enqueue(url: string | undefined): void {
    if (!url) return;
    const normalized = normalizeHostUrl(url);
    if (!normalized || visited.has(normalized) || queue.includes(normalized)) return;
    queue.push(normalized);
  }

  const normalizedCurrentHostUrl = normalizeHostUrl(currentHostUrl);
  if (normalizedCurrentHostUrl) {
    enqueue(normalizedCurrentHostUrl);

    try {
      const selfWellKnown = await fetchHostWellKnown(normalizedCurrentHostUrl);
      selfUid = selfWellKnown.uid;
      addHostSeed(hostMap, toHostSeed(selfWellKnown));
      enqueue(selfWellKnown.url);
    } catch {
      if (selfUid) {
        addHostSeed(hostMap, {
          uid: selfUid,
          name: fallbackHostName(selfUid),
          url: normalizedCurrentHostUrl,
        });
      }
    }
  } else if (selfUid) {
    addHostSeed(hostMap, {
      uid: selfUid,
      name: fallbackHostName(selfUid),
      url: "",
    });
  }

  const [directParent, directChildren] = await Promise.all([
    getParentHost().catch(() => null),
    listChildHosts().catch(() => [] as HostWellKnown[]),
  ]);

  if (directParent) {
    directParentUid = directParent.uid;
    addHostSeed(hostMap, toHostSeed(directParent));
    enqueue(directParent.url);
    if (selfUid) {
      addHostEdge(edgeSet, edges, directParent.uid, selfUid);
    }
  }

  for (const child of directChildren) {
    directChildUids.add(child.uid);
    addHostSeed(hostMap, toHostSeed(child));
    enqueue(child.url);
    if (selfUid) {
      addHostEdge(edgeSet, edges, selfUid, child.uid);
    }
  }

  while (queue.length > 0 && visited.size < MAX_TOPOLOGY_HOSTS) {
    const hostUrl = queue.shift();
    if (!hostUrl || visited.has(hostUrl)) continue;
    visited.add(hostUrl);

    let current: HostWellKnown;
    try {
      current = await fetchHostWellKnown(hostUrl);
    } catch {
      continue;
    }

    addHostSeed(hostMap, toHostSeed(current));
    enqueue(current.url);

    const [parent, children] = await Promise.all([
      fetchHostParent(current.url),
      fetchHostChildren(current.url),
    ]);

    if (parent) {
      addHostSeed(hostMap, toHostSeed(parent));
      addHostEdge(edgeSet, edges, parent.uid, current.uid);
      enqueue(parent.url);
    }

    for (const child of children) {
      addHostSeed(hostMap, toHostSeed(child));
      addHostEdge(edgeSet, edges, current.uid, child.uid);
      enqueue(child.url);
    }
  }

  if (selfUid && !hostMap.has(selfUid)) {
    addHostSeed(hostMap, {
      uid: selfUid,
      name: fallbackHostName(selfUid),
      url: normalizedCurrentHostUrl,
    });
  }

  return {
    hosts: Array.from(hostMap.values()),
    edges,
    selfUid,
    directParentUid,
    directChildUids: Array.from(directChildUids),
  };
}

export function DiscoverPage() {
  const currentUser = useAppStore((s) => s.currentUser);
  const currentHostUid = useAppStore((s) => s.currentHostUid);
  const contacts = useAppStore((s) => s.contacts);
  const loadContacts = useAppStore((s) => s.loadContacts);
  const avatarCache = useAppStore((s) => s.avatarCache);

  const [entities, setEntities] = useState<Contact[]>([]);
  const [topology, setTopology] = useState<HostTopologySnapshot>(EMPTY_TOPOLOGY);
  const [loading, setLoading] = useState(false);
  const [addingUid, setAddingUid] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY_VIEW);
    return stored === "grid" ? "grid" : "network";
  });

  const friendUids = useMemo(
    () => new Set(contacts.map((contact) => contact.entity_uid)),
    [contacts],
  );

  const fetchDiscover = useCallback(async () => {
    if (!currentUser) return;

    setLoading(true);
    try {
      const [discoveredEntities, snapshot] = await Promise.all([
        discoverEntities(),
        buildHostTopologySnapshot(currentUser.host_url, currentHostUid),
      ]);
      setEntities(discoveredEntities);
      setTopology(snapshot);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [currentHostUid, currentUser]);

  useEffect(() => {
    void loadContacts();
    void fetchDiscover();
  }, [fetchDiscover, loadContacts]);

  const allEntities = useMemo(() => {
    const deduped = new Map<string, Contact>();
    for (const entity of entities) {
      deduped.set(`${resolveEntityHostUid(entity)}:${entity.entity_uid}`, entity);
    }
    return Array.from(deduped.values()).filter((e) => e.kind !== "arbiter");
  }, [entities]);

  const resolvedSelfUid = topology.selfUid ?? currentHostUid ?? null;
  const directChildUidSet = useMemo(
    () => new Set(topology.directChildUids),
    [topology.directChildUids],
  );

  const hosts = useMemo(() => {
    const hostMap = new Map<string, HostSeed>();

    for (const host of topology.hosts) {
      addHostSeed(hostMap, host);
    }

    for (const entity of allEntities) {
      const hostUid = resolveEntityHostUid(entity);
      if (hostMap.has(hostUid)) continue;
      addHostSeed(hostMap, {
        uid: hostUid,
        name: fallbackHostName(hostUid),
        url: "",
      });
    }

    return Array.from(hostMap.values())
      .map<DiscoverHost>((host) => ({
        ...host,
        name: host.name || fallbackHostName(host.uid),
        relation: resolveHostRelation(
          host.uid,
          resolvedSelfUid,
          topology.directParentUid,
          directChildUidSet,
        ),
      }))
      .sort(byHostOrder);
  }, [allEntities, directChildUidSet, resolvedSelfUid, topology.directParentUid, topology.hosts]);

  const hostUidSet = useMemo(() => new Set(hosts.map((host) => host.uid)), [hosts]);

  const hostEdges = useMemo(
    () => {
      const filtered = topology.edges.filter(
        (edge) => hostUidSet.has(edge.parentUid) && hostUidSet.has(edge.childUid),
      );
      return buildRenderedHostEdges(
        filtered,
        hostUidSet,
        resolvedSelfUid,
        topology.directParentUid,
        directChildUidSet,
      );
    },
    [directChildUidSet, hostUidSet, resolvedSelfUid, topology.directParentUid, topology.edges],
  );

  const parentByChildUid = useMemo(() => {
    const parentMap = new Map<string, string>();
    for (const edge of hostEdges) {
      if (!parentMap.has(edge.childUid)) {
        parentMap.set(edge.childUid, edge.parentUid);
      }
    }
    return parentMap;
  }, [hostEdges]);

  const childCountByHostUid = useMemo(() => {
    const childCountMap = new Map<string, number>();
    for (const edge of hostEdges) {
      childCountMap.set(edge.parentUid, (childCountMap.get(edge.parentUid) ?? 0) + 1);
    }
    return childCountMap;
  }, [hostEdges]);

  const entitiesByHostUid = useMemo(() => {
    const grouped = new Map<string, Contact[]>();
    for (const host of hosts) {
      grouped.set(host.uid, []);
    }

    for (const entity of allEntities) {
      const hostUid = resolveEntityHostUid(entity);
      const list = grouped.get(hostUid) ?? [];
      list.push(entity);
      grouped.set(hostUid, list);
    }

    for (const list of grouped.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    return grouped;
  }, [allEntities, hosts]);

  const hostGroups = useMemo<HostEntityGroup[]>(
    () =>
      hosts.map((host) => ({
        host,
        entities: entitiesByHostUid.get(host.uid) ?? [],
      })),
    [entitiesByHostUid, hosts],
  );

  const addableEntityCount = useMemo(
    () =>
      allEntities.filter(
        (entity) =>
          entity.entity_uid !== currentUser?.entity_uid && !friendUids.has(entity.entity_uid),
      ).length,
    [allEntities, currentUser?.entity_uid, friendUids],
  );

  const isEmpty = hosts.length === 0 && allEntities.length === 0;

  function toggleView(mode: ViewMode) {
    setViewMode(mode);
    localStorage.setItem(STORAGE_KEY_VIEW, mode);
  }

  async function handleAdd(entity: Contact) {
    if (!currentUser) return;
    setAddingUid(entity.entity_uid);
    try {
      const hostUid = resolveEntityHostUid(entity);
      const address = entity.address?.address ?? `${hostUid}:${entity.entity_uid}`;
      await addFriend(currentUser.entity_uid, address);
      await loadContacts();
    } catch {
      /* ignore */
    } finally {
      setAddingUid(null);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 md:px-6 h-14 flex items-center justify-between border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-muted flex items-center justify-center">
            <Compass className="h-4 w-4 text-muted-foreground" />
          </div>
          <h1 className="font-heading text-sm font-semibold">Discover</h1>
          <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
            {hosts.length} hosts
          </Badge>
          <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
            {allEntities.length} entities
          </Badge>
          {addableEntityCount > 0 && (
            <Badge className="text-[10px] h-5 px-1.5 bg-accent/12 text-accent">
              {addableEntityCount} addable
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1">
          <div className="flex items-center bg-surface rounded-lg p-0.5 mr-1">
            <button
              onClick={() => toggleView("network")}
              className={cn(
                "flex items-center justify-center h-7 w-7 rounded-md transition-all duration-200",
                viewMode === "network"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-label="Switch to network view"
              title="Network view"
            >
              <Network className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => toggleView("grid")}
              className={cn(
                "flex items-center justify-center h-7 w-7 rounded-md transition-all duration-200",
                viewMode === "grid"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-label="Switch to grid view"
              title="Grid view"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={fetchDiscover}
            disabled={loading}
            aria-label="Refresh discover data"
            title="Refresh"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-hidden relative">
        {loading && isEmpty ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5 }}
            >
              <div className="h-20 w-20 rounded-2xl bg-muted border border-border flex items-center justify-center mb-4">
                <Search className="h-10 w-10 text-muted-foreground/20" />
              </div>
            </motion.div>
            <p className="text-sm text-muted-foreground/60">No topology discovered yet</p>
            <p className="text-xs text-muted-foreground/40 mt-1">
              Start parent/child hosts and register public entities
            </p>
          </div>
        ) : viewMode === "network" ? (
          <NetworkGraph
            hosts={hosts}
            hostEdges={hostEdges}
            entities={allEntities}
            friends={contacts}
            currentEntityUid={currentUser?.entity_uid ?? ""}
            onAddFriend={handleAdd}
            addingUid={addingUid}
          />
        ) : (
          <div className="h-full overflow-auto p-4 md:p-6">
            <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
              {hostGroups.map((group, index) => {
                const parentUid = parentByChildUid.get(group.host.uid);
                const parentHost = hosts.find((host) => host.uid === parentUid);
                const childCount = childCountByHostUid.get(group.host.uid) ?? 0;

                return (
                  <motion.div
                    key={group.host.uid}
                    custom={index}
                    variants={cardVariants}
                    initial="hidden"
                    animate="show"
                  >
                    <SpotlightCard className="p-4 md:p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{group.host.name}</p>
                          <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                            {group.host.uid}
                          </p>
                        </div>
                        <Badge
                          variant="secondary"
                          className={cn("text-[10px] h-5 px-1.5 border-0", relationBadgeClass[group.host.relation])}
                        >
                          {relationLabel[group.host.relation]}
                        </Badge>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="px-2 py-0.5 rounded-full bg-surface border border-border">
                          Parent: {parentHost?.name ?? (group.host.relation === "self" ? "-" : "Unknown")}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-surface border border-border">
                          Children: {childCount}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-surface border border-border">
                          Entities: {group.entities.length}
                        </span>
                      </div>

                      {group.host.url && (
                        <p className="text-[11px] text-muted-foreground/70 mt-2 truncate">
                          {group.host.url}
                        </p>
                      )}

                      <div className="mt-4 space-y-2">
                        {group.entities.length === 0 ? (
                          <p className="text-xs text-muted-foreground/60">No entities mounted on this host</p>
                        ) : (
                          group.entities.map((entity) => {
                            const isSelf = entity.entity_uid === currentUser?.entity_uid;
                            const isFriend = friendUids.has(entity.entity_uid);
                            const canAdd = !isSelf && !isFriend;

                            return (
                              <div
                                key={`${resolveEntityHostUid(entity)}:${entity.entity_uid}`}
                                className="flex items-center gap-3 p-2.5 rounded-lg bg-surface/70 border border-border"
                              >
                                <PixelAvatar
                                  name={entity.name}
                                  kind={entity.kind}
                                  provider={typeof entity.metadata?.provider === "string" ? entity.metadata.provider : undefined}
                                  src={avatarCache[entity.entity_uid]}
                                  size="sm"
                                />

                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-medium truncate">{entity.name}</p>
                                  <div className="flex items-center gap-1.5 mt-1">
                                    <Badge variant="secondary" className="text-[10px] h-4 px-1.5 border-0 bg-card">
                                      {entity.kind}
                                    </Badge>
                                    {isSelf ? (
                                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5 border-0 bg-accent/12 text-accent">
                                        You
                                      </Badge>
                                    ) : isFriend ? (
                                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5 border-0 bg-success/15 text-success">
                                        Connected
                                      </Badge>
                                    ) : null}
                                  </div>
                                </div>

                                <Button
                                  size="sm"
                                  className={cn(
                                    "shrink-0 h-7 px-2.5 border-0",
                                    canAdd
                                      ? "bg-accent/10 text-accent hover:bg-accent/20"
                                      : "bg-surface text-muted-foreground",
                                  )}
                                  disabled={!canAdd || addingUid === entity.entity_uid}
                                  onClick={() => handleAdd(entity)}
                                  aria-label={`Add ${entity.name} as friend`}
                                >
                                  {addingUid === entity.entity_uid ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : canAdd ? (
                                    <UserPlus className="h-3.5 w-3.5" />
                                  ) : (
                                    "-"
                                  )}
                                </Button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </SpotlightCard>
                  </motion.div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
