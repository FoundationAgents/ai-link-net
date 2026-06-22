/* My Entities page — manage owned entities + inline registration. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronRight, Edit2, Loader2, RefreshCw, Trash2, UserPlus, Users } from "lucide-react";

import { cn, EASE_SMOOTH } from "@/lib/utils";
import { listEntities, deleteEntity } from "@/api";
import { useAppStore } from "@/stores/app";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PixelAvatar } from "@/components/ui/pixel-avatar";
import { SpotlightCard } from "@/components/effects/spotlight-card";
import { AgentEditDialog } from "@/components/agents/agent-edit-dialog";
import { RegisterFlow } from "@/components/entities/register-flow";
import type { Contact } from "@/types";

const cardVariants = {
  hidden: { opacity: 0, y: 16, scale: 0.96 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { delay: i * 0.06, duration: 0.35, ease: EASE_SMOOTH },
  }),
};

export function MyEntitiesPage() {
  const currentUser = useAppStore((s) => s.currentUser);
  const avatarCache = useAppStore((s) => s.avatarCache);
  const fetchAndCacheAvatar = useAppStore((s) => s.fetchAndCacheAvatar);

  const [entities, setEntities] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<Contact | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [expandedOrgs, setExpandedOrgs] = useState<Set<string> | null>(null);

  const fetchEntities = useCallback(async () => {
    setLoading(true);
    try {
      const all = await listEntities();
      setEntities(all.filter((e) => e.entity_uid !== currentUser?.entity_uid && e.kind !== "arbiter"));
      for (const e of all) {
        if (e.has_avatar && !useAppStore.getState().avatarCache[e.entity_uid]) {
          fetchAndCacheAvatar(e.entity_uid);
        }
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [currentUser?.entity_uid, fetchAndCacheAvatar]);

  useEffect(() => {
    fetchEntities();
  }, [fetchEntities]);

  const { soloEntities, orgGroups } = useMemo(() => {
    const solo: Contact[] = [];
    const orgs = new Map<string, { name: string; members: Contact[] }>();
    for (const e of entities) {
      const orgId = typeof e.metadata?.organization_id === "string" ? e.metadata.organization_id : "";
      const orgName = typeof e.metadata?.organization === "string" ? e.metadata.organization : "";
      if (orgId) {
        const existing = orgs.get(orgId) ?? { name: orgName, members: [] };
        existing.members.push(e);
        orgs.set(orgId, existing);
      } else {
        solo.push(e);
      }
    }
    return {
      soloEntities: solo,
      orgGroups: [...orgs.entries()].map(([id, { name, members }]) => ({ id, name, members })),
    };
  }, [entities]);

  const toggleOrg = (id: string) =>
    setExpandedOrgs((prev) => {
      const current = prev ?? new Set(orgGroups.map((g) => g.id));
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const isEmpty = !loading && entities.length === 0;
  const showRegister = registering || isEmpty;

  function handleEdit(entity: Contact) {
    setEditingAgent(entity);
    setDialogOpen(true);
  }

  async function handleDelete(entity: Contact) {
    if (deleting) return;
    if (!confirm(`Delete "${entity.name}"?`)) return;
    setDeleting(entity.entity_uid);
    try {
      await deleteEntity(entity.entity_uid);
      setEntities((prev) => prev.filter((e) => e.entity_uid !== entity.entity_uid));
    } catch {
      /* ignore */
    } finally {
      setDeleting(null);
    }
  }

  async function handleDeleteOrg(orgName: string, members: Contact[]) {
    if (deleting) return;
    if (!confirm(`Delete all ${members.length} members of "${orgName}"?`)) return;
    setDeleting(orgName);
    try {
      await Promise.all(members.map((m) => deleteEntity(m.entity_uid)));
      const uids = new Set(members.map((m) => m.entity_uid));
      setEntities((prev) => prev.filter((e) => !uids.has(e.entity_uid)));
    } catch {
      fetchEntities();
    } finally {
      setDeleting(null);
    }
  }

  if (showRegister) {
    return (
      <RegisterFlow
        onCreated={() => {
          setRegistering(false);
          fetchEntities();
        }}
        onCancel={isEmpty ? undefined : () => setRegistering(false)}
        showBackOnStep1={!isEmpty}
      />
    );
  }

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 md:px-6 h-14 flex items-center justify-between border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-muted flex items-center justify-center">
            <Users className="h-4 w-4 text-muted-foreground" />
          </div>
          <h1 className="font-heading text-sm font-semibold">My Entities</h1>
          <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
            {entities.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setRegistering(true)}
          >
            <UserPlus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={fetchEntities}
            disabled={loading}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {loading && entities.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="p-4 md:p-6 space-y-4">
            {/* Solo entities */}
            {soloEntities.length > 0 && (
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {soloEntities.map((entity, i) => (
                  <motion.div
                    key={entity.entity_uid}
                    custom={i}
                    variants={cardVariants}
                    initial="hidden"
                    animate="show"
                    whileHover={{ y: -3, transition: { duration: 0.2 } }}
                  >
                    <SpotlightCard
                      className={cn(
                        "flex items-center gap-3 p-4",
                        "hover:border-accent/20 hover:shadow-sm",
                        "transition-[border-color,box-shadow] duration-300",
                      )}
                    >
                      <PixelAvatar
                        name={entity.name}
                        kind={entity.kind}
                        provider={typeof entity.metadata?.provider === "string" ? entity.metadata.provider : undefined}
                        src={avatarCache[entity.entity_uid]}
                        size="md"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{entity.name}</p>
                        <p className="text-xs text-muted-foreground/60 truncate mt-0.5">{entity.description || "No description"}</p>
                        <Badge variant="secondary" className="mt-1 text-[10px] h-4 px-1.5 bg-surface border-0">{entity.kind}</Badge>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => handleEdit(entity)}>
                          <Edit2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(entity)} disabled={deleting === entity.entity_uid}>
                          {deleting === entity.entity_uid ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    </SpotlightCard>
                  </motion.div>
                ))}
              </div>
            )}

            {/* Organization groups */}
            {orgGroups.map((org) => {
              const expanded = expandedOrgs === null || expandedOrgs.has(org.id);
              return (
                <div key={org.id} className="rounded-xl border border-border bg-surface/50">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <button
                      onClick={() => toggleOrg(org.id)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
                    >
                      <Users className="h-4 w-4 text-primary/60 shrink-0" />
                      <span className="text-sm font-semibold text-foreground/80 flex-1 truncate">{org.name}</span>
                      <Badge variant="secondary" className="text-[10px] h-5 px-1.5">{org.members.length}</Badge>
                      {expanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground/40 hover:text-destructive shrink-0"
                      onClick={() => handleDeleteOrg(org.name, org.members)}
                      disabled={deleting === org.id}
                    >
                      {deleting === org.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                  <AnimatePresence>
                    {expanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: EASE_SMOOTH }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4 grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                          {org.members.map((entity, i) => (
                            <motion.div
                              key={entity.entity_uid}
                              custom={i}
                              variants={cardVariants}
                              initial="hidden"
                              animate="show"
                              whileHover={{ y: -3, transition: { duration: 0.2 } }}
                            >
                              <SpotlightCard
                                className={cn(
                                  "flex items-center gap-3 p-4",
                                  "hover:border-accent/20 hover:shadow-sm",
                                  "transition-[border-color,box-shadow] duration-300",
                                )}
                              >
                                <PixelAvatar
                                  name={entity.name}
                                  kind={entity.kind}
                                  provider={typeof entity.metadata?.provider === "string" ? entity.metadata.provider : undefined}
                                  src={avatarCache[entity.entity_uid]}
                                  size="md"
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">{entity.name}</p>
                                  <p className="text-xs text-muted-foreground/60 truncate mt-0.5">{entity.description || "No description"}</p>
                                  <Badge variant="secondary" className="mt-1 text-[10px] h-4 px-1.5 bg-surface border-0">{entity.kind}</Badge>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => handleEdit(entity)}>
                                    <Edit2 className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(entity)} disabled={deleting === entity.entity_uid}>
                                    {deleting === entity.entity_uid ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                  </Button>
                                </div>
                              </SpotlightCard>
                            </motion.div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AgentEditDialog
        agent={editingAgent}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={fetchEntities}
      />
    </div>
  );
}
