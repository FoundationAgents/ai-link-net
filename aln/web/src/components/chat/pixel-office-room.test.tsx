import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ComponentProps } from "react";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PixelOfficeRoom } from "@/components/chat/pixel-office-room";
import type { GroupMemberInfo } from "@/api";
import type { Message } from "@/types";

const GLOBAL_CSS = readFileSync(
  resolve(__dirname, "../../styles/globals.css"),
  "utf-8",
);

function member(entityUid: string, name: string): GroupMemberInfo {
  return {
    address: `host:${entityUid}`,
    can_invite: false,
    can_remove: false,
    can_send: true,
    entity_uid: entityUid,
    host_uid: "host",
    kind: "agent",
    name,
    role: "member",
    status: "active",
  };
}

function message(sender: string): Message {
  return {
    message_id: "message-1",
    payload: { text: "A short update from this agent." },
    recipient: ["host:human"],
    sender,
    timestamp: new Date("2026-06-22T00:00:00.000Z").toISOString(),
  };
}

function renderRoom(
  props: Partial<ComponentProps<typeof PixelOfficeRoom>> = {},
) {
  return render(
    <PixelOfficeRoom
      roomName="Test room"
      seats={[]}
      latestMessage={undefined}
      recentByMember={new Map()}
      activeSpeakerUid=""
      avatarByUid={new Map()}
      providerByUid={new Map()}
      turnCount={0}
      tokenLabel="tokens"
      tokenCount={0}
      {...props}
    />,
  );
}

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = Array.from(
    GLOBAL_CSS.matchAll(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "g")),
  );
  return matches.at(-1)?.groups?.body ?? "";
}

