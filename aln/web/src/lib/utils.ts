import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const INTEGER_FORMATTER = new Intl.NumberFormat("en-US");
const COMPACT_TOKEN_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  notation: "compact",
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format whole-number counters with thousands separators. */
export function formatInteger(value: number): string {
  return INTEGER_FORMATTER.format(Math.max(0, Math.round(value)));
}

/** Format token counters compactly once they reach million scale. */
export function formatCompactTokenCount(value: number): string {
  const tokens = Math.max(0, Math.round(value));
  return tokens >= 1_000_000
    ? COMPACT_TOKEN_FORMATTER.format(tokens)
    : formatInteger(tokens);
}

/** Extract entity_uid from FPAddress "host_uid:entity_uid". */
export function extractEntityUid(address: string): string {
  return address.includes(":") ? address.split(":")[1] : address;
}

/** Normalize timestamp — handle epoch seconds/ms and append 'Z' for ISO strings. */
export function normalizeTimestamp(ts?: string | number): string | undefined {
  if (ts == null || ts === "") return undefined;
  const n = Number(ts);
  if (!Number.isNaN(n) && n > 1e9) {
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  const s = String(ts);
  if (!s.endsWith("Z") && !s.includes("+")) return s + "Z";
  return s;
}

/** Avatar fallback class by entity kind. */
export function kindAvatarClass(kind: string): string {
  return kind === "agent"
    ? "bg-accent/10 text-accent"
    : "bg-muted text-muted-foreground";
}

/** Shared easing curve for premium micro-interactions. */
export const EASE_SMOOTH: [number, number, number, number] = [0.21, 0.47, 0.32, 0.98];
