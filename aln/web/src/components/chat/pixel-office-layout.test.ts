import { describe, expect, it } from "vitest";

import {
  buildConferenceRingSeatInputs,
  buildPixelOfficeScene,
  PIXEL_OFFICE_SEATS,
  pixelOfficeSeatCapacity,
  resolvePixelOfficeSprite,
  seatOverlapsConferenceTable,
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
  it("assigns members to evenly spaced conference seats", () => {
    const scene = buildPixelOfficeScene(
      buildConferenceRingSeatInputs([
        member("alice", "Alice"),
        member("bob", "Bob", "agent"),
        member("cora", "Cora"),
      ]),
    );

    expect(scene.members.map((item) => item.member.entity_uid)).toEqual([
      "alice",
      "bob",
      "cora",
    ]);
    expect(scene.members.map((item) => item.seat.key)).toEqual([
      "conference-0",
      "conference-1",
      "conference-2",
    ]);
    expect(scene.members[0].seat.x).toBeCloseTo(45.16, 2);
    expect(scene.members[0].seat.y).toBeCloseTo(64.64, 2);
    expect(scene.members[1].seat.x).toBeCloseTo(11.25, 2);
    expect(scene.members[1].seat.y).toBeCloseTo(35, 2);
    expect(scene.members[2].seat.x).toBeCloseTo(79.06, 2);
    expect(scene.members[2].seat.y).toBeCloseTo(35, 2);
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

  it("keeps the generated seat ring around the conference table", () => {
    const xs = PIXEL_OFFICE_SEATS.map((seat) => seat.x);
    const ys = PIXEL_OFFICE_SEATS.map((seat) => seat.y);

    expect(Math.min(...xs)).toBeGreaterThanOrEqual(11);
    expect(Math.max(...xs)).toBeLessThanOrEqual(80);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(18);
    expect(Math.max(...ys)).toBeLessThanOrEqual(65);
    expect(PIXEL_OFFICE_SEATS[0]).toMatchObject({ key: "conference-0" });
    expect(PIXEL_OFFICE_SEATS[0].x).toBeCloseTo(45.16, 2);
    expect(PIXEL_OFFICE_SEATS[0].y).toBeCloseTo(64.64, 2);
    expect(PIXEL_OFFICE_SEATS[3].x).toBeCloseTo(11.25, 2);
    expect(PIXEL_OFFICE_SEATS[3].y).toBeCloseTo(44.29, 2);
    expect(PIXEL_OFFICE_SEATS[6].x).toBeCloseTo(45.16, 2);
    expect(PIXEL_OFFICE_SEATS[6].y).toBeCloseTo(18.75, 2);
    expect(PIXEL_OFFICE_SEATS[9].x).toBeCloseTo(79.06, 2);
    expect(PIXEL_OFFICE_SEATS[9].y).toBeCloseTo(44.29, 2);
  });

  it("keeps every supported member count outside the table collision box", () => {
    for (let count = 1; count <= pixelOfficeSeatCapacity; count += 1) {
      const scene = buildPixelOfficeScene(
        buildConferenceRingSeatInputs(
          Array.from({ length: count }, (_, index) =>
            member(`uid-${count}-${index}`, `Member ${index}`),
          ),
        ),
      );

      expect(scene.members.some((item) => seatOverlapsConferenceTable(item.seat))).toBe(
        false,
      );
    }
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
