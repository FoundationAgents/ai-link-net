import { describe, expect, it } from "vitest";

import {
  buildPixelOfficeScene,
  PIXEL_OFFICE_SEATS,
  pixelOfficeSeatCapacity,
  resolvePixelOfficeSprite,
} from "@/components/chat/pixel-office-layout";
import type { GroupMemberInfo } from "@/api";

function member(
  entityUid: string,
  name: string,
  kind = "human",
  role = "member",
): GroupMemberInfo {
  return {
    address: `host:${entityUid}`,
    can_invite: false,
    can_remove: false,
    can_send: true,
    entity_uid: entityUid,
    host_uid: "host",
    kind,
    name,
    role,
    status: "active",
  };
}

describe("pixel office room layout", () => {
  it("assigns members to stable office seats", () => {
    const scene = buildPixelOfficeScene([
      { member: member("alice", "Alice"), left: 0, top: 0 },
      { member: member("bob", "Bob", "agent"), left: 0, top: 0 },
      { member: member("cora", "Cora"), left: 0, top: 0 },
    ]);

    expect(scene.members.map((item) => item.member.entity_uid)).toEqual([
      "alice",
      "bob",
      "cora",
    ]);
    expect(scene.members.map((item) => item.seat.key)).toEqual([
      "lead",
      "left-top",
      "right-top",
    ]);
    expect(scene.members[0].seat).toMatchObject({ x: 38, y: 72 });
    expect(scene.members[1].seat).toMatchObject({ x: 62, y: 72 });
    expect(scene.members[1].sprite).toMatchObject({
      key: "robot1",
      variant: "standing",
    });
  });

  it("caps visible seats and reports overflow count", () => {
    const members = Array.from({ length: pixelOfficeSeatCapacity + 3 }, (_, index) => ({
      member: member(`uid-${index}`, `Member ${index}`),
      left: 0,
      top: 0,
    }));

    const scene = buildPixelOfficeScene(members);

    expect(scene.members).toHaveLength(pixelOfficeSeatCapacity);
    expect(scene.overflowCount).toBe(3);
  });

  it("places members like the official scene example", () => {
    const xs = PIXEL_OFFICE_SEATS.map((seat) => seat.x);
    const ys = PIXEL_OFFICE_SEATS.map((seat) => seat.y);
    const seatByKey = new Map(PIXEL_OFFICE_SEATS.map((seat) => [seat.key, seat]));

    expect(Math.min(...xs)).toBeGreaterThanOrEqual(12);
    expect(Math.max(...xs)).toBeLessThanOrEqual(88);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(26);
    expect(Math.max(...ys)).toBeLessThanOrEqual(78);
    expect(seatByKey.get("lead")).toMatchObject({ x: 38, y: 72 });
    expect(seatByKey.get("left-top")).toMatchObject({ x: 62, y: 72 });
    expect(seatByKey.get("right-top")).toMatchObject({ x: 30, y: 64 });
    expect(seatByKey.get("right-mid")!.x).toBeGreaterThan(70);
    expect(seatByKey.get("front")!.y).toBeGreaterThan(68);
  });

  it("maps humans and machine entities to different sprite variants", () => {
    expect(resolvePixelOfficeSprite(member("human", "Human")).key).toBe("male1");
    expect(resolvePixelOfficeSprite(member("agent", "Agent", "agent")).key).toBe(
      "robot1",
    );
    expect(resolvePixelOfficeSprite(member("bot", "Bot", "bot")).key).toBe(
      "robot2",
    );
    expect(resolvePixelOfficeSprite(member("tool", "Tool", "tool")).variant).toBe(
      "standing",
    );
  });

  it("keeps visible room sprites unique while assigning fallback kinds", () => {
    const scene = buildPixelOfficeScene([
      { member: member("agent", "Agent", "agent"), left: 0, top: 0 },
      { member: member("bot", "Bot", "bot"), left: 0, top: 0 },
      { member: member("human", "Human", "human"), left: 0, top: 0 },
      { member: member("tool", "Tool", "tool"), left: 0, top: 0 },
      { member: member("resource", "Resource", "resource"), left: 0, top: 0 },
      { member: member("service", "Service", "service"), left: 0, top: 0 },
      { member: member("org", "Org", "organization"), left: 0, top: 0 },
    ]);

    const keys = scene.members.map((item) => item.sprite.key);

    expect(keys.slice(0, 3)).toEqual(["robot1", "robot2", "male1"]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
