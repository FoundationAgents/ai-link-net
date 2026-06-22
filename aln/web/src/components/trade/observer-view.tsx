/* ObserverView — multi-agent live view for a single contract, embedded in Trade. */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowLeftRight,
  Bot,
  CheckCheck,
  Eye,
  FileSignature,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import { getMessages, listEntities } from "@/api";
import { TradeApiClient } from "@/api/trade";
import { StatusBadge } from "@/components/trade/contract-detail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import type { MailboxMessage } from "@/api";
import type { Contact, Contract, ParticipantSnapshot } from "@/types";

type ParticipantRole = "party_a" | "party_b" | "arbiter";

interface ParticipantActivity {
  uid: string;
  role: ParticipantRole;
  name: string;
  kind: string;
  lastSeenAt: number | null;
  lastLine: string;
  currentFocus: string;
  activeNow: boolean;
  messageCount: number;
}

interface FeedItem {
  id: string;
  timestamp: number;
  actorName: string;
  actorRole: string;
  title: string;
  detail: string;
  tone: "message" | "attestation";
}

type DetailTab = "event" | "payload" | "snapshot";

interface FlowEvent {
  id: string;
  timestamp: number;
  sourceRole: ParticipantRole;
  targetRoles: ParticipantRole[];
  actorName: string;
  targetNames: string[];
  title: string;
  detail: string;
  kind: string;
  tone: "message" | "attestation";
  payload: Record<string, unknown>;
  sessionId: string | null;
  status: string | null;
  snapshotHash: string | null;
  prevSnapshotHash: string | null;
  termsHash: string | null;
  lastAction: string | null;
}

const ROLE_LABELS: Record<ParticipantRole, string> = {
  party_a: "Alex / Party A",
  party_b: "Bob / Party B",
  arbiter: "Arbiter",
};

const ROLE_CARD_STYLES: Record<ParticipantRole, string> = {
  party_a: "border-sky-500/30 bg-sky-500/5",
  party_b: "border-emerald-500/30 bg-emerald-500/5",
  arbiter: "border-amber-500/30 bg-amber-500/5",
};