describe("PixelOfficeRoom", () => {
  it("uses pixel office environment sprites for the bottom window and door", () => {
    const { container } = renderRoom();

    const door = container.querySelector<HTMLImageElement>(".pixel-room__bottom-door-sprite");

    expect(door).not.toBeNull();
    expect(door?.getAttribute("src")).toContain("door-tile.png");
  });

  it("uses the pixel office environment floor tile", () => {
    const { container } = renderRoom();

    const floor = container.querySelector<HTMLElement>(".pixel-room__floor");

    expect(floor).not.toBeNull();
    expect(cssRule(".pixel-room__floor")).toContain(
      'background-image: url("/vendor/pixel-office/generated/floor-tile.png")',
    );
    expect(cssRule(".pixel-room__floor")).toContain("background-size: auto 20%");
  });

  it("uses a clean pixel office wall with an elevator door", () => {
    const { container } = renderRoom();

    const wall = container.querySelector<HTMLElement>(".pixel-room__wall");
    const elevator = container.querySelector<HTMLImageElement>(".pixel-room__elevator-door");

    expect(wall).not.toBeNull();
    expect(cssRule(".pixel-room__wall")).toContain(
      'background-image: url("/vendor/pixel-office/generated/wall-tile.png")',
    );
    expect(cssRule(".pixel-room__wall")).toContain("background-size: auto 100%");
    expect(elevator).not.toBeNull();
    expect(elevator?.getAttribute("src")).toContain("elevator-tile.png");
    expect(container.querySelector(".pixel-room__whiteboard")).toBeNull();
    expect(container.querySelector(".pixel-room__cabinet")).toBeNull();
    expect(container.querySelector(".pixel-room__clock")).toBeNull();
  });

  it("uses a 1:5:1 wall, floor, and window layout ratio", () => {
    expect(cssRule(".pixel-room__stage")).toContain("aspect-ratio: 8 / 7");
    expect(cssRule(".pixel-room__stage")).toContain("left: 50%");
    expect(cssRule(".pixel-room__stage")).toContain("transform: translateX(-50%)");
    expect(cssRule(".pixel-room__wall")).toContain("height: calc(100% / 7)");
    expect(cssRule(".pixel-room__floor")).toContain(
      "inset: calc(100% / 7) 0 calc(100% / 7)",
    );
    expect(cssRule(".pixel-room__bottom-window-band")).toContain(
      "height: calc(100% / 7)",
    );
    expect(cssRule(".pixel-room__bottom-window-band")).toContain(
      'background-image: url("/vendor/pixel-office/generated/window-tile.png")',
    );
    expect(cssRule(".pixel-room__bottom-window-band")).toContain(
      "background-size: auto 100%",
    );
    expect(cssRule(".pixel-room__elevator-door")).toContain("left: 25%");
  });

  it("keeps only the prepared background elements before refurnishing", () => {
    const { container } = renderRoom();

    expect(container.querySelector(".pixel-room__wall")).not.toBeNull();
    expect(container.querySelector(".pixel-room__floor")).not.toBeNull();
    expect(container.querySelector(".pixel-room__bottom-window-band")).not.toBeNull();
    expect(container.querySelector(".pixel-room__bottom-door-sprite")).not.toBeNull();
    expect(container.querySelector(".pixel-room__elevator-door")).not.toBeNull();

    expect(container.querySelector(".pixel-room__side-table")).toBeNull();
    expect(container.querySelector(".pixel-room__sofa-zone")).toBeNull();
    expect(container.querySelector(".pixel-room__plant")).toBeNull();
    expect(container.querySelector(".pixel-room__work-desk")).toBeNull();
    expect(container.querySelector(".pixel-room__desk-keyboard")).toBeNull();
    expect(container.querySelector(".pixel-room__desk-monitor")).toBeNull();
  });

  it("places the selected props in the requested room regions", () => {
    const { container } = renderRoom();
    const props = [
      ["performance-chart", "-870px -456px", "81px", "48px"],
      ["fire-extinguisher", "-2218.5px -477px", "27px", "49.5px"],
      ["plant-large", "-1146.6px -764.4px", "78px", "109.2px"],
      ["plant-small", "-1532.7px -791.7px", "50.7px", "81.9px"],
      ["side-table", "-463.5px -652.5px", "76.5px", "139.5px"],
      ["plant-tall", "-1341.6px -764.4px", "58.5px", "109.2px"],
      ["conference-table", "-1206px -810px", "372px", "150px"],
      ["printer", "-1957.5px -261px", "121.5px", "99px"],
      ["vending-machine", "-1512px 0px", "144px", "144px"],
      ["bookshelf", "-1080px 0px", "144px", "144px"],
      ["coffee-machine", "-1461px -12px", "51px", "66px"],
      ["water-dispenser", "-1305px -3px", "72px", "171px"],
    ];

    for (const [name, backgroundPosition, width, height] of props) {
      const prop = container.querySelector<HTMLElement>(
        `.pixel-room__prop--${name}`,
      );

      expect(prop).not.toBeNull();
      expect(prop?.style.backgroundImage).toContain("Props.png");
      expect(prop?.style.backgroundPosition).toBe(backgroundPosition);
      expect(prop?.style.width).toBe(width);
      expect(prop?.style.height).toBe(height);
    }

    expect(cssRule(".pixel-room__prop")).toContain("position: absolute");
    expect(cssRule(".pixel-room__prop--performance-chart")).toContain("left: 40.625%");
    expect(cssRule(".pixel-room__prop--performance-chart")).toContain("top: 3.5714%");
    expect(cssRule(".pixel-room__prop--fire-extinguisher")).toContain("left: 20.3125%");
    expect(cssRule(".pixel-room__prop--fire-extinguisher")).toContain("top: 8.9286%");
    expect(cssRule(".pixel-room__prop--plant-large")).toContain("left: 3.125%");
    expect(cssRule(".pixel-room__prop--plant-large")).toContain("top: 66.0714%");
    expect(cssRule(".pixel-room__prop--plant-small")).toContain("left: 93.75%");
    expect(cssRule(".pixel-room__prop--plant-small")).toContain("top: 67.8571%");
    expect(cssRule(".pixel-room__prop--side-table")).toContain("left: 0.5%");
    expect(cssRule(".pixel-room__prop--plant-tall")).toContain("left: calc(0.5% + 3px)");
    expect(cssRule(".pixel-room__prop--plant-tall")).toContain("top: calc(43% - 38px)");
    expect(cssRule(".pixel-room__prop--conference-table")).toContain("left: 22%");
    expect(cssRule(".pixel-room__prop--conference-table")).toContain("top: 36%");
    expect(cssRule(".pixel-room__prop--printer")).toContain("left: 53.125%");
    expect(cssRule(".pixel-room__prop--printer")).toContain("top: 7.1429%");
    expect(cssRule(".pixel-room__prop--vending-machine")).toContain("left: 88.75%");
    expect(cssRule(".pixel-room__prop--vending-machine")).toContain("top: 5.3571%");
    expect(cssRule(".pixel-room__prop--bookshelf")).toContain("left: 6.25%");
    expect(cssRule(".pixel-room__prop--bookshelf")).toContain("top: 3.5714%");
    expect(cssRule(".pixel-room__prop--coffee-machine")).toContain("left: 81.25%");
    expect(cssRule(".pixel-room__prop--coffee-machine")).toContain("top: 15.7143%");
    expect(cssRule(".pixel-room__prop--water-dispenser")).toContain("left: 70.3125%");
    expect(cssRule(".pixel-room__prop--water-dispenser")).toContain("top: 5.3571%");
  });

  it("anchors speech inside the stage with clamped room coordinates", () => {
    const { container } = renderRoom({
      activeSpeakerUid: "reviewer",
      latestMessage: message("host:reviewer"),
      seats: [{ member: member("reviewer", "Reviewer"), left: 79.06, top: 44.29 }],
    });
    const stage = container.querySelector(".pixel-room__stage");
    const speech = container.querySelector<HTMLElement>(".pixel-room__speech");

    expect(stage?.contains(speech)).toBe(true);
    expect(speech?.getAttribute("style")).toContain("--speech-x:");
    expect(speech?.getAttribute("style")).toContain("--speech-y:");
    expect(cssRule(".office3d__speech.pixel-room__speech")).toContain(
      "left: clamp(7.5rem, var(--speech-x), calc(100% - 7.5rem))",
    );
    expect(cssRule(".office3d__speech.pixel-room__speech")).toContain(
      "top: clamp(7rem, var(--speech-y), calc(100% - 0.75rem))",
    );
    expect(cssRule(".office3d__speech.pixel-room__speech")).toContain(
      "translate(-50%, calc(-100% - 8px))",
    );
  });

  it("maps minimap markers to the actual room coordinates", () => {
    const { container } = renderRoom({
      seats: [
        { member: member("planner", "Planner"), left: 11.25, top: 35 },
        { member: member("reviewer", "Reviewer"), left: 79.06, top: 35 },
        { member: member("human", "Human User"), left: 45.16, top: 64.64 },
        { member: member("candidate", "Candidate"), left: 45.16, top: 18.75 },
      ],
    });
    const markers = Array.from(
      container.querySelectorAll<HTMLElement>(".office3d__minimap span"),
    );

    expect(markers).toHaveLength(4);
    expect(markers.map((marker) => marker.getAttribute("style"))).toEqual([
      "left: 11.25%; top: 35%;",
      "left: 79.06%; top: 35%;",
      "left: 45.16%; top: 64.64%;",
      "left: 45.16%; top: 18.75%;",
    ]);
    expect(cssRule(".office3d__minimap div::before")).toContain("display: none");
  });
});
