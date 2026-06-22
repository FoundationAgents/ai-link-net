/* Agent edit dialog — edit avatar, name, and description. */

import { useEffect, useState } from "react";
import { Camera, Loader2, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { deleteAvatar, updateEntity, uploadAvatar } from "@/api";
import { useAppStore } from "@/stores/app";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PixelAvatar } from "@/components/ui/pixel-avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Contact } from "@/types";

interface AgentEditDialogProps {
  agent: Contact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

export function AgentEditDialog({
  agent,
  open,
  onOpenChange,
  onSaved,
}: AgentEditDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const avatarCache = useAppStore((s) => s.avatarCache);
  const fetchAndCacheAvatar = useAppStore((s) => s.fetchAndCacheAvatar);
  const removeAvatarCache = useAppStore((s) => s.removeAvatarCache);
  const avatarSrc = agent ? avatarCache[agent.entity_uid] : undefined;

  useEffect(() => {
    if (open && agent) {
      setName(agent.name);
      setDescription(agent.description ?? "");
    }
  }, [open, agent]);

  if (!agent) return null;

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !agent) return;
    try {
      await uploadAvatar(agent.entity_uid, file);
      await fetchAndCacheAvatar(agent.entity_uid);
    } catch {
      /* ignore */
    }
  }

  async function handleAvatarDelete() {
    if (!agent) return;
    try {
      await deleteAvatar(agent.entity_uid);
      removeAvatarCache(agent.entity_uid);
    } catch {
      /* ignore */
    }
  }

  async function handleSave() {
    if (!agent || !name.trim()) return;
    setSaving(true);
    try {
      await updateEntity(agent.entity_uid, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onSaved?.();
      onOpenChange(false);
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-heading">Edit Agent</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Avatar + info */}
          <div className="flex items-center gap-4">
            <div className="relative group">
              <PixelAvatar
                name={agent.name}
                kind={agent.kind}
                provider={typeof agent.metadata?.provider === "string" ? agent.metadata.provider : undefined}
                src={avatarSrc}
                size="lg"
              />
              <label
                className={cn(
                  "absolute inset-0 flex items-center justify-center rounded-full",
                  "bg-black/50 opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity",
                )}
              >
                <Camera className="h-4 w-4 text-white" />
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarUpload}
                />
              </label>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground font-mono truncate">
                {agent.entity_uid}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <Badge
                  variant="secondary"
                  className="text-[10px] h-4 px-1.5 bg-surface border-0"
                >
                  {agent.kind}
                </Badge>
                <button
                  onClick={handleAvatarDelete}
                  className="text-[10px] text-muted-foreground/50 hover:text-destructive flex items-center gap-0.5 transition-colors"
                >
                  <Trash2 className="h-2.5 w-2.5" /> Remove avatar
                </button>
              </div>
            </div>
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Name
            </label>
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setName(e.target.value)
              }
              className="bg-background"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/25 resize-none placeholder:text-muted-foreground/60"
              placeholder="Describe what this agent does..."
            />
          </div>

          {/* Save */}
          <Button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="w-full"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