const ROLE_PILL_STYLES: Record<ParticipantRole, string> = {
  party_a: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  party_b: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  arbiter: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

function parseMessageTimestamp(message: MailboxMessage): number {
  const ts = Date.parse(message.timestamp);
  return Number.isFinite(ts) ? ts : 0;
}

function shortValue(value: string | null | undefined, head = 10, tail = 8) {
  if (!value) return "-";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return "No recent activity";
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

function formatAbsoluteTime(timestamp: number | null): string {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString();
}

function formatUsd(value: number | null | undefined): string {
  if (value == null) return "-";
  return `$${value.toFixed(2)}`;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractEntityUid(address: string | undefined): string {
  if (!address) return "";
  const parts = address.split(":");
  return parts[parts.length - 1] ?? address;
}

function getMessageKind(message: MailboxMessage): string {
  const raw = message as MailboxMessage & { kind?: string };
  return typeof raw.kind === "string" ? raw.kind : "";
}

function getPayloadText(message: MailboxMessage): string {
  return typeof message.payload?.text === "string" ? message.payload.text : "";
}

function isWorkSessionMessage(
  message: MailboxMessage,
  workSessionId: string | null | undefined,
): boolean {
  if (!workSessionId) return false;
  return message.payload?.session_id === workSessionId && getPayloadText(message).trim().length > 0;
}

function isContractStatusMessage(message: MailboxMessage, contractId: string): boolean {
  if (getMessageKind(message) !== "contract_status") return false;
  const payload = message.payload as Record<string, unknown>;
  if (payload.contract_id === contractId) return true;
  const contract = payload.contract as Record<string, unknown> | undefined;
  return contract?.contract_id === contractId;
}

function resolveParticipant(
  contract: Contract,
  role: ParticipantRole,
  entitiesByUid: Map<string, Contact>,
): ParticipantSnapshot | null {
  const fromSnapshot = contract.participant_snapshots?.find((item) => item.role === role);
  if (fromSnapshot) return fromSnapshot;

  const addressRef =
    role === "party_a" ? contract.party_a : role === "party_b" ? contract.party_b : contract.arbiter;
  const entityUid = addressRef.entity_uid ?? extractEntityUid(addressRef.address);
  const entity = entitiesByUid.get(entityUid);
  if (!entity) return null;
  return {
    address: entity.address,
    role,
    host_uid: entity.host_uid,
    entity_uid: entity.entity_uid,
    sign_public_key: entity.sign_public_key,
    encrypt_public_key: entity.encrypt_public_key,
    display_name: entity.name,
  };
}

function buildParticipantActivity(
  participant: ParticipantSnapshot,
  contract: Contract,
  entitiesByUid: Map<string, Contact>,
  flowEvents: FlowEvent[],
): ParticipantActivity {
  const relevantEvents = flowEvents.filter(
    (event) =>
      event.sourceRole === (participant.role as ParticipantRole) ||
      event.targetRoles.includes(participant.role as ParticipantRole),
  );
  const lastEvent = [...relevantEvents].sort((a, b) => b.timestamp - a.timestamp)[0];
  const lastSeenAt = lastEvent?.timestamp ?? null;
  const lastLine = lastEvent?.detail ?? "No activity yet";
  const entity = entitiesByUid.get(participant.entity_uid);
  let currentFocus = "Observing the contract";
  if (contract.status === "draft") {
    if (participant.role === "party_a") currentFocus = "Created the contract and waiting for Bob approval";
    else if (participant.role === "party_b") currentFocus = "Review terms and approve to activate";
    else currentFocus = "Freeze identities and sign the creation snapshot";
  } else if (contract.status === "active") {
    if (participant.role === "party_b") currentFocus = "Prepare the next structured delivery with artifacts and cost";
    else if (participant.role === "party_a") currentFocus = "Track progress and clarify acceptance criteria";
    else currentFocus = "Wait for the next valid signed transition";
  } else if (contract.status === "completing") {
    if (participant.role === "party_a") currentFocus = "Review delivery evidence and decide accept vs rework";
    else if (participant.role === "party_b") currentFocus = "Wait for review or prepare the next revision";
    else currentFocus = "Anchor delivery evidence and signed completion snapshot";
  } else if (contract.status === "settling" || contract.status === "settled") {
    if (participant.role === "party_a") currentFocus = "Close out the contract with rating and final review";
    else if (participant.role === "party_b") currentFocus = "Delivery accepted; waiting for settlement and rating";
    else currentFocus = "Hold the final signed settlement chain";
  }
  return {
    uid: participant.entity_uid,
    role: participant.role as ParticipantRole,
    name: participant.display_name,
    kind: entity?.kind ?? "entity",
    lastSeenAt,
    lastLine,
    currentFocus,
    activeNow: lastSeenAt ? Date.now() - lastSeenAt < 10 * 60 * 1000 : false,
    messageCount: relevantEvents.length,
  };
}

function buildFeed(
  contract: Contract,
  participants: ParticipantSnapshot[],
  mailboxMap: Record<string, MailboxMessage[]>,
): FeedItem[] {
  const byMessageId = new Map<string, FeedItem>();
  const participantMap = new Map(participants.map((item) => [item.entity_uid, item]));

  for (const messages of Object.values(mailboxMap)) {
    for (const message of messages) {
      const messageId = message.message_id;
      if (byMessageId.has(messageId)) continue;
      const timestamp = parseMessageTimestamp(message);
      const senderUid = extractEntityUid(message.sender);
      const actor = participantMap.get(senderUid);

      if (isWorkSessionMessage(message, contract.work_session_id)) {
        byMessageId.set(messageId, {
          id: messageId,
          timestamp,
          actorName: actor?.display_name ?? senderUid,
          actorRole: actor?.role ?? "participant",
          title: "Work Session",
          detail: getPayloadText(message),
          tone: "message",
        });
        continue;
      }

      if (isContractStatusMessage(message, contract.contract_id)) {
        const payload = message.payload as Record<string, unknown>;
        const status = typeof payload.status === "string" ? payload.status : contract.status;
        const detail =
          typeof payload.message === "string"
            ? payload.message
            : `Arbiter signed and broadcast contract status ${status}.`;
        byMessageId.set(messageId, {
          id: messageId,
          timestamp,
          actorName: actor?.display_name ?? "Arbiter",
          actorRole: actor?.role ?? "arbiter",
          title: "Arbiter Attestation",
          detail,
          tone: "attestation",
        });
      }
    }
  }

  return [...byMessageId.values()].sort((a, b) => b.timestamp - a.timestamp);
}

function buildFlowEvents(
  contract: Contract,
  participants: ParticipantSnapshot[],
  mailboxMap: Record<string, MailboxMessage[]>,
): FlowEvent[] {
  const participantMap = new Map(participants.map((item) => [item.entity_uid, item]));
  const byMessageId = new Map<string, FlowEvent>();

  for (const messages of Object.values(mailboxMap)) {
    for (const message of messages) {
      if (byMessageId.has(message.message_id)) continue;

      const kind = getMessageKind(message);
      const payload = (message.payload ?? {}) as Record<string, unknown>;
      const senderUid = extractEntityUid(message.sender);
      const actor = participantMap.get(senderUid);
      const timestamp = parseMessageTimestamp(message);
      const targetRoles = message.recipient
        .map((recipient) => participantMap.get(extractEntityUid(recipient))?.role as ParticipantRole | undefined)
        .filter((role): role is ParticipantRole => Boolean(role));
      const targetNames = message.recipient
        .map((recipient) => participantMap.get(extractEntityUid(recipient))?.display_name)
        .filter((name): name is string => Boolean(name));

      if (isWorkSessionMessage(message, contract.work_session_id) && actor) {
        byMessageId.set(message.message_id, {
          id: message.message_id,
          timestamp,
          sourceRole: actor.role as ParticipantRole,
          targetRoles,
          actorName: actor.display_name,
          targetNames,
          title: `${actor.display_name} sends a work-session update`,
          detail: getPayloadText(message),
          kind: kind || "invoke",
          tone: "message",
          payload,
          sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
          status: null,
          snapshotHash: null,
          prevSnapshotHash: null,
          termsHash: null,
          lastAction: null,
        });
        continue;
      }

      if (isContractStatusMessage(message, contract.contract_id)) {
        const embeddedContract = (payload.contract ?? {}) as Record<string, unknown>;
        const embeddedAttestation = (embeddedContract.attestation ?? {}) as Record<string, unknown>;
        const status = typeof payload.status === "string" ? payload.status : null;
        byMessageId.set(message.message_id, {
          id: message.message_id,
          timestamp,
          sourceRole: "arbiter",
          targetRoles: targetRoles.length > 0 ? targetRoles : ["party_a", "party_b"],
          actorName: actor?.display_name ?? "Arbiter",
          targetNames,
          title: `Arbiter attests ${status ?? contract.status}`,
          detail:
            typeof payload.message === "string"
              ? payload.message
              : `Arbiter reviewed the transition and signed a new contract snapshot.`,
          kind: kind || "contract_status",
          tone: "attestation",
          payload,
          sessionId: null,
          status,
          snapshotHash:
            typeof embeddedAttestation.snapshot_hash === "string"
              ? embeddedAttestation.snapshot_hash
              : typeof embeddedContract.current_snapshot_hash === "string"
                ? embeddedContract.current_snapshot_hash
                : null,
          prevSnapshotHash:
            typeof embeddedAttestation.prev_snapshot_hash === "string"
              ? embeddedAttestation.prev_snapshot_hash
              : typeof embeddedContract.prev_snapshot_hash === "string"
                ? embeddedContract.prev_snapshot_hash
                : null,
          termsHash:
            typeof embeddedContract.terms_hash === "string"
              ? embeddedContract.terms_hash
              : null,
          lastAction:
            typeof embeddedContract.last_action === "string"
              ? embeddedContract.last_action
              : null,
        });
      }
    }
  }

  return [...byMessageId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

interface ObserverViewProps {
  contractId: string;
  onBack: () => void;
}

export function ObserverView({ contractId, onBack }: ObserverViewProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const [tradeClient] = useState(() => new TradeApiClient());

  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [contract, setContract] = useState<Contract | null>(null);
  const [entities, setEntities] = useState<Contact[]>([]);
  const [mailboxMap, setMailboxMap] = useState<Record<string, MailboxMessage[]>>({});
  const [selectedFlowEventId, setSelectedFlowEventId] = useState<string>("");
  const [detailTab, setDetailTab] = useState<DetailTab>("event");

  useEffect(() => {
    void tradeClient.resolve().then(() => setReady(true));
  }, [tradeClient]);

  const refresh = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    try {
      const [contracts, nextEntities] = await Promise.all([
        tradeClient.listContracts(),
        listEntities().catch(() => []),
      ]);

      const found = contracts.find((c) => c.contract_id === contractId) ?? null;
      setContract(found);
      setEntities(nextEntities);

      if (!found) {
        setMailboxMap({});
        return;
      }

      const entitiesByUid = new Map(nextEntities.map((item) => [item.entity_uid, item]));
      const participants = (["party_a", "party_b", "arbiter"] as ParticipantRole[])
        .map((role) => resolveParticipant(found, role, entitiesByUid))
        .filter((item): item is ParticipantSnapshot => Boolean(item));

      const messagePairs = await Promise.all(
        participants.map(async (participant) => [
          participant.entity_uid,
          await getMessages(participant.entity_uid).catch(() => []),
        ] as const),
      );

      setMailboxMap(Object.fromEntries(messagePairs));
    } finally {
      setLoading(false);
    }
  }, [ready, contractId, tradeClient]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(refresh, 5000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const entitiesByUid = useMemo(
    () => new Map(entities.map((item) => [item.entity_uid, item])),
    [entities],
  );

  const participants = useMemo(() => {
    if (!contract) return [];
    return (["party_a", "party_b", "arbiter"] as ParticipantRole[])
      .map((role) => resolveParticipant(contract, role, entitiesByUid))
      .filter((item): item is ParticipantSnapshot => Boolean(item));
  }, [contract, entitiesByUid]);

  const feed = useMemo(() => {
    if (!contract) return [];
    return buildFeed(contract, participants, mailboxMap);
  }, [contract, participants, mailboxMap]);

  const flowEvents = useMemo(() => {
    if (!contract) return [];
    return buildFlowEvents(contract, participants, mailboxMap);
  }, [contract, participants, mailboxMap]);

  const participantActivities = useMemo(() => {
    return participants.map((participant) =>
      buildParticipantActivity(participant, contract!, entitiesByUid, flowEvents),
    );
  }, [contract, entitiesByUid, flowEvents, participants]);

  const activeFlowEventId = useMemo(() => {
    if (flowEvents.length === 0) return "";
    if (flowEvents.some((item) => item.id === selectedFlowEventId)) return selectedFlowEventId;
    return flowEvents[flowEvents.length - 1]?.id ?? "";
  }, [flowEvents, selectedFlowEventId]);

  const selectedFlowEvent = useMemo(
    () => flowEvents.find((item) => item.id === activeFlowEventId) ?? flowEvents[flowEvents.length - 1] ?? null,
    [activeFlowEventId, flowEvents],
  );

  const totalCostUsd = useMemo(
    () => (contract?.cost_history ?? []).reduce((sum, item) => sum + (item.cost_usd ?? 0), 0),
    [contract],
  );

  if (!currentUser) return null;

  return (
    <div className="flex min-h-full min-w-0 flex-col overflow-y-auto">
      <header className="px-4 md:px-6 h-14 flex items-center justify-between border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="h-7 w-7 rounded-lg bg-muted flex items-center justify-center">
            <Eye className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <h1 className="font-heading text-sm font-semibold">Observer</h1>
            <p className="text-[11px] text-muted-foreground">
              {contract?.title ?? "Loading..."}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </header>

      <div className="p-4 md:p-6 space-y-6">
        {!contract ? (
          <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            {ready ? "Contract not found." : "Connecting to Arbiter host..."}
          </div>
        ) : (
          <>
            <section className="rounded-3xl border border-border bg-card p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[10px] uppercase tracking-[0.2em]">
                      Observer
                    </Badge>
                    <StatusBadge status={contract.status} />
                  </div>
                  <h2 className="font-heading text-xl font-semibold">{contract.title}</h2>
                  <p className="max-w-3xl text-sm text-muted-foreground">{contract.description}</p>
                </div>
                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                  <div>
                    <div className="uppercase tracking-[0.2em] text-[10px]">Work Session</div>
                    <div className="mt-1 font-mono text-foreground">{contract.work_session_id ?? "-"}</div>
                  </div>
                  <div>
                    <div className="uppercase tracking-[0.2em] text-[10px]">Latest Snapshot</div>
                    <div className="mt-1 font-mono text-foreground">
                      {shortValue(contract.current_snapshot_hash, 12, 8)}
                    </div>
                  </div>
                  <div>
                    <div className="uppercase tracking-[0.2em] text-[10px]">Last Action</div>
                    <div className="mt-1 text-foreground">{contract.last_action ?? "-"}</div>
                  </div>
                  <div>
                    <div className="uppercase tracking-[0.2em] text-[10px]">Last Update</div>
                    <div className="mt-1 text-foreground">{formatAbsoluteTime(contract.last_action_at ? contract.last_action_at * 1000 : null)}</div>
                  </div>
                </div>
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-3">
              {participantActivities.map((activity) => {
                const Icon =
                  activity.role === "arbiter"
                    ? ShieldCheck
                    : activity.kind === "agent"
                      ? Bot
                      : UserRound;
                return (
                  <article
                    key={activity.uid}
                    className={cn("rounded-3xl border p-5 shadow-sm", ROLE_CARD_STYLES[activity.role])}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-background/80">
                            <Icon className="h-4 w-4" />
                          </div>
                          <div>
                            <div className="font-heading text-base font-semibold">{activity.name}</div>
                            <div className="text-xs text-muted-foreground">{ROLE_LABELS[activity.role]}</div>
                          </div>
                        </div>
                      </div>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "text-[10px]",
                          activity.activeNow
                            ? "bg-emerald-500/15 text-emerald-600"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {activity.activeNow ? "Active now" : "Idle"}
                      </Badge>
                    </div>
                    <div className="mt-4 grid gap-3 text-sm">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Last Seen</div>
                        <div className="mt-1 font-medium">{formatRelativeTime(activity.lastSeenAt)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Current Focus</div>
                        <div className="mt-1 text-muted-foreground">{activity.currentFocus}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Recent Line</div>
                        <div className="mt-1 line-clamp-3 text-muted-foreground">{activity.lastLine}</div>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{activity.messageCount} protocol events</span>
                        <span className="font-mono">{activity.uid}</span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>

            <section className="grid gap-6 xl:grid-cols-[1.65fr_0.95fr]">
              <article className="rounded-3xl border border-border bg-card p-5">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-heading text-base font-semibold">Protocol Flow</h3>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Left is Alex, center is Arbiter, right is Bob. Click any row to inspect the data on the right.
                </p>

                <div className="mt-5 rounded-3xl border border-border/70 bg-background/50">
                  <div className="grid grid-cols-3 gap-3 border-b border-border/70 px-4 py-3 text-xs font-medium text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <div className="h-2.5 w-2.5 rounded-full bg-sky-500/70" />
                      Alex
                    </div>
                    <div className="flex items-center justify-center gap-2">
                      <div className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
                      Arbiter
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      Bob
                      <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
                    </div>
                  </div>

                  <div className="space-y-3 p-4">
                  {flowEvents.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                      No live activity yet for this contract.
                    </div>
                  ) : (
                    flowEvents.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedFlowEventId(item.id)}
                        className={cn(
                          "w-full rounded-2xl border p-4 text-left transition-colors",
                          activeFlowEventId === item.id && "border-primary/40 bg-primary/5",
                          item.tone === "attestation"
                            ? "border-amber-500/20 bg-amber-500/5"
                            : "border-border bg-background/60",
                        )}
                      >
                        <div className="grid grid-cols-3 gap-3">
                          <div className="min-h-[92px]">
                            {item.sourceRole === "party_a" && (
                              <div className="rounded-2xl border border-sky-500/20 bg-sky-500/10 p-3">
                                <div className="flex items-center gap-2">
                                  <Badge variant="secondary" className={cn("text-[10px]", ROLE_PILL_STYLES.party_a)}>Alex</Badge>
                                  <span className="text-xs text-muted-foreground">{formatRelativeTime(item.timestamp)}</span>
                                </div>
                                <div className="mt-2 text-sm font-medium">{item.title}</div>
                                <div className="mt-1 line-clamp-3 text-xs text-muted-foreground">{item.detail}</div>
                              </div>
                            )}
                          </div>

                          <div className="flex min-h-[92px] flex-col items-center justify-center gap-2">
                            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                              {item.tone === "attestation" ? <ShieldCheck className="h-3.5 w-3.5" /> : <ArrowLeftRight className="h-3.5 w-3.5" />}
                              {item.tone === "attestation" ? "Review + Sign" : "Work Session"}
                            </div>
                            <div
                              className={cn(
                                "w-full rounded-2xl border px-3 py-3 text-center",
                                item.tone === "attestation"
                                  ? "border-amber-500/25 bg-amber-500/8"
                                  : "border-border bg-card",
                              )}
                            >
                              <div className="flex items-center justify-center gap-2">
                                <Badge variant="secondary" className={cn("text-[10px]", ROLE_PILL_STYLES.arbiter)}>
                                  {item.tone === "attestation" ? "Arbiter" : "Data Flow"}
                                </Badge>
                                {item.status && <StatusBadge status={item.status as Contract["status"]} />}
                              </div>
                              <div className="mt-2 text-sm font-medium">{item.tone === "attestation" ? item.title : shortValue(item.sessionId, 10, 8)}</div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {item.snapshotHash
                                  ? `${shortValue(item.prevSnapshotHash, 8, 6)} -> ${shortValue(item.snapshotHash, 8, 6)}`
                                  : item.targetNames.join(", ") || "Contract-scoped collaboration"}
                              </div>
                            </div>
                          </div>

                          <div className="min-h-[92px]">
                            {item.sourceRole === "party_b" && (
                              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-3">
                                <div className="flex items-center justify-end gap-2">
                                  <span className="text-xs text-muted-foreground">{formatRelativeTime(item.timestamp)}</span>
                                  <Badge variant="secondary" className={cn("text-[10px]", ROLE_PILL_STYLES.party_b)}>Bob</Badge>
                                </div>
                                <div className="mt-2 text-sm font-medium">{item.title}</div>
                                <div className="mt-1 line-clamp-3 text-xs text-muted-foreground">{item.detail}</div>
                              </div>
                            )}
                            {item.tone === "attestation" && (
                              <div className="mt-2 flex justify-end gap-2">
                                {item.targetRoles.includes("party_a") && (
                                  <Badge variant="secondary" className={cn("text-[10px]", ROLE_PILL_STYLES.party_a)}>to Alex</Badge>
                                )}
                                {item.targetRoles.includes("party_b") && (
                                  <Badge variant="secondary" className={cn("text-[10px]", ROLE_PILL_STYLES.party_b)}>to Bob</Badge>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                  </div>
                </div>
              </article>

              <article className="rounded-3xl border border-border bg-card p-5">
                <div className="flex items-center gap-2">
                  <FileSignature className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-heading text-base font-semibold">Event Detail</h3>
                </div>
                <div className="mt-4 flex gap-2">
                  {([
                    { id: "event", label: "Event" },
                    { id: "payload", label: "Payload" },
                    { id: "snapshot", label: "Snapshot" },
                  ] as const).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setDetailTab(tab.id)}
                      className={cn(
                        "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                        detailTab === tab.id
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="mt-5 space-y-4 text-sm">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl bg-muted/50 p-3">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Approvals</div>
                      <div className="mt-1 text-lg font-semibold">{contract.approvals?.length ?? 0}</div>
                    </div>
                    <div className="rounded-2xl bg-muted/50 p-3">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Snapshot Steps</div>
                      <div className="mt-1 text-lg font-semibold">{contract.snapshot_history?.length ?? 0}</div>
                    </div>
                    <div className="rounded-2xl bg-muted/50 p-3">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Deliveries</div>
                      <div className="mt-1 text-lg font-semibold">{contract.delivery_history?.length ?? 0}</div>
                    </div>
                    <div className="rounded-2xl bg-muted/50 p-3">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Exec Cost</div>
                      <div className="mt-1 text-lg font-semibold">{formatUsd(totalCostUsd)}</div>
                    </div>
                  </div>

                  {selectedFlowEvent ? (
                    <>
                      {detailTab === "event" && (
                        <div className="space-y-4">
                          <div className="rounded-2xl border border-border bg-background/60 p-4">
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary" className={cn("text-[10px]", ROLE_PILL_STYLES[selectedFlowEvent.sourceRole])}>
                                {selectedFlowEvent.actorName}
                              </Badge>
                              <span className="text-xs text-muted-foreground">{formatAbsoluteTime(selectedFlowEvent.timestamp)}</span>
                            </div>
                            <div className="mt-3 text-base font-semibold">{selectedFlowEvent.title}</div>
                            <div className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{selectedFlowEvent.detail}</div>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-2xl bg-muted/50 p-3">
                              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Source</div>
                              <div className="mt-1 font-medium">{selectedFlowEvent.actorName}</div>
                            </div>
                            <div className="rounded-2xl bg-muted/50 p-3">
                              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Targets</div>
                              <div className="mt-1 font-medium">
                                {selectedFlowEvent.targetNames.length > 0 ? selectedFlowEvent.targetNames.join(", ") : "Observer-only / contract state"}
                              </div>
                            </div>
                            <div className="rounded-2xl bg-muted/50 p-3">
                              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Kind</div>
                              <div className="mt-1 font-medium">{selectedFlowEvent.kind}</div>
                            </div>
                            <div className="rounded-2xl bg-muted/50 p-3">
                              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Session</div>
                              <div className="mt-1 font-mono text-xs">{selectedFlowEvent.sessionId ?? "-"}</div>
                            </div>
                          </div>
                        </div>
                      )}

                      {detailTab === "payload" && (
                        <div className="rounded-2xl border border-border bg-background/60 p-4">
                          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                            <CheckCheck className="h-3.5 w-3.5" />
                            Payload
                          </div>
                          <pre className="mt-3 overflow-auto rounded-xl bg-muted/50 p-3 text-xs leading-6 text-foreground">
                            {stringifyJson(selectedFlowEvent.payload)}
                          </pre>
                        </div>
                      )}

                      {detailTab === "snapshot" && (
                        <div className="space-y-4">
                          <div className="rounded-2xl bg-muted/50 p-4">
                            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Current Delivery</div>
                            {contract.current_delivery ? (
                              <div className="mt-3 space-y-3">
                                <div>
                                  <div className="font-medium">{contract.current_delivery.version}</div>
                                  <div className="mt-1 text-sm text-muted-foreground">{contract.current_delivery.summary}</div>
                                </div>
                                <div className="space-y-2">
                                  {contract.current_delivery.artifacts.length > 0 ? (
                                    contract.current_delivery.artifacts.map((artifact, index) => (
                                      <div key={`${artifact.uri}-${index}`} className="rounded-xl border border-border px-3 py-2">
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="font-medium">{artifact.label ?? artifact.kind}</span>
                                          <Badge variant="secondary" className="text-[10px]">{artifact.kind}</Badge>
                                        </div>
                                        <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{artifact.uri}</div>
                                      </div>
                                    ))
                                  ) : (
                                    <div className="text-sm text-muted-foreground">No explicit artifacts attached.</div>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="mt-3 text-sm text-muted-foreground">No delivery evidence recorded yet.</div>
                            )}
                          </div>

                          <div className="rounded-2xl bg-muted/50 p-4">
                            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Execution Costs</div>
                            {(contract.current_execution_costs?.length ?? 0) > 0 ? (
                              <div className="mt-3 space-y-2">
                                {contract.current_execution_costs?.map((cost, index) => (
                                  <div key={`${cost.report_id ?? "cost"}-${index}`} className="rounded-xl border border-border px-3 py-2">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-medium">{cost.phase ?? "execution"}</span>
                                      <span className="text-xs text-muted-foreground">{formatUsd(cost.cost_usd)}</span>
                                    </div>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                      {[cost.provider, cost.model].filter(Boolean).join(" / ") || "provider not recorded"}
                                    </div>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                      in {cost.input_tokens ?? 0} / out {cost.output_tokens ?? 0} / {cost.runtime_ms ?? 0} ms
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-3 text-sm text-muted-foreground">No execution cost reports recorded yet.</div>
                            )}
                          </div>

                          <div className="rounded-2xl bg-muted/50 p-4">
                            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Snapshot Chain</div>
                            <div className="mt-3 space-y-2 font-mono text-xs">
                              <div>prev: {shortValue(selectedFlowEvent.prevSnapshotHash, 12, 8)}</div>
                              <div>curr: {shortValue(selectedFlowEvent.snapshotHash ?? contract.current_snapshot_hash, 12, 8)}</div>
                              <div>terms: {shortValue(selectedFlowEvent.termsHash ?? contract.terms_hash, 12, 8)}</div>
                            </div>
                          </div>

                          <div className="rounded-2xl bg-muted/50 p-4">
                            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Contract Context</div>
                            <div className="mt-3 grid gap-2 text-sm">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">Current Status</span>
                                <StatusBadge status={contract.status} />
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">Last Action</span>
                                <span className="font-medium">{selectedFlowEvent.lastAction ?? contract.last_action ?? "-"}</span>
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">Current Actor</span>
                                <span className="font-medium">
                                  {contract.last_actor?.entity_uid
                                    ? participants.find((item) => item.entity_uid === contract.last_actor?.entity_uid)?.display_name ??
                                      contract.last_actor.entity_uid
                                    : "-"}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="space-y-2">
                            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Replay Steps</div>
                            <div className="space-y-2">
                              {(contract.snapshot_history ?? []).map((snapshot, index) => (
                                <div key={`${snapshot.contract_id}-${index}`} className="rounded-2xl border border-border px-3 py-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium">S{index}</span>
                                    <Badge variant="secondary" className="text-[10px]">{snapshot.last_action ?? snapshot.status}</Badge>
                                  </div>
                                  <div className="mt-1 text-xs text-muted-foreground">{snapshot.last_reason || `Status ${snapshot.status}`}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                      Choose a protocol-flow row to inspect it here.
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Recent Activity Summary</div>
                    <div className="space-y-2">
                      {feed.slice(0, 3).map((item) => (
                        <div key={item.id} className="rounded-2xl border border-border px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{item.actorName}</span>
                            <span className="text-xs text-muted-foreground">{formatRelativeTime(item.timestamp)}</span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">{item.title}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
