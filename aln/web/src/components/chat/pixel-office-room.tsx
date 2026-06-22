import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import type { GroupMemberInfo } from "@/api";
import {
  buildPixelOfficeScene,
  type PixelOfficeMember,
  type PixelOfficeSprite,
} from "@/components/chat/pixel-office-layout";
import type { Message } from "@/types";
import { extractEntityUid, formatCompactTokenCount } from "@/lib/utils";

interface PixelRoomSeat {
  member: GroupMemberInfo;
  left: number;
  top: number;
}

interface PixelOfficeRoomProps {
  roomName?: string | null;
  seats: PixelRoomSeat[];
  latestMessage?: Message;
  recentByMember: Map<string, Message>;
  activeSpeakerUid: string;
  avatarByUid: Map<string, string | undefined>;
  providerByUid: Map<string, string | undefined>;
  tokenLabel: string;
  turnCount: number;
  tokenCount: number;
}

interface SpriteSource {
  height: number;
  path: string;
  width: number;
}

interface SpriteFrame {
  height: number;
  source: SpriteSource;
  width: number;
  x: number;
  y: number;
}

const ASSET_ROOT = "/vendor/pixel-office";

const SOURCES = {
  characters: {
    height: 320,
    path: `${ASSET_ROOT}/Characters.png`,
    width: 320,
  },
  robot1: {
    height: 32,
    path: `${ASSET_ROOT}/custom/robot-standing-32x32.png`,
    width: 32,
  },
  robot2: {
    height: 32,
    path: `${ASSET_ROOT}/custom/robot2-standing-32x32.png`,
    width: 32,
  },
  props: {
    height: 224,
    path: `${ASSET_ROOT}/Props.png`,
    width: 560,
  },
} satisfies Record<string, SpriteSource>;

const CHARACTER_FRAMES = {
  female1: { source: SOURCES.characters, x: 1, y: 131, width: 27, height: 29 },
  female2: { source: SOURCES.characters, x: 1, y: 195, width: 27, height: 29 },
  male1: { source: SOURCES.characters, x: 1, y: 3, width: 28, height: 29 },
  male2: { source: SOURCES.characters, x: 1, y: 259, width: 23, height: 29 },
  male3: { source: SOURCES.characters, x: 1, y: 67, width: 27, height: 29 },
  robot1: { source: SOURCES.robot1, x: 0, y: 0, width: 32, height: 32 },
  robot2: { source: SOURCES.robot2, x: 0, y: 0, width: 32, height: 32 },
} satisfies Record<PixelOfficeSprite["key"], SpriteFrame>;

const PROP_FRAMES = {
  performanceChart: { source: SOURCES.props, x: 290, y: 152, width: 27, height: 16 },
  fireExtinguisher: { source: SOURCES.props, x: 493, y: 106, width: 6, height: 11 },
  plantLarge: { source: SOURCES.props, x: 294, y: 196, width: 20, height: 28 },
  plantSmall: { source: SOURCES.props, x: 393, y: 203, width: 13, height: 21 },
  sideTable: { source: SOURCES.props, x: 103, y: 145, width: 17, height: 31 },
  plantTall: { source: SOURCES.props, x: 344, y: 196, width: 15, height: 28 },
  conferenceTable: { source: SOURCES.props, x: 201, y: 135, width: 62, height: 25 },
  printer: { source: SOURCES.props, x: 435, y: 58, width: 27, height: 22 },
  vendingMachine: { source: SOURCES.props, x: 336, y: 0, width: 32, height: 32 },
  bookshelf: { source: SOURCES.props, x: 240, y: 0, width: 32, height: 32 },
  coffeeMachine: { source: SOURCES.props, x: 487, y: 4, width: 17, height: 22 },
  waterDispenser: { source: SOURCES.props, x: 435, y: 1, width: 24, height: 63 },
} satisfies Record<string, SpriteFrame>;

const GENERATED_TILE_PATHS = {
  door: `${ASSET_ROOT}/generated/door-tile.png`,
  elevator: `${ASSET_ROOT}/generated/elevator-tile.png`,
} satisfies Record<string, string>;

const PROP_SCALE = 3;
const ACCENT_PROP_SCALE = PROP_SCALE * 1.5;
const CORNER_PLANT_SCALE = PROP_SCALE * 1.3;
const TABLE_PROP_SCALE = PROP_SCALE * 1.5;
const TABLE_PLANT_SCALE = PROP_SCALE * 1.3;
const CONFERENCE_TABLE_SCALE = PROP_SCALE * 2;
const LARGE_PROP_SCALE = PROP_SCALE * 1.5;
const ROOM_COLUMNS = 8;
const ROOM_ROWS = 7;
const STAGE_BOTTOM_REM = 4.85;
const STAGE_SIDE_REM = 4.6;
const STAGE_TOP_REM = 3.1;

