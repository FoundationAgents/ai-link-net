/* Profile editing dialog. */

import { useEffect, useState } from "react";
import { Camera, Loader2, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { updateEntity, uploadAvatar, deleteAvatar, getEntity } from "@/api";
import { useAppStore } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { PixelAvatar } from "@/components/ui/pixel-avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface ProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProfileDialog({ open, onOpenChange }: ProfileDialogProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const login = useAppStore((s) => s.login);
  const avatarCache = useAppStore((s) => s.avatarCache);
  const fetchAndCacheAvatar = useAppStore((s) => s.fetchAndCacheAvatar);
  const removeAvatarCache = useAppStore((s) => s.removeAvatarCache);
  const avatarSrc = currentUser ? avatarCache[currentUser.entity_uid] : undefined;

  const [name, setName] = useState(currentUser?.name ?? "");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  // #29: load current description from server when dialog opens
  useEffect(() => {
    if (open && currentUser) {
      setName(currentUser.name);
      getEntity(currentUser.entity_uid)
        .then((entity) => setDescription(entity.description ?? ""))
        .catch(() => {});
    }
  }, [open, currentUser]);

  if (!currentUser) return null;

  async function handleSave() {
    if (!currentUser || !name.trim()) return;
    setSaving(true);
    try {
      await updateEntity(currentUser.entity_uid, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      login({ ...currentUser, name: name.trim() });
      onOpenChange(false);
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !currentUser) return;
    try {
      await uploadAvatar(currentUser.entity_uid, file);
      await fetchAndCacheAvatar(currentUser.entity_uid);
    } catch {
      /* ignore */
    }
  }

  async function handleAvatarDelete() {
    if (!currentUser) return;
    try {
      await deleteAvatar(currentUser.entity_uid);
      removeAvatarCache(currentUser.entity_uid);
    } catch {
      /* ignore */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-heading">Edit Profile</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <div className="relative group">
              <PixelAvatar
                name={currentUser.name}
                kind={currentUser.kind}
                src={avatarSrc}
                size="lg"
              />
              <label
                className={cn(
                  "absolute inset-0 flex items-center justify-center rounded-full",
                  "bg-black/50 opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity",
                )}
              >
                <Camera className="h-5 w-5 text-white" />
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarUpload}
                />
              </label>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{currentUser.name}</p>
              <p className="text-xs text-muted-foreground font-mono">
                {currentUser.entity_uid}
              </p>
              <button
                onClick={handleAvatarDelete}
                className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1 transition-colors w-fit"
              >
                <Trash2 className="h-3 w-3" /> Remove avatar
              </button>
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
              rows={2}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/25 resize-none placeholder:text-muted-foreground/60"
              placeholder="Tell others about yourself..."
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
