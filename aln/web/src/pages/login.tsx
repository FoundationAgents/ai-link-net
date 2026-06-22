/* Login page 鈥?clean, minimal first impression. */

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Trash2, ChevronRight } from "lucide-react";

import { cn, EASE_SMOOTH } from "@/lib/utils";
import { useAppStore, loadSavedUsers, removeSavedUser } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PixelAvatar } from "@/components/ui/pixel-avatar";
import type { Contact, UserProfile } from "@/types";

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.06, delayChildren: 0.2 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: EASE_SMOOTH },
  },
};

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const login = useAppStore((s) => s.login);
  const currentUser = useAppStore((s) => s.currentUser);

  const [hostUrl, setHostUrl] = useState("http://localhost:7001");
  const [entities, setEntities] = useState<Contact[]>([]);
  const [savedUsers, setSavedUsers] = useState<UserProfile[]>(loadSavedUsers());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEntities, setShowEntities] = useState(false);

  // auto-login from URL params 鈥?fetch real entity info from server (#6)
  useEffect(() => {
    const uid = searchParams.get("entity_uid");
    const url = searchParams.get("host_url");
    if (!uid || !url) return;

    const decodedUrl = decodeURIComponent(url);
    fetch(`${decodedUrl}/api/v1/entities/${uid}`)
      .then((res) => res.json())
      .then((json: { data?: { name?: string; kind?: string; metadata?: Record<string, unknown> } }) => {
        login({
          entity_uid: uid,
          name: json.data?.name ?? uid,
          kind: (json.data?.kind as UserProfile["kind"]) ?? "human",
          host_url: decodedUrl,
          metadata: json.data?.metadata,
        });
        navigate("/chat");
      })
      .catch(() => {
        login({ entity_uid: uid, name: uid, kind: "human", host_url: decodedUrl });
        navigate("/chat");
      });
  }, [searchParams, login, navigate]);

  useEffect(() => {
    if (currentUser) navigate("/chat");
  }, [currentUser, navigate]);

  async function handleLoadEntities() {
    setLoading(true);
    setError(null);
    try {
      const apiBase = hostUrl.replace(/\/$/, "");
      const res = await fetch(`${apiBase}/api/v1/entities`);
      const json = (await res.json()) as { data?: Contact[] };
      setEntities(json.data ?? []);
      setShowEntities(true);
    } catch {
      setError("Cannot connect to host");
    } finally {
      setLoading(false);
    }
  }

  function handleSelectEntity(entity: Contact) {
    login({
      entity_uid: entity.entity_uid,
      name: entity.name,
      kind: entity.kind,
      host_url: hostUrl.replace(/\/$/, ""),
      metadata: entity.metadata,
    });
    navigate("/chat");
  }

  function handleSelectSaved(user: UserProfile) {
    login(user);
    navigate("/chat");
  }

  function handleRemoveSaved(uid: string) {
    removeSavedUser(uid);
    setSavedUsers(loadSavedUsers());
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE_SMOOTH }}
          className="text-center mb-10"
        >
          <div className="pixel-brand-mark mx-auto mb-5 h-12 w-12 text-sm" aria-label="AI Office">
            AI
          </div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Foundation Protocol
          </h1>
          <p className="text-sm text-muted-foreground mt-2">
            The open protocol for AI agent collaboration
          </p>
        </motion.div>

        {/* Card */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className={cn(
            "rounded-xl p-5",
            "bg-card border border-border",
            "shadow-sm",
          )}
        >
          {/* Saved users */}
          <AnimatePresence>
            {savedUsers.length > 0 && !showEntities && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-5"
              >
                <h2 className="text-xs font-medium text-muted-foreground mb-3">
                  Recent
                </h2>
                <div className="space-y-1">
                  {savedUsers.map((user, i) => (
                    <motion.div
                      key={`${user.entity_uid}-${user.host_url}`}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.3 + i * 0.04, duration: 0.25 }}
                      className={cn(
                        "group flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
                        "hover:bg-surface-hover transition-colors duration-150",
                      )}
                      onClick={() => handleSelectSaved(user)}
                    >
                      <PixelAvatar name={user.name} kind={user.kind} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{user.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate font-mono">
                          {user.host_url}
                        </p>
                      </div>
                      <button
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          handleRemoveSaved(user.entity_uid);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-destructive transition-all"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Connect to host */}
          <motion.div variants={itemVariants}>
            <h2 className="text-xs font-medium text-muted-foreground mb-3">
              Connect to Host
            </h2>
            <div className="flex gap-2">
              <Input
                value={hostUrl}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setHostUrl(e.target.value)
                }
                placeholder="http://localhost:7001"
                className="font-mono text-sm bg-muted border-border"
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") handleLoadEntities();
                }}
              />
              <Button
                onClick={handleLoadEntities}
                disabled={loading}
                size="icon"
                className="shrink-0 bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
              >
                {loading ? (
                  <span className="h-4 w-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
              </Button>
            </div>

            {error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-xs text-destructive mt-2"
              >
                {error}
              </motion.p>
            )}
          </motion.div>

          {/* Entity list */}
          <AnimatePresence>
            {showEntities && entities.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-4 space-y-1"
              >
                <h2 className="text-xs font-medium text-muted-foreground mb-2">
                  Select Entity
                </h2>
                {entities.map((entity, i) => (
                  <motion.button
                    key={entity.entity_uid}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      delay: i * 0.04,
                      duration: 0.2,
                      ease: EASE_SMOOTH,
                    }}
                    onClick={() => handleSelectEntity(entity)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left",
                      "hover:bg-surface-hover transition-colors duration-150",
                    )}
                  >
                    <PixelAvatar
                      name={entity.name}
                      kind={entity.kind}
                      provider={typeof entity.metadata?.provider === "string" ? entity.metadata.provider : undefined}
                      size="sm"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{entity.name}</p>
                      <p className="text-[11px] text-muted-foreground">{entity.kind}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/30" />
                  </motion.button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Footer */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.4 }}
          className="text-center text-[11px] text-muted-foreground/40 mt-6 font-mono"
        >
          Foundation Protocol v0.1
        </motion.p>
      </div>
    </div>
  );
}