function shortText(message?: Message): string {
  const text = String(message?.payload.text ?? "");
  return text.length > 92 ? `${text.slice(0, 92)}...` : text;
}

function roleLabel(member: GroupMemberInfo, provider?: string): string {
  return provider || member.kind || member.role;
}

function spriteFrame(sprite: PixelOfficeSprite): SpriteFrame {
  return CHARACTER_FRAMES[sprite.key];
}

function stylePercent(x: number, y: number, zIndex?: number): CSSProperties {
  return {
    left: `${x}%`,
    top: `${y}%`,
    zIndex,
  };
}

function usePixelRoomStageStyle(
  roomRef: RefObject<HTMLDivElement | null>,
): CSSProperties | undefined {
  const [stageStyle, setStageStyle] = useState<CSSProperties>();

  useEffect(() => {
    const room = roomRef.current;
    if (!room || typeof ResizeObserver === "undefined") return;

    const updateStageSize = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const availableWidth = room.clientWidth - STAGE_SIDE_REM * 2 * rem;
      const availableHeight = room.clientHeight - (STAGE_TOP_REM + STAGE_BOTTOM_REM) * rem;
      const tileSize = Math.floor(
        Math.max(1, Math.min(availableWidth / ROOM_COLUMNS, availableHeight / ROOM_ROWS)),
      );
      const nextStageStyle = {
        height: tileSize * ROOM_ROWS,
        width: tileSize * ROOM_COLUMNS,
      };

      setStageStyle((current) => (
        current?.height === nextStageStyle.height && current.width === nextStageStyle.width
          ? current
          : nextStageStyle
      ));
    };

    updateStageSize();
    const resizeObserver = new ResizeObserver(updateStageSize);
    resizeObserver.observe(room);

    return () => resizeObserver.disconnect();
  }, [roomRef]);

  return stageStyle;
}

function spriteStyle(frame: SpriteFrame, scale: number): CSSProperties {
  const pixel = (value: number) => Number(value.toFixed(4));

  return {
    backgroundImage: `url("${frame.source.path}")`,
    backgroundPosition: `-${pixel(frame.x * scale)}px -${pixel(frame.y * scale)}px`,
    backgroundSize: `${pixel(frame.source.width * scale)}px ${pixel(frame.source.height * scale)}px`,
    height: pixel(frame.height * scale),
    width: pixel(frame.width * scale),
  };
}

function PixelSprite({
  className,
  frame,
  scale,
}: {
  className?: string;
  frame: SpriteFrame;
  scale: number;
}) {
  return (
    <span
      aria-hidden="true"
      className={`pixel-room__sprite ${className ?? ""}`}
      style={spriteStyle(frame, scale)}
    />
  );
}

function PixelMember({
  active,
  member,
  provider,
}: {
  active: boolean;
  member: PixelOfficeMember;
  provider?: string;
}) {
  const frame = spriteFrame(member.sprite);
  const scale = 2.25;

  return (
    <div
      className={`pixel-room__member ${active ? "is-active" : ""} is-standing`}
      style={stylePercent(member.seat.x, member.seat.y, 20 + Math.round(member.seat.y))}
    >
      <span className="pixel-room__member-shadow" />
      {active && <span className="pixel-room__active-ring" />}
      <PixelSprite frame={frame} scale={scale} />
      <div className="office3d__label pixel-room__label">
        <span>{member.member.name}</span>
        <small>{roleLabel(member.member, provider)}</small>
      </div>
    </div>
  );
}

