import type { GroupMemberInfo } from "@/api";

export interface PixelRoomSeatInput {
  member: GroupMemberInfo;
  left: number;
  top: number;
}

export interface PixelOfficeSeat {
  key: string;
  labelX: number;
  labelY: number;
  miniX: number;
  miniY: number;
  x: number;
  y: number;
}

export type PixelOfficeSpriteKey =
  | "female1"
  | "female2"
  | "male1"
  | "male2"
  | "male3"
  | "robot1"
  | "robot2";

export interface PixelOfficeSprite {
  key: PixelOfficeSpriteKey;
  variant: "standing";
}

export interface PixelOfficeMember {
  member: GroupMemberInfo;
  seat: PixelOfficeSeat;
  sprite: PixelOfficeSprite;
}

export interface PixelOfficeScene {
  members: PixelOfficeMember[];
  overflowCount: number;
}

const FALLBACK_SPRITE_KEYS: PixelOfficeSpriteKey[] = [
  "male2",
  "male3",
  "female1",
  "female2",
  "robot1",
  "robot2",
  "male1",
];

const SPRITE_KEY_BY_KIND: Partial<Record<string, PixelOfficeSpriteKey>> = {
  agent: "robot1",
  bot: "robot2",
  human: "male1",
};

export const PIXEL_OFFICE_SEATS: PixelOfficeSeat[] = [
  { key: "lead", x: 38, y: 72, labelX: 38, labelY: 81, miniX: 38, miniY: 72 },
  { key: "left-top", x: 62, y: 72, labelX: 62, labelY: 81, miniX: 62, miniY: 72 },
  { key: "right-top", x: 30, y: 64, labelX: 30, labelY: 73, miniX: 30, miniY: 64 },
  { key: "right-mid", x: 78, y: 29, labelX: 78, labelY: 38, miniX: 78, miniY: 29 },
  { key: "left-bottom", x: 36, y: 70, labelX: 36, labelY: 79, miniX: 36, miniY: 70 },
  { key: "left-mid", x: 15, y: 46, labelX: 15, labelY: 55, miniX: 15, miniY: 46 },
  { key: "right-bottom", x: 83, y: 48, labelX: 83, labelY: 57, miniX: 83, miniY: 48 },
  { key: "front", x: 57, y: 72, labelX: 57, labelY: 81, miniX: 57, miniY: 72 },
  { key: "back-left", x: 31, y: 27, labelX: 31, labelY: 36, miniX: 31, miniY: 27 },
  { key: "back-right", x: 70, y: 70, labelX: 70, labelY: 79, miniX: 70, miniY: 70 },
];

export const pixelOfficeSeatCapacity = PIXEL_OFFICE_SEATS.length;

function spriteSeed(member: GroupMemberInfo): number {
  return Array.from(`${member.entity_uid}:${member.name}`).reduce(
    (value, char) => value + char.charCodeAt(0),
    0,
  );
}

function preferredSpriteKey(member: GroupMemberInfo): PixelOfficeSpriteKey {
  const kind = member.kind.toLowerCase();
  return SPRITE_KEY_BY_KIND[kind] ?? FALLBACK_SPRITE_KEYS[
    spriteSeed(member) % FALLBACK_SPRITE_KEYS.length
  ];
}

export function resolvePixelOfficeSprite(member: GroupMemberInfo): PixelOfficeSprite {
  return { key: preferredSpriteKey(member), variant: "standing" };
}

function resolveUniqueSprite(
  member: GroupMemberInfo,
  usedSpriteKeys: Set<PixelOfficeSpriteKey>,
): PixelOfficeSprite {
  const preferredKey = preferredSpriteKey(member);
  if (!usedSpriteKeys.has(preferredKey)) {
    usedSpriteKeys.add(preferredKey);
    return { key: preferredKey, variant: "standing" };
  }

  const start = spriteSeed(member) % FALLBACK_SPRITE_KEYS.length;
  const fallbackKey = FALLBACK_SPRITE_KEYS
    .map((_, offset) => FALLBACK_SPRITE_KEYS[(start + offset) % FALLBACK_SPRITE_KEYS.length])
    .find((key) => !usedSpriteKeys.has(key));
  const key = fallbackKey ?? preferredKey;
  usedSpriteKeys.add(key);
  return { key, variant: "standing" };
}

export function buildPixelOfficeScene(seats: PixelRoomSeatInput[]): PixelOfficeScene {
  const visibleSeats = seats.slice(0, pixelOfficeSeatCapacity);
  const usedSpriteKeys = new Set<PixelOfficeSpriteKey>();

  return {
    members: visibleSeats.map(({ member }, index) => ({
      member,
      seat: PIXEL_OFFICE_SEATS[index],
      sprite: resolveUniqueSprite(member, usedSpriteKeys),
    })),
    overflowCount: Math.max(0, seats.length - pixelOfficeSeatCapacity),
  };
}
