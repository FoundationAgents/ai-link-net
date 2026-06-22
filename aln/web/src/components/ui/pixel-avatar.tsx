import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

type PixelAvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

interface PixelAvatarProps {
  name: string;
  kind?: string;
  provider?: string;
  src?: string;
  size?: PixelAvatarSize;
  className?: string;
  title?: string;
}

const SIZE_CLASS: Record<PixelAvatarSize, string> = {
  xs: "h-5 w-5",
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-14 w-14",
  xl: "h-20 w-20",
};

const SKIN = ["#f5c18b", "#d99a63", "#a7653c", "#f0d0a1"];
const HAIR = ["#2e1b13", "#5a3425", "#151923", "#6f3b92", "#24415c", "#243d2d"];
const CLOTH = ["#2f6fd6", "#2fa56f", "#c66a43", "#8a56cf", "#d3a43a", "#2aa7a7"];
const ROBOT = ["#55d9ff", "#69f2b4", "#f3cf5a", "#e46988", "#8e8cff"];

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick(values: string[], hash: number, offset: number): string {
  return values[(hash + offset) % values.length];
}

function isMachineKind(kind?: string): boolean {
  return ["agent", "tool", "service", "resource", "bot"].includes((kind ?? "").toLowerCase());
}

export function PixelAvatar({
  name,
  kind = "agent",
  provider = "",
  src,
  size = "md",
  className,
  title,
}: PixelAvatarProps) {
  const seed = `${name}:${kind}:${provider}`;
  const hash = hashText(seed);
  const machine = isMachineKind(kind);
  const style = {
    "--pixel-skin": pick(SKIN, hash, 1),
    "--pixel-hair": pick(HAIR, hash, 5),
    "--pixel-cloth": pick(CLOTH, hash, 9),
    "--pixel-accent": pick(ROBOT, hash, provider ? provider.length : 13),
    "--pixel-bg": machine ? "#243346" : "#2b405c",
  } as CSSProperties;

  return (
    <div
      className={cn("pixel-avatar", SIZE_CLASS[size], className)}
      style={style}
      title={title ?? name}
      aria-label={title ?? name}
    >
      {src ? (
        <img src={src} alt="" className="pixel-avatar__image" />
      ) : machine ? (
        <div className="pixel-avatar__sprite pixel-avatar__sprite--robot">
          <span className="pixel-avatar__antenna" />
          <span className="pixel-avatar__robot-ear pixel-avatar__robot-ear--left" />
          <span className="pixel-avatar__robot-ear pixel-avatar__robot-ear--right" />
          <span className="pixel-avatar__robot-face" />
          <span className="pixel-avatar__robot-eye pixel-avatar__robot-eye--left" />
          <span className="pixel-avatar__robot-eye pixel-avatar__robot-eye--right" />
          <span className="pixel-avatar__robot-mouth" />
          <span className="pixel-avatar__robot-body" />
        </div>
      ) : (
        <div className="pixel-avatar__sprite pixel-avatar__sprite--human">
          <span className="pixel-avatar__hair pixel-avatar__hair--top" />
          <span className="pixel-avatar__hair pixel-avatar__hair--left" />
          <span className="pixel-avatar__hair pixel-avatar__hair--right" />
          <span className="pixel-avatar__face" />
          <span className="pixel-avatar__eye pixel-avatar__eye--left" />
          <span className="pixel-avatar__eye pixel-avatar__eye--right" />
          <span className="pixel-avatar__mouth" />
          <span className="pixel-avatar__shirt" />
        </div>
      )}
    </div>
  );
}