function PixelRoomDecor() {
  return (
    <>
      <img
        alt=""
        aria-hidden="true"
        className="pixel-room__elevator-door"
        src={GENERATED_TILE_PATHS.elevator}
      />
      <div className="pixel-room__bottom-window-band" />
      <img
        alt=""
        aria-hidden="true"
        className="pixel-room__bottom-door-sprite"
        src={GENERATED_TILE_PATHS.door}
      />
      <PixelSprite
        frame={PROP_FRAMES.performanceChart}
        scale={PROP_SCALE}
        className="pixel-room__prop pixel-room__prop--performance-chart"
      />
      <PixelSprite
        frame={PROP_FRAMES.fireExtinguisher}
        scale={ACCENT_PROP_SCALE}
        className="pixel-room__prop pixel-room__prop--fire-extinguisher"
      />
      <PixelSprite
        frame={PROP_FRAMES.plantLarge}
        scale={CORNER_PLANT_SCALE}
        className="pixel-room__prop pixel-room__prop--plant-large"
      />
      <PixelSprite
        frame={PROP_FRAMES.plantSmall}
        scale={CORNER_PLANT_SCALE}
        className="pixel-room__prop pixel-room__prop--plant-small"
      />
      <PixelSprite
        frame={PROP_FRAMES.sideTable}
        scale={TABLE_PROP_SCALE}
        className="pixel-room__prop pixel-room__prop--side-table"
      />
      <PixelSprite
        frame={PROP_FRAMES.plantTall}
        scale={TABLE_PLANT_SCALE}
        className="pixel-room__prop pixel-room__prop--plant-tall"
      />
      <PixelSprite
        frame={PROP_FRAMES.conferenceTable}
        scale={CONFERENCE_TABLE_SCALE}
        className="pixel-room__prop pixel-room__prop--conference-table"
      />
      <PixelSprite
        frame={PROP_FRAMES.printer}
        scale={ACCENT_PROP_SCALE}
        className="pixel-room__prop pixel-room__prop--printer"
      />
      <PixelSprite
        frame={PROP_FRAMES.vendingMachine}
        scale={LARGE_PROP_SCALE}
        className="pixel-room__prop pixel-room__prop--vending-machine"
      />
      <PixelSprite
        frame={PROP_FRAMES.bookshelf}
        scale={LARGE_PROP_SCALE}
        className="pixel-room__prop pixel-room__prop--bookshelf"
      />
      <PixelSprite
        frame={PROP_FRAMES.coffeeMachine}
        scale={PROP_SCALE}
        className="pixel-room__prop pixel-room__prop--coffee-machine"
      />
      <PixelSprite
        frame={PROP_FRAMES.waterDispenser}
        scale={PROP_SCALE}
        className="pixel-room__prop pixel-room__prop--water-dispenser"
      />
    </>
  );
}

export function PixelOfficeRoom({
  roomName,
  seats,
  latestMessage,
  activeSpeakerUid,
  providerByUid,
  tokenLabel,
  turnCount,
  tokenCount,
}: PixelOfficeRoomProps) {
  const roomRef = useRef<HTMLDivElement>(null);
  const stageStyle = usePixelRoomStageStyle(roomRef);
  const scene = buildPixelOfficeScene(seats);
  const activeMember = scene.members.find(
    (item) => item.member.entity_uid === activeSpeakerUid,
  );
  const speakerName = activeMember?.member.name ?? (
    latestMessage ? extractEntityUid(latestMessage.sender) : "Speaker"
  );
  const speakerStyle = activeMember
    ? stylePercent(activeMember.seat.labelX, Math.max(6, activeMember.seat.labelY - 28), 50)
    : undefined;

  return (
    <div className="office3d pixel-room" ref={roomRef}>
      <div
        className="pixel-room__stage"
        aria-label={roomName ?? "Office room"}
        style={stageStyle}
      >
        <div className="pixel-room__wall" />
        <div className="pixel-room__floor" />
        <PixelRoomDecor />

        {scene.members.map((member) => (
          <PixelMember
            key={member.member.address}
            member={member}
            active={member.member.entity_uid === activeSpeakerUid}
            provider={providerByUid.get(member.member.entity_uid)}
          />
        ))}
      </div>

      {latestMessage && activeMember && speakerStyle && (
        <div
          className="office3d__speech pixel-room__speech"
          style={speakerStyle}
        >
          <p className="office3d__speech-name">{speakerName}</p>
          <p>{shortText(latestMessage)}</p>
        </div>
      )}

      <div className="office3d__status">
        <span>{turnCount} turns</span>
        <span>{formatCompactTokenCount(tokenCount)} {tokenLabel}</span>
        {scene.overflowCount > 0 && <span>+{scene.overflowCount} off-screen</span>}
      </div>

      <div className="office3d__minimap pixel-room__minimap">
        <p>{roomName || "Office Room"}</p>
        <div>
          {scene.members.map((member) => (
            <span
              key={member.member.address}
              style={{
                left: `${member.seat.miniX}%`,
                top: `${member.seat.miniY}%`,
              }}
              className={member.member.entity_uid === activeSpeakerUid ? "is-active" : ""}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
