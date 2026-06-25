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

interface RoomPoint {
  x: number;
  y: number;
}

interface RoomRect {
  bottom: number;
  left: number;
  right: number;
  top: number;
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

const ROOM_SIZE: RoomPoint = { x: 32, y: 28 };
const MEMBER_SPRITE_SIZE: RoomPoint = { x: 3.1, y: 3.35 };
const MEMBER_SPEECH_GAP = 0.3;
const CONFERENCE_TABLE_RECT: RoomRect = {
  bottom: 17.1,
  left: 7.04,
  right: 24.35,
  top: 10.08,
};
const CONFERENCE_RING_SLOT_TOP_LEFTS: RoomPoint[] = [
  { x: 14.45, y: 18.1 },
  { x: 9.2, y: 18.1 },
  { x: 3.6, y: 15.2 },
  { x: 3.6, y: 12.4 },
  { x: 3.6, y: 9.8 },
  { x: 8.6, y: 5.25 },
  { x: 14.45, y: 5.25 },
  { x: 20.3, y: 5.25 },
  { x: 25.3, y: 9.8 },
  { x: 25.3, y: 12.4 },
  { x: 25.3, y: 15.2 },
  { x: 19.7, y: 18.1 },
];

export const pixelOfficeSeatCapacity = CONFERENCE_RING_SLOT_TOP_LEFTS.length;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roomXToPercent(x: number): number {
  return (x / ROOM_SIZE.x) * 100;
}

function roomYToPercent(y: number): number {
  return (y / ROOM_SIZE.y) * 100;
}

function percentXToRoom(x: number): number {
  return (x / 100) * ROOM_SIZE.x;
}

function percentYToRoom(y: number): number {
  return (y / 100) * ROOM_SIZE.y;
}

function percentSeat(key: string, left: number, top: number): PixelOfficeSeat {
  const x = clamp(left, 0, 100);
  const y = clamp(top, 0, 100);

  return {
    key,
    labelX: x + roomXToPercent(MEMBER_SPRITE_SIZE.x / 2),
    labelY: y - roomYToPercent(MEMBER_SPEECH_GAP),
    miniX: x,
    miniY: y,
    x,
    y,
  };
}

function rectsOverlap(a: RoomRect, b: RoomRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function memberRect(seat: PixelOfficeSeat): RoomRect {
  const left = percentXToRoom(seat.x);
  const top = percentYToRoom(seat.y);

  return {
    bottom: top + MEMBER_SPRITE_SIZE.y,
    left,
    right: left + MEMBER_SPRITE_SIZE.x,
    top,
  };
}

function ringSlotIndexes(count: number): number[] {
  const visibleCount = Math.min(Math.max(0, count), pixelOfficeSeatCapacity);
  const usedIndexes = new Set<number>();

  return Array.from({ length: visibleCount }, (_, index) => {
    let slotIndex = Math.round((index * pixelOfficeSeatCapacity) / visibleCount) %
      pixelOfficeSeatCapacity;
    while (usedIndexes.has(slotIndex)) {
      slotIndex = (slotIndex + 1) % pixelOfficeSeatCapacity;
    }
    usedIndexes.add(slotIndex);
    return slotIndex;
  });
}

function tableRingSeat(index: number, slot: RoomPoint): PixelOfficeSeat {
  return percentSeat(`conference-${index}`, roomXToPercent(slot.x), roomYToPercent(slot.y));
}

export function buildConferenceRingSeats(count: number): PixelOfficeSeat[] {
  return ringSlotIndexes(count).map((slotIndex, index) =>
    tableRingSeat(index, CONFERENCE_RING_SLOT_TOP_LEFTS[slotIndex]),
  );
}

export function seatOverlapsConferenceTable(seat: PixelOfficeSeat): boolean {
  return rectsOverlap(memberRect(seat), CONFERENCE_TABLE_RECT);
}

export const PIXEL_OFFICE_SEATS = buildConferenceRingSeats(pixelOfficeSeatCapacity);

export function buildConferenceRingSeatInputs(
  members: GroupMemberInfo[],
): PixelRoomSeatInput[] {
  const seats = buildConferenceRingSeats(Math.min(members.length, pixelOfficeSeatCapacity));

  return members.map((member, index) => {
    const seat = seats[index] ?? PIXEL_OFFICE_SEATS[index % pixelOfficeSeatCapacity];
    return { member, left: seat.x, top: seat.y };
  });
}

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
    members: visibleSeats.map(({ left, member, top }, index) => ({
      member,
      seat: percentSeat(`conference-${index}`, left, top),
      sprite: resolveUniqueSprite(member, usedSpriteKeys),
    })),
    overflowCount: Math.max(0, seats.length - pixelOfficeSeatCapacity),
  };
}
