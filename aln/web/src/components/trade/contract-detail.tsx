/* Contract detail — expanded view with trust-aware lifecycle actions. */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  FileSignature,
  GitBranch,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Star,
  UserRound,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { getMessages } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TradeApiClient } from "@/api/trade";
import type { MailboxMessage } from "@/api";
import type {
  Contract,
  ContractSnapshot,
  ContractStatus,
  FPAddressRef,
  ParticipantSnapshot,
} from "@/types";

const STATUS_COLORS: Record<ContractStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  pending: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  active: "bg-green-500/15 text-green-600 dark:text-green-400",
  completing: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  settling: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  settled: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  cancelled: "bg-red-500/15 text-red-600 dark:text-red-400",
  disputed: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
};

const ROLE_COLORS: Record<string, string> = {
  party_a: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  party_b: "bg-green-500/10 text-green-700 dark:text-green-300",
  arbiter: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  system: "bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: ContractStatus }) {
  return (
    <Badge
      variant="secondary"
      className={cn("text-[10px] h-5 px-2 border-0", STATUS_COLORS[status])}
    >
      {status.toUpperCase()}
    </Badge>
  );
}

interface ContractDetailProps {
  contract: Contract;
  currentUserUid: string;
  tradeClient: TradeApiClient;
  onAction: () => void;
  onObserve?: () => void;
}

type ActionKind =
  | "contract_approve"
  | "contract_complete"
  | "contract_accept"
  | "contract_rework"
  | "contract_cancel"
  | "contract_rate";

interface ActionDef {
  kind: ActionKind;
  label: string;
  icon: typeof Check;
  variant: "default" | "destructive" | "outline";
  needsReason?: boolean;
  needsRating?: boolean;
}

interface TimelineItem {
  id: string;
  actor: string;
  role: string;
  title: string;
  detail: string;
  timestamp: number | null;
  icon: LucideIcon;
}

interface ReplayLane {
  key: string;
  title: string;
  role: string;
  active: boolean;
  detail: string;
  meta: string;
}

interface ReplayMessage {
  actor: string;
  role: string;
  text: string;
  isCurrentActor?: boolean;
  isArbiterSignature?: boolean;
}

function getAvailableActions(
  status: ContractStatus,
  userUid: string,
  contract: Contract,
): ActionDef[] {
  const isPartyA = contract.party_a.entity_uid === userUid;
  const isPartyB = contract.party_b.entity_uid === userUid;
  const actions: ActionDef[] = [];

  if (status === "draft") {
    if (isPartyA || isPartyB) {
      actions.push({
        kind: "contract_approve",
        label: "Approve",
        icon: Check,
        variant: "default",
      });
      actions.push({
        kind: "contract_cancel",
        label: "Cancel",
        icon: XCircle,
        variant: "destructive",
        needsReason: true,
      });
    }
  }

  if (status === "active") {
    if (isPartyB) {
      actions.push({
        kind: "contract_complete",
        label: "Submit Delivery",
        icon: CheckCheck,
        variant: "default",
      });
    }
    if (isPartyA || isPartyB) {
      actions.push({
        kind: "contract_cancel",
        label: "Cancel",
        icon: XCircle,
        variant: "destructive",
        needsReason: true,
      });
    }
  }

  if (status === "completing" && isPartyA) {
    actions.push({
      kind: "contract_accept",
      label: "Accept Delivery",
      icon: Check,
      variant: "default",
    });
    actions.push({
      kind: "contract_rework",
      label: "Request Rework",
      icon: RotateCcw,
      variant: "outline",
      needsReason: true,
    });
  }

  if (
    (status === "settling" || status === "settled") &&
    !contract.rating &&
    isPartyA
  ) {
    actions.push({
      kind: "contract_rate",
      label: "Rate Delivery",
      icon: Star,
      variant: "outline",
      needsRating: true,
    });
  }

  return actions;
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString();
}

function formatUsd(value: number | null | undefined): string {
  if (value == null) return "-";
  return `$${value.toFixed(2)}`;
}

function shortValue(
  value: string | null | undefined,
  head = 10,
  tail = 8,
): string {
  if (!value) return "-";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatRole(role: string | null | undefined): string {
  if (!role) return "System";
  if (role === "party_a") return "Party A";
  if (role === "party_b") return "Party B";
  if (role === "arbiter") return "Arbiter";
  return role.replaceAll("_", " ");
}

function extractEntityUidFromAddress(address: string): string {
  if (!address) return "";
  const segments = address.split(":");
  return segments[segments.length - 1] ?? address;
}

function resolveMailboxActorName(
  sender: string,
  participantMap: Map<string, ParticipantSnapshot>,
): string {
  const entityUid = extractEntityUidFromAddress(sender);
  return participantMap.get(entityUid)?.display_name ?? entityUid;
}

function extractMailboxText(message: MailboxMessage): string {
  const payload = message.payload as Record<string, unknown>;
  return typeof payload.text === "string" ? payload.text : "";
}

function formatActionLabel(action: string | null | undefined): string {
  if (!action) return "status update";
  return action.replace(/^contract_/, "").replaceAll("_", " ");
}

function resolveName(
  address: FPAddressRef | null | undefined,
  snapshots: Map<string, ParticipantSnapshot>,
): string {
  const entityUid = address?.entity_uid;
  if (entityUid && snapshots.has(entityUid)) {
    return snapshots.get(entityUid)?.display_name || entityUid.slice(0, 8);
  }
  if (entityUid) return entityUid.slice(0, 8);
  return shortValue(address?.address, 8, 6);
}

function resolveRole(
  address: FPAddressRef | null | undefined,
  contract: Contract,
): string {
  if (!address?.entity_uid) return "system";
  if (address.entity_uid === contract.party_a.entity_uid) return "party_a";
  if (address.entity_uid === contract.party_b.entity_uid) return "party_b";
  if (address.entity_uid === contract.arbiter.entity_uid) return "arbiter";
  return "system";
}

function summarizeNextStep(
  contract: Contract,
  snapshots: Map<string, ParticipantSnapshot>,
): string {
  const partyA = resolveName(contract.party_a, snapshots);
  const partyB = resolveName(contract.party_b, snapshots);

  if (contract.status === "draft") {
    const approvedRoles = new Set(
      (contract.approvals ?? []).map((approval) => approval.party_role),
    );
    const waitingOn = approvedRoles.has("party_a")
      ? partyB
      : approvedRoles.has("party_b")
        ? partyA
        : `${partyA} and ${partyB}`;
    return `${waitingOn} still needs to approve revision v${contract.draft_version} before Arbiter can activate the contract.`;
  }
  if (contract.status === "active") {
    return `${partyB} can keep working from snapshot ${shortValue(contract.current_snapshot_hash, 8, 6)} and submit the next delivery to ${partyA}.`;
  }
  if (contract.status === "completing") {
    return `${partyA} is reviewing the latest delivery. They can accept it or ask ${partyB} for another rework loop.`;
  }
  if (contract.status === "settling") {
    return "The work has been accepted. Arbiter is holding the signed settlement state while payment and rating finish.";
  }
  if (contract.status === "settled") {
    return contract.rating
      ? "The contract is closed and already carries a signed rating outcome."
      : "The contract is closed. Party A can still add a rating to feed later reputation logic.";
  }
  if (contract.status === "cancelled") {
    return "This collaboration stopped before completion. The signed reason trail is what later trust scoring would inspect.";
  }
  if (contract.status === "disputed") {
    return "This contract is in dispute. Arbiter's current signed snapshot is the trust anchor for later resolution.";
  }
  return "Arbiter is coordinating the next signed state transition.";
}

function formatSnapshotStep(index: number, snapshot: ContractSnapshot): string {
  if (snapshot.last_action === "contract_create" || index === 0) return "Create";
  if (snapshot.last_action === "contract_approve") return "Approve";
  if (snapshot.last_action === "contract_complete") {
    return snapshot.status === "completing" ? "Deliver" : "Complete";
  }
  if (snapshot.last_action === "contract_rework") return "Rework";
  if (snapshot.last_action === "contract_accept") return "Accept";
  if (snapshot.last_action === "contract_rate") return "Rate";
  if (snapshot.last_action === "contract_cancel") return "Cancel";
  if (snapshot.last_action === "contract_dispute") return "Dispute";
  return `Step ${index + 1}`;
}

function buildReplayLanes(
  snapshot: ContractSnapshot,
  contract: Contract,
  snapshots: Map<string, ParticipantSnapshot>,
): ReplayLane[] {
  const partyAName = resolveName(contract.party_a, snapshots);
  const partyBName = resolveName(contract.party_b, snapshots);
  const arbiterName = resolveName(snapshot.attestation?.signer ?? contract.arbiter, snapshots);
  const actorRole = resolveRole(snapshot.last_actor, contract);
  const actionLabel = formatActionLabel(snapshot.last_action);
  const reason = snapshot.last_reason;
  const termsRef = shortValue(snapshot.terms.terms_hash, 10, 6);
  const sourceRef = shortValue(snapshot.attestation?.prev_snapshot_hash, 10, 6);
  const signedRef = shortValue(snapshot.attestation?.snapshot_hash, 10, 6);

  let partyADetail = `${partyAName} is observing this signed state.`;
  let partyBDetail = `${partyBName} is observing this signed state.`;

  if (actorRole === "party_a") {
    partyADetail = reason
      ? `${partyAName} triggers ${actionLabel} with context: ${reason}`
      : `${partyAName} triggers ${actionLabel} for this contract step.`;
  } else if (snapshot.status === "draft") {
    partyADetail = `${partyAName} created the contract and anchored the initial terms.`;
  }

  if (actorRole === "party_b") {
    partyBDetail = reason
      ? `${partyBName} triggers ${actionLabel} with context: ${reason}`
      : `${partyBName} triggers ${actionLabel} for this contract step.`;
  } else if (snapshot.status === "active") {
    partyBDetail = `${partyBName} is now cleared to continue work from the current snapshot.`;
  }

  return [
    {
      key: "party_a",
      title: partyAName,
      role: "party_a",
      active: actorRole === "party_a" || snapshot.status === "draft",
      detail: partyADetail,
      meta: `Party A · ${actorRole === "party_a" ? "actor" : "observer"}`,
    },
    {
      key: "party_b",
      title: partyBName,
      role: "party_b",
      active: actorRole === "party_b",
      detail: partyBDetail,
      meta: `Party B · ${actorRole === "party_b" ? "actor" : "observer"}`,
    },
    {
      key: "arbiter",
      title: arbiterName,
      role: "arbiter",
      active: true,
      detail: `${arbiterName} verifies the transition against source ${sourceRef}, terms ${termsRef}, and signs snapshot ${signedRef}.`,
      meta: "Arbiter · reviewer and signer",
    },
  ];
}

function buildReplayMessages(
  snapshot: ContractSnapshot,
  index: number,
  contract: Contract,
  snapshots: Map<string, ParticipantSnapshot>,
): ReplayMessage[] {
  const partyAName = resolveName(contract.party_a, snapshots);
  const partyBName = resolveName(contract.party_b, snapshots);
  const arbiterName = resolveName(snapshot.attestation?.signer ?? contract.arbiter, snapshots);
  const actorRole = resolveRole(snapshot.last_actor, contract);
  const actorName = resolveName(snapshot.last_actor, snapshots);
  const actionLabel = formatActionLabel(snapshot.last_action);
  const sourceRef = shortValue(snapshot.attestation?.prev_snapshot_hash, 8, 6);
  const signedRef = shortValue(snapshot.attestation?.snapshot_hash, 8, 6);
  const termsRef = shortValue(snapshot.terms.terms_hash, 8, 6);
  const reason = snapshot.last_reason;

  if (index === 0 || snapshot.last_action === "contract_create") {
    return [
      {
        actor: partyAName,
        role: "party_a",
        text: `I want to create this task as a contract with shared terms and a clear trust anchor.`,
        isCurrentActor: true,
      },
      {
        actor: arbiterName,
        role: "arbiter",
        text: `I freeze both participant identities, compute terms ${termsRef}, and sign snapshot ${signedRef}.`,
        isArbiterSignature: true,
      },
      {
        actor: partyBName,
        role: "party_b",
        text: `I can now inspect the draft and decide whether to accept this exact snapshot.`,
      },
    ];
  }

  if (snapshot.last_action === "contract_approve") {
    return [
      {
        actor: partyBName,
        role: "party_b",
        text: `I approve this draft against source ${sourceRef}, so my acceptance is bound to one exact revision and terms hash.`,
        isCurrentActor: true,
      },
      {
        actor: arbiterName,
        role: "arbiter",
        text: `I verify Bob's role, source snapshot, revision, and terms. Both approvals now match, so I activate the contract and sign ${signedRef}.`,
        isArbiterSignature: true,
      },
      {
        actor: partyAName,
        role: "party_a",
        text: `I now see that the contract is active and Bob is cleared to start working.`,
      },
    ];
  }

  if (snapshot.last_action === "contract_complete") {
    return [
      {
        actor: partyBName,
        role: "party_b",
        text: reason
          ? `I submit a delivery from snapshot ${sourceRef}: ${reason}`
          : `I submit the next delivery from snapshot ${sourceRef}.`,
        isCurrentActor: true,
      },
      {
        actor: arbiterName,
        role: "arbiter",
        text: `I verify that Bob is allowed to deliver from the current ACTIVE snapshot, then sign ${signedRef} as the new review state.`,
        isArbiterSignature: true,
      },
      {
        actor: partyAName,
        role: "party_a",
        text: `I can now inspect this delivery and either accept it or send it back for rework.`,
      },
    ];
  }

  if (snapshot.last_action === "contract_rework") {
    return [
      {
        actor: partyAName,
        role: "party_a",
        text: reason
          ? `I am requesting rework against snapshot ${sourceRef}: ${reason}`
          : `I am sending the work back for another iteration.`,
        isCurrentActor: true,
      },
      {
        actor: arbiterName,
        role: "arbiter",
        text: `I verify that Alex is the reviewer for this stage, record the rework request, and sign snapshot ${signedRef}.`,
        isArbiterSignature: true,
      },
      {
        actor: partyBName,
        role: "party_b",
        text: `I now have a signed rework state and can continue from the latest snapshot instead of guessing from chat context.`,
      },
    ];
  }

  if (snapshot.last_action === "contract_accept") {
    return [
      {
        actor: partyAName,
        role: "party_a",
        text: `I accept this delivery from source ${sourceRef}.`,
        isCurrentActor: true,
      },
      {
        actor: arbiterName,
        role: "arbiter",
        text: `I verify the acceptance, move the contract into settlement, and sign snapshot ${signedRef}.`,
        isArbiterSignature: true,
      },
      {
        actor: partyBName,
        role: "party_b",
        text: `I can now rely on a signed acceptance state instead of a soft promise in conversation.`,
      },
    ];
  }

  if (snapshot.last_action === "contract_rate") {
    return [
      {
        actor: partyAName,
        role: "party_a",
        text: snapshot.rating?.review
          ? `I rate the finished work: ${snapshot.rating.review}`
          : `I am attaching the final rating to this contract.`,
        isCurrentActor: true,
      },
      {
        actor: arbiterName,
        role: "arbiter",
        text: `I bind the rating to the signed contract lifecycle and produce final snapshot ${signedRef}.`,
        isArbiterSignature: true,
      },
      {
        actor: partyBName,
        role: "party_b",
        text: `My delivery history and rating are now attached to the same auditable contract chain.`,
      },
    ];
  }

  return [
    {
      actor: actorName,
      role: actorRole,
      text: `I trigger ${actionLabel} for this contract step.`,
      isCurrentActor: true,
    },
    {
      actor: arbiterName,
      role: "arbiter",
      text: `I verify the transition from ${sourceRef} and sign ${signedRef}.`,
      isArbiterSignature: true,
    },
    {
      actor: actorRole === "party_a" ? partyBName : partyAName,
      role: actorRole === "party_a" ? "party_b" : "party_a",
      text: `I observe the new signed state and continue from the latest snapshot.`,
    },
  ];
}

function buildTimeline(
  contract: Contract,
  snapshots: Map<string, ParticipantSnapshot>,
): TimelineItem[] {
  const partyA = resolveName(contract.party_a, snapshots);
  const partyB = resolveName(contract.party_b, snapshots);
  const arbiter = resolveName(contract.arbiter, snapshots);
  const approvals = [...(contract.approvals ?? [])].sort(
    (left, right) => left.approved_at - right.approved_at,
  );

  const items: TimelineItem[] = [
    {
      id: "created",
      actor: resolveName(contract.creator, snapshots),
      role: resolveRole(contract.creator, contract),
      title: "Task created",
      detail: `${partyA} opened the contract with ${partyB} and anchored revision v${contract.draft_version} under one shared terms hash.`,
      timestamp: contract.created_at,
      icon: FileSignature,
    },
  ];

  approvals.forEach((approval, index) => {
    const actor = resolveName(approval.approved_by, snapshots);
    items.push({
      id: `approval-${index}`,
      actor,
      role: approval.party_role,
      title: `${formatRole(approval.party_role)} approved`,
      detail: `${actor} approved revision v${approval.approved_revision} for terms ${shortValue(approval.approved_terms_hash, 10, 6)}.`,
      timestamp: approval.approved_at,
      icon: Check,
    });
  });

  if (contract.activated_at) {
    items.push({
      id: "activated",
      actor: arbiter,
      role: "arbiter",
      title: "Arbiter activated contract",
      detail: `Both sides approved the same terms, so Arbiter promoted the contract into active work and signed the new snapshot chain.`,
      timestamp: contract.activated_at,
      icon: ShieldCheck,
    });
  }

  if (contract.completed_at) {
    items.push({
      id: "completed",
      actor: partyB,
      role: "party_b",
      title: "Delivery submitted",
      detail: `${partyB} handed a delivery back for review. This transition is expected to point at the previous signed snapshot as its source.`,
      timestamp: contract.completed_at,
      icon: MessageSquare,
    });
  }

  if (contract.rework_count > 0) {
    items.push({
      id: "rework",
      actor:
        contract.last_action === "contract_rework"
          ? resolveName(contract.last_actor, snapshots)
          : partyA,
      role: "party_a",
      title: `Rework loop x${contract.rework_count}`,
      detail:
        contract.last_action === "contract_rework" && contract.last_reason
          ? `${partyA} sent the work back with reason: ${contract.last_reason}`
          : `${partyA} has already asked for ${contract.rework_count} rework loop${contract.rework_count > 1 ? "s" : ""}. The next delivery should continue from the latest signed snapshot.`,
      timestamp:
        contract.last_action === "contract_rework"
          ? (contract.last_action_at ?? null)
          : null,
      icon: RotateCcw,
    });
  }

  if (contract.settling_at) {
    items.push({
      id: "accepted",
      actor: partyA,
      role: "party_a",
      title: "Delivery accepted",
      detail: `${partyA} accepted the latest delivery and Arbiter moved the contract into settlement.`,
      timestamp: contract.settling_at,
      icon: CheckCheck,
    });
  }

  if (contract.settled_at) {
    items.push({
      id: "settled",
      actor: arbiter,
      role: "arbiter",
      title: "Settlement finalized",
      detail: `Arbiter finalized the contract lifecycle for ${contract.funding_mode.toUpperCase()} settlement handling.`,
      timestamp: contract.settled_at,
      icon: ShieldCheck,
    });
  }

  if (contract.cancelled_at) {
    items.push({
      id: "cancelled",
      actor: resolveName(contract.last_actor, snapshots),
      role: resolveRole(contract.last_actor, contract),
      title: "Contract cancelled",
      detail: contract.last_reason
        ? `The collaboration was cancelled with reason: ${contract.last_reason}`
        : "The collaboration was cancelled before completion.",
      timestamp: contract.cancelled_at,
      icon: XCircle,
    });
  }

  if (contract.status === "disputed") {
    items.push({
      id: "disputed",
      actor: resolveName(contract.last_actor, snapshots),
      role: resolveRole(contract.last_actor, contract),
      title: "Dispute opened",
      detail: contract.last_reason
        ? `A dispute was raised with reason: ${contract.last_reason}`
        : "The contract entered dispute and now depends on Arbiter's signed state for further resolution.",
      timestamp: contract.last_action_at ?? null,
      icon: MessageSquare,
    });
  }

  if (contract.rating) {
    items.push({
      id: "rating",
      actor: resolveName(contract.rated_by, snapshots),
      role: resolveRole(contract.rated_by, contract),
      title: `Rated ${contract.rating}/5`,
      detail: contract.review
        ? `Final review: ${contract.review}`
        : "A final rating has been attached for later trust computation.",
      timestamp: contract.rated_at ?? null,
      icon: Star,
    });
  }

  if (contract.attestation?.signed_at) {
    items.push({
      id: "attested",
      actor: arbiter,
      role: "arbiter",
      title: "Current snapshot attested",
      detail: `Arbiter signed snapshot ${shortValue(contract.attestation.snapshot_hash, 10, 6)} and linked it back to ${shortValue(contract.attestation.prev_snapshot_hash, 10, 6)}.`,
      timestamp: contract.attestation.signed_at,
      icon: GitBranch,
    });
  }

  if (
    !contract.activated_at &&
    contract.status === "draft" &&
    contract.current_snapshot_hash
  ) {
    items.push({
      id: "waiting",
      actor: arbiter,
      role: "arbiter",
      title: "Waiting on matching approval",
      detail: `The current draft snapshot is signed, but Arbiter will not activate the contract until both parties approve the same revision and terms hash.`,
      timestamp: contract.attestation?.signed_at ?? null,
      icon: Clock3,
    });
  }

  return items;
}

function getActorUid(
  action: ActionDef,
  currentUserUid: string,
  contract: Contract,
): string {
  if (action.kind === "contract_complete") {
    return contract.party_b.entity_uid || currentUserUid;
  }
  if (
    action.kind === "contract_accept" ||
    action.kind === "contract_rework" ||
    action.kind === "contract_rate"
  ) {
    return contract.party_a.entity_uid || currentUserUid;
  }
  return currentUserUid || contract.party_a.entity_uid || contract.party_b.entity_uid || "";
}

export function ContractDetail({
  contract,
  currentUserUid,
  tradeClient,
  onAction,
  onObserve,
}: ContractDetailProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [rating, setRating] = useState(5);
  const [review, setReview] = useState("");
  const [showReasonFor, setShowReasonFor] = useState<string | null>(null);
  const [showRating, setShowRating] = useState(false);
  const [replayState, setReplayState] = useState(() => ({
    contractId: contract.contract_id,
    index: 0,
  }));
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [visibleReplayMessages, setVisibleReplayMessages] = useState(0);
  const [workMessages, setWorkMessages] = useState<MailboxMessage[]>([]);
  const [loadingWorkMessages, setLoadingWorkMessages] = useState(false);
  const [workMessageInput, setWorkMessageInput] = useState("");
  const [sendingWorkMessage, setSendingWorkMessage] = useState(false);

  const actions = getAvailableActions(
    contract.status,
    currentUserUid,
    contract,
  );
  const participantSnapshots = contract.participant_snapshots ?? [];
  const approvals = contract.approvals ?? [];
  const receipts = contract.receipts ?? [];
  const snapshotHistory = contract.snapshot_history ?? [];
  const participantMap = new Map(
    participantSnapshots.map((participant) => [participant.entity_uid, participant]),
  );
  const partyAName = resolveName(contract.party_a, participantMap);
  const partyBName = resolveName(contract.party_b, participantMap);
  const arbiterName = resolveName(contract.arbiter, participantMap);
  const timeline = buildTimeline(contract, participantMap);
  const workSessionId = contract.work_session_id ?? null;
  const workSessionName = contract.work_session_name ?? contract.title;
  const isParticipant =
    currentUserUid === contract.party_a.entity_uid ||
    currentUserUid === contract.party_b.entity_uid;
  const replayMaxIndex = Math.max(snapshotHistory.length - 1, 0);
  const replayIndex =
    replayState.contractId === contract.contract_id
      ? Math.min(replayState.index, replayMaxIndex)
      : replayMaxIndex;
  const displayWorkMessages =
    workSessionId && currentUserUid ? workMessages : [];
  const isReplayAutoPlaying =
    isAutoPlaying &&
    snapshotHistory.length > 1 &&
    replayIndex < replayMaxIndex;
  const activeReplaySnapshot = snapshotHistory[replayIndex] ?? null;
  const replayLanes = activeReplaySnapshot
    ? buildReplayLanes(activeReplaySnapshot, contract, participantMap)
    : [];
  const replayMessages = activeReplaySnapshot
    ? buildReplayMessages(activeReplaySnapshot, replayIndex, contract, participantMap)
    : [];
  const interactionRef = useRef<HTMLDivElement | null>(null);
  const replayMessageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const partyAMessage = replayMessages.find((message) => message.role === "party_a");
  const partyBMessage = replayMessages.find((message) => message.role === "party_b");
  const arbiterMessage = replayMessages.find((message) => message.role === "arbiter");

  const shiftReplayIndex = useCallback(
    (update: number | ((current: number) => number)) => {
      setReplayState((current) => {
        const baseIndex =
          current.contractId === contract.contract_id
            ? Math.min(current.index, replayMaxIndex)
            : replayMaxIndex;
        const nextIndex =
          typeof update === "number" ? update : update(baseIndex);

        return {
          contractId: contract.contract_id,
          index: Math.max(0, Math.min(replayMaxIndex, nextIndex)),
        };
      });
    },
    [contract.contract_id, replayMaxIndex],
  );

  useEffect(() => {
    if (!workSessionId || !currentUserUid) return;

    let active = true;
    async function loadMessages(withSpinner = false) {
      if (withSpinner) setLoadingWorkMessages(true);
      try {
        const mailbox = await getMessages(currentUserUid);
        if (!active) return;
        const filtered = mailbox.filter((message) => {
          const payload = message.payload as Record<string, unknown>;
          return payload.session_id === workSessionId;
        });
        setWorkMessages(filtered);
      } catch {
        if (active) setWorkMessages([]);
      } finally {
        if (active && withSpinner) setLoadingWorkMessages(false);
      }
    }

    loadMessages(true);
    const timer = window.setInterval(() => {
      loadMessages(false);
    }, 1800);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [contract.contract_id, currentUserUid, workSessionId]);

  useEffect(() => {
    if (!isReplayAutoPlaying) return;

    const timer = window.setTimeout(() => {
      shiftReplayIndex((current: number) => {
        const next = Math.min(replayMaxIndex, current + 1);
        if (next >= replayMaxIndex) {
          setIsAutoPlaying(false);
        }
        return next;
      });
    }, 1400);

    return () => window.clearTimeout(timer);
  }, [isReplayAutoPlaying, replayMaxIndex, shiftReplayIndex]);

  useEffect(() => {
    replayMessageRefs.current = [];

    let interval: number | null = null;
    let current = 0;
    const startTimer = window.setTimeout(() => {
      setVisibleReplayMessages(0);
      if (replayMessages.length === 0) return;

      interval = window.setInterval(() => {
        current += 1;
        setVisibleReplayMessages(current);
        if (current >= replayMessages.length && interval !== null) {
          window.clearInterval(interval);
        }
      }, 220);
    }, 0);

    return () => {
      window.clearTimeout(startTimer);
      if (interval !== null) {
        window.clearInterval(interval);
      }
    };
  }, [replayIndex, replayMessages.length]);

  useEffect(() => {
    if (visibleReplayMessages <= 0) return;
    const target = replayMessageRefs.current[visibleReplayMessages - 1];
    target?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [visibleReplayMessages]);

  async function executeAction(action: ActionDef) {
    if (action.needsReason && showReasonFor !== action.kind) {
      setShowReasonFor(action.kind);
      return;
    }
    if (action.needsRating && !showRating) {
      setShowRating(true);
      return;
    }

    setLoading(action.kind);
    try {
      const payload: Record<string, unknown> = {
        contract_id: contract.contract_id,
        expected_status: contract.status,
        revision: contract.draft_version,
      };

      if (contract.terms_hash) payload.terms_hash = contract.terms_hash;
      if (contract.current_snapshot_hash) {
        payload.source_snapshot_hash = contract.current_snapshot_hash;
      }
      if (action.needsReason && reason) payload.reason = reason;
      if (action.needsRating) {
        payload.rating = rating;
        payload.review = review;
      }

      const actor = getActorUid(action, currentUserUid, contract);
      await tradeClient.tradeSend(actor, action.kind, payload);

      setShowReasonFor(null);
      setShowRating(false);
      setReason("");
      setReview("");
      onAction();
    } catch {
      /* ignore */
    } finally {
      setLoading(null);
    }
  }

  async function sendWorkMessage() {
    const text = workMessageInput.trim();
    if (!text || !isParticipant || !currentUserUid) return;

    setSendingWorkMessage(true);
    try {
      await tradeClient.sendContractMessage(contract.contract_id, currentUserUid, text);
      setWorkMessageInput("");
      const mailbox = await getMessages(currentUserUid);
      const filtered = mailbox.filter((message) => {
        const payload = message.payload as Record<string, unknown>;
        return payload.session_id === workSessionId;
      });
      setWorkMessages(filtered);
    } catch {
      /* ignore */
    } finally {
      setSendingWorkMessage(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <div className="pt-3 mt-3 border-t border-border space-y-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <div>
            <span className="text-muted-foreground">Party A: </span>
            <span className="font-medium">
              {resolveName(contract.party_a, participantMap)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Party B: </span>
            <span className="font-medium">
              {resolveName(contract.party_b, participantMap)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Mode: </span>
            <span className="font-medium uppercase">
              {contract.funding_mode}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Revision: </span>
            <span className="font-medium">v{contract.draft_version}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Created: </span>
            <span>{formatTime(contract.created_at)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Last Action: </span>
            <span className="capitalize">
              {formatActionLabel(contract.last_action)}
            </span>
          </div>
          {contract.rework_count > 0 && (
            <div>
              <span className="text-muted-foreground">Reworks: </span>
              <span>
                {contract.rework_count}/{contract.max_rework_count}
              </span>
            </div>
          )}
          {contract.rating && (
            <div>
              <span className="text-muted-foreground">Rating: </span>
              <span>{"★".repeat(contract.rating)}{"☆".repeat(5 - contract.rating)}</span>
            </div>
          )}
        </div>

        {contract.description && (
          <p className="text-xs text-muted-foreground/80 leading-relaxed">
            {contract.description}
          </p>
        )}

        <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[11px] font-medium">
              <Clock3 className="h-3.5 w-3.5 text-muted-foreground" />
              Current Handoff
            </div>
            {onObserve && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={onObserve}
              >
                <Eye className="mr-1 h-3.5 w-3.5" />
                Observer
              </Button>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground/80 leading-relaxed">
            {summarizeNextStep(contract, participantMap)}
          </p>
        </div>

        {workSessionId && (
          <div className="rounded-xl border border-border/70 bg-background/80 px-3 py-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Work Session
                </div>
                <p className="mt-1 text-xs text-muted-foreground/80">
                  Real contract-linked chat. Messages sent here keep the same session and can trigger the counterparty agent.
                </p>
              </div>
              <Badge variant="secondary" className="text-[10px]">
                {workSessionName}
              </Badge>
            </div>

            <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
              <div>
                <span className="font-medium text-foreground/80">Session:</span>{" "}
                <span className="font-mono">{workSessionId}</span>
              </div>
              <div>
                <span className="font-medium text-foreground/80">Flow:</span>{" "}
                {partyAName} ⇄ {partyBName} via {arbiterName}-anchored contract
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-border/60 bg-muted/20 p-3">
              <div className="max-h-60 space-y-2 overflow-auto">
                {loadingWorkMessages && displayWorkMessages.length === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading work session…
                  </div>
                ) : displayWorkMessages.length === 0 ? (
                  <p className="text-xs text-muted-foreground/80">
                    No real work messages yet. Send a kickoff note here to trigger the next turn.
                  </p>
                ) : (
                  displayWorkMessages.map((message) => {
                    const isOutbound = message.direction === "outbound";
                    return (
                      <div
                        key={message.message_id}
                        className={cn(
                          "flex",
                          isOutbound ? "justify-end" : "justify-start",
                        )}
                      >
                        <div
                          className={cn(
                            "max-w-[85%] rounded-2xl px-3 py-2 text-xs",
                            isOutbound
                              ? "bg-foreground text-background"
                              : "bg-background border border-border text-foreground",
                          )}
                        >
                          <div className="flex items-center gap-2 text-[10px] opacity-80">
                            <span>{resolveMailboxActorName(message.sender, participantMap)}</span>
                            <span>{new Date(message.timestamp).toLocaleTimeString()}</span>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap leading-relaxed">
                            {extractMailboxText(message)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {isParticipant && (
                <div className="mt-3 flex gap-2">
                  <Input
                    value={workMessageInput}
                    onChange={(event) => setWorkMessageInput(event.target.value)}
                    placeholder={`Send the next contract-scoped message to ${currentUserUid === contract.party_a.entity_uid ? partyBName : partyAName}`}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void sendWorkMessage();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={!workMessageInput.trim() || sendingWorkMessage}
                    onClick={() => void sendWorkMessage()}
                  >
                    {sendingWorkMessage ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <MessageSquare className="mr-2 h-4 w-4" />
                    )}
                    Send
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2">
          {snapshotHistory.length > 0 && (
            <>
              <div className="rounded-xl border border-border/70 bg-background/80 px-3 py-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                      <GitBranch className="h-3.5 w-3.5" />
                      Replay
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground/80">
                      Step through the contract as three protocol actors: Alex, Bob, and Arbiter.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5"
                      disabled={snapshotHistory.length <= 1}
                      onClick={() => {
                        if (replayIndex >= snapshotHistory.length - 1) {
                          shiftReplayIndex(0);
                        }
                        setIsAutoPlaying((current) => !current);
                      }}
                    >
                      {isAutoPlaying ? (
                        <Pause className="h-3.5 w-3.5 mr-1" />
                      ) : (
                        <Play className="h-3.5 w-3.5 mr-1" />
                      )}
                      {isAutoPlaying ? "Pause" : "Auto Play"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      disabled={replayIndex === 0}
                      onClick={() => {
                        setIsAutoPlaying(false);
                        shiftReplayIndex((current: number) => Math.max(0, current - 1));
                      }}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Badge variant="secondary" className="h-7 px-2.5 text-[10px]">
                      {`S${replayIndex} / S${snapshotHistory.length - 1}`}
                    </Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      disabled={replayIndex === snapshotHistory.length - 1}
                      onClick={() => shiftReplayIndex((current: number) => Math.min(snapshotHistory.length - 1, current + 1))}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {snapshotHistory.map((snapshot, index) => (
                    <button
                      key={snapshot.attestation?.snapshot_hash ?? `${snapshot.contract_id}-${index}-jump`}
                      type="button"
                      onClick={() => {
                        setIsAutoPlaying(false);
                        shiftReplayIndex(index);
                      }}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                        replayIndex === index
                          ? "border-foreground/20 bg-foreground text-background"
                          : "border-border bg-background text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {`S${index} ${formatSnapshotStep(index, snapshot)}`}
                    </button>
                  ))}
                </div>

                {activeReplaySnapshot && (
                  <>
                    <div className="mt-3 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge
                          variant="secondary"
                          className="h-5 border-0 text-[10px] bg-slate-500/10 text-slate-700 dark:text-slate-300"
                        >
                          {`S${replayIndex}`}
                        </Badge>
                        <p className="text-xs font-medium">
                          {formatSnapshotStep(replayIndex, activeReplaySnapshot)}
                        </p>
                        <StatusBadge status={activeReplaySnapshot.status} />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground/80 leading-relaxed">
                        {activeReplaySnapshot.last_actor
                          ? `${resolveName(activeReplaySnapshot.last_actor, participantMap)} triggers ${formatActionLabel(activeReplaySnapshot.last_action)}.`
                          : "This is the signed initial contract snapshot."}
                      </p>
                    </div>

                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      {replayLanes.map((lane) => (
                        <div
                          key={lane.key}
                          className={cn(
                            "rounded-xl border px-3 py-3",
                            lane.active
                              ? "border-foreground/15 bg-background"
                              : "border-border/70 bg-background/70",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-medium">{lane.title}</p>
                            <Badge
                              variant="secondary"
                              className={cn(
                                "h-5 border-0 text-[10px]",
                                ROLE_COLORS[lane.role] ?? ROLE_COLORS.system,
                              )}
                            >
                              {formatRole(lane.role)}
                            </Badge>
                          </div>
                          <p className="mt-1 text-[11px] text-muted-foreground/70">
                            {lane.meta}
                          </p>
                          <p className="mt-2 text-xs text-muted-foreground/85 leading-relaxed">
                            {lane.detail}
                          </p>
                        </div>
                      ))}
                    </div>

                    <div className="mt-3 rounded-xl border border-border/60 bg-background/80 px-3 py-3">
                      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        <MessageSquare className="h-3.5 w-3.5" />
                        Interaction
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground/70">
                        Generated from the signed contract step, laid out as a protocol interaction between Alex, Arbiter, and Bob.
                      </p>
                      <div ref={interactionRef} className="mt-3 grid gap-3 lg:grid-cols-[1fr_1.2fr_1fr]">
                        <motion.div
                          ref={(node) => {
                            replayMessageRefs.current[0] = node;
                          }}
                          initial={{ opacity: 0, x: -12 }}
                          animate={{ opacity: visibleReplayMessages >= 1 ? 1 : 0.35, x: 0 }}
                          transition={{ duration: 0.24 }}
                          className={cn(
                            "rounded-2xl border px-3 py-3 bg-sky-500/10 border-sky-500/15",
                            partyAMessage?.isCurrentActor &&
                              "ring-2 ring-sky-500/25 shadow-[0_10px_30px_rgba(14,165,233,0.12)]",
                          )}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-xs font-medium">{partyAName}</p>
                            <Badge
                              variant="secondary"
                              className={cn("h-5 border-0 text-[10px]", ROLE_COLORS.party_a)}
                            >
                              Party A
                            </Badge>
                            {partyAMessage?.isCurrentActor && (
                              <Badge
                                variant="secondary"
                                className="h-5 border-0 text-[10px] bg-foreground text-background"
                              >
                                Current Actor
                              </Badge>
                            )}
                          </div>
                          <p className="mt-2 text-xs leading-relaxed text-sky-950 dark:text-sky-50">
                            {visibleReplayMessages >= 1
                              ? (partyAMessage?.text ?? `${partyAName} is observing this step.`)
                              : "Waiting for this step to appear..."}
                          </p>
                        </motion.div>

                        <motion.div
                          ref={(node) => {
                            replayMessageRefs.current[1] = node;
                          }}
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: visibleReplayMessages >= 2 ? 1 : 0.35, y: 0 }}
                          transition={{ duration: 0.24 }}
                          className={cn(
                            "rounded-2xl border px-3 py-3 bg-amber-500/10 border-amber-500/20",
                            arbiterMessage?.isArbiterSignature &&
                              "ring-2 ring-amber-500/25 shadow-[0_14px_34px_rgba(245,158,11,0.15)]",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-xs font-medium">{arbiterName}</p>
                              <Badge
                                variant="secondary"
                                className={cn("h-5 border-0 text-[10px]", ROLE_COLORS.arbiter)}
                              >
                                Arbiter
                              </Badge>
                            </div>
                            {arbiterMessage?.isArbiterSignature && (
                              <Badge
                                variant="secondary"
                                className="h-5 border-0 text-[10px] bg-amber-600 text-white"
                              >
                                Signs Snapshot
                              </Badge>
                            )}
                          </div>
                          <div className="mt-3 rounded-xl border border-amber-500/20 bg-background/70 px-3 py-2.5">
                            <div className="grid gap-2 md:grid-cols-[1fr_auto_1fr] items-center text-[11px]">
                              <div>
                                <p className="text-muted-foreground">Source Snapshot</p>
                                <p className="mt-0.5 font-mono">
                                  {shortValue(activeReplaySnapshot.attestation?.prev_snapshot_hash, 12, 8)}
                                </p>
                              </div>
                              <div className="text-center text-muted-foreground font-mono">
                                {"->"}
                              </div>
                              <div>
                                <p className="text-muted-foreground">Signed Snapshot</p>
                                <p className="mt-0.5 font-mono">
                                  {shortValue(activeReplaySnapshot.attestation?.snapshot_hash, 12, 8)}
                                </p>
                              </div>
                            </div>
                          </div>
                          <p className="mt-3 text-xs leading-relaxed text-amber-950 dark:text-amber-50">
                            {visibleReplayMessages >= 2
                              ? (arbiterMessage?.text ?? `${arbiterName} verifies and signs this transition.`)
                              : "Waiting for Arbiter verification..."}
                          </p>
                        </motion.div>

                        <motion.div
                          ref={(node) => {
                            replayMessageRefs.current[2] = node;
                          }}
                          initial={{ opacity: 0, x: 12 }}
                          animate={{ opacity: visibleReplayMessages >= 3 ? 1 : 0.35, x: 0 }}
                          transition={{ duration: 0.24 }}
                          className={cn(
                            "rounded-2xl border px-3 py-3 bg-green-500/10 border-green-500/15",
                            partyBMessage?.isCurrentActor &&
                              "ring-2 ring-green-500/25 shadow-[0_10px_30px_rgba(34,197,94,0.12)]",
                          )}
                        >
                          <div className="flex items-center gap-2 flex-wrap justify-start lg:justify-end">
                            <p className="text-xs font-medium">{partyBName}</p>
                            <Badge
                              variant="secondary"
                              className={cn("h-5 border-0 text-[10px]", ROLE_COLORS.party_b)}
                            >
                              Party B
                            </Badge>
                            {partyBMessage?.isCurrentActor && (
                              <Badge
                                variant="secondary"
                                className="h-5 border-0 text-[10px] bg-foreground text-background"
                              >
                                Current Actor
                              </Badge>
                            )}
                          </div>
                          <p className="mt-2 text-xs leading-relaxed text-green-950 dark:text-green-50 lg:text-right">
                            {visibleReplayMessages >= 3
                              ? (partyBMessage?.text ?? `${partyBName} is observing this step.`)
                              : "Waiting for this step to appear..."}
                          </p>
                        </motion.div>
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2 md:grid-cols-3 text-[11px]">
                      <div className="rounded-lg border border-border/60 px-2.5 py-2">
                        <p className="text-muted-foreground">Source Snapshot</p>
                        <p className="mt-0.5 font-mono">
                          {shortValue(activeReplaySnapshot.attestation?.prev_snapshot_hash, 12, 8)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-border/60 px-2.5 py-2">
                        <p className="text-muted-foreground">Signed Snapshot</p>
                        <p className="mt-0.5 font-mono">
                          {shortValue(activeReplaySnapshot.attestation?.snapshot_hash, 12, 8)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-border/60 px-2.5 py-2">
                        <p className="text-muted-foreground">Reason / Review</p>
                        <p className="mt-0.5 text-muted-foreground/90 leading-relaxed">
                          {activeReplaySnapshot.last_reason ||
                            activeReplaySnapshot.rating?.review ||
                            formatActionLabel(activeReplaySnapshot.last_action)}
                        </p>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <GitBranch className="h-3.5 w-3.5" />
                Snapshot Timeline
              </div>
              <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                This is the actual Arbiter-signed snapshot history for the contract lifecycle.
              </p>
              <div className="space-y-2">
                {snapshotHistory.map((snapshot, index) => (
                  <div
                    key={snapshot.attestation?.snapshot_hash ?? `${snapshot.contract_id}-${index}`}
                    className="rounded-xl border border-border/70 bg-background/80 px-3 py-2.5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant="secondary"
                            className="h-5 border-0 text-[10px] bg-slate-500/10 text-slate-700 dark:text-slate-300"
                          >
                            {`S${index}`}
                          </Badge>
                          <p className="text-xs font-medium">
                            {formatSnapshotStep(index, snapshot)}
                          </p>
                          <StatusBadge status={snapshot.status} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground/80">
                          {snapshot.last_actor
                            ? `${resolveName(snapshot.last_actor, participantMap)} · ${formatActionLabel(snapshot.last_action)}`
                            : "Arbiter-signed protocol snapshot"}
                        </p>
                      </div>
                      <span className="text-[10px] text-muted-foreground/60 shrink-0">
                        {formatTime(snapshot.attestation?.signed_at ?? snapshot.last_action_at)}
                      </span>
                    </div>
                    <div className="mt-2 grid gap-2 md:grid-cols-2 text-[11px]">
                      <div className="rounded-lg border border-border/60 px-2.5 py-2">
                        <p className="text-muted-foreground">Source Snapshot</p>
                        <p className="mt-0.5 font-mono">
                          {shortValue(snapshot.attestation?.prev_snapshot_hash, 12, 8)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-border/60 px-2.5 py-2">
                        <p className="text-muted-foreground">Signed Snapshot</p>
                        <p className="mt-0.5 font-mono">
                          {shortValue(snapshot.attestation?.snapshot_hash, 12, 8)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-2 md:grid-cols-2 text-[11px]">
                      <div className="rounded-lg border border-border/60 px-2.5 py-2">
                        <p className="text-muted-foreground">Terms Hash</p>
                        <p className="mt-0.5 font-mono">
                          {shortValue(snapshot.terms.terms_hash, 12, 8)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-border/60 px-2.5 py-2">
                        <p className="text-muted-foreground">Actor / Reason</p>
                        <p className="mt-0.5 text-muted-foreground/90 leading-relaxed">
                          {snapshot.last_reason || formatActionLabel(snapshot.last_action)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            Collaboration Flow
          </div>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            This view is reconstructed from the signed contract state, approvals,
            and current snapshot chain already stored by Arbiter.
          </p>
          <div className="space-y-2">
            {timeline.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-border/70 bg-background/80 px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <div
                      className={cn(
                        "mt-0.5 h-7 w-7 rounded-full flex items-center justify-center shrink-0",
                        ROLE_COLORS[item.role] ?? ROLE_COLORS.system,
                      )}
                    >
                      <item.icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-xs font-medium">{item.actor}</p>
                        <Badge
                          variant="secondary"
                          className={cn(
                            "h-5 border-0 text-[10px]",
                            ROLE_COLORS[item.role] ?? ROLE_COLORS.system,
                          )}
                        >
                          {formatRole(item.role)}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs font-medium">{item.title}</p>
                    </div>
                  </div>
                  <span className="text-[10px] text-muted-foreground/60 shrink-0">
                    {formatTime(item.timestamp)}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground/80 leading-relaxed">
                  {item.detail}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border/70 bg-background/80 px-3 py-3">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <GitBranch className="h-3.5 w-3.5" />
              Snapshot Evidence
            </div>
            <div className="mt-3 space-y-2 text-xs">
              <div>
                <p className="text-muted-foreground">Current Snapshot</p>
                <p className="font-mono mt-0.5">
                  {shortValue(contract.current_snapshot_hash, 16, 10)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Previous Snapshot</p>
                <p className="font-mono mt-0.5">
                  {shortValue(contract.prev_snapshot_hash, 16, 10)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Terms Hash</p>
                <p className="font-mono mt-0.5">
                  {shortValue(contract.terms_hash, 16, 10)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Last Transition</p>
                <p className="mt-0.5">
                  {formatActionLabel(contract.last_action)} by{" "}
                  {resolveName(contract.last_actor, participantMap)}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-background/80 px-3 py-3">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Arbiter Review
            </div>
            <div className="mt-3 space-y-2 text-xs">
              <div>
                <p className="text-muted-foreground">Signer</p>
                <p className="mt-0.5">
                  {resolveName(contract.attestation?.signer ?? contract.arbiter, participantMap)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Signed At</p>
                <p className="mt-0.5">{formatTime(contract.attestation?.signed_at)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Signature Algorithm</p>
                <p className="mt-0.5">
                  {contract.attestation?.signature_alg ||
                    contract.arbiter_signature_alg ||
                    "-"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Chain Check</p>
                <p className="mt-0.5">
                  {contract.attestation?.prev_snapshot_hash === contract.prev_snapshot_hash
                    ? "Current attestation matches the stored previous snapshot link."
                    : "Current snapshot is signed, but the previous-link metadata is incomplete."}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border/70 bg-background/80 px-3 py-3">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <CheckCheck className="h-3.5 w-3.5" />
              Delivery Evidence
            </div>
            {contract.current_delivery ? (
              <div className="mt-3 space-y-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Version</p>
                  <p className="mt-0.5 font-medium">{contract.current_delivery.version}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Summary</p>
                  <p className="mt-0.5 leading-relaxed text-muted-foreground/90">
                    {contract.current_delivery.summary}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Produced</p>
                  <p className="mt-0.5">
                    {resolveName(contract.current_delivery.produced_by, participantMap)} ·{" "}
                    {formatTime(contract.current_delivery.produced_at)}
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-muted-foreground">Artifacts</p>
                  {contract.current_delivery.artifacts.length > 0 ? (
                    contract.current_delivery.artifacts.map((artifact, index) => (
                      <div
                        key={`${artifact.uri}-${index}`}
                        className="rounded-lg border border-border/60 px-2.5 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium">{artifact.label || artifact.kind}</p>
                          <Badge variant="secondary" className="h-5 border-0 text-[10px]">
                            {artifact.kind}
                          </Badge>
                        </div>
                        <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground/80">
                          {artifact.uri}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-muted-foreground/70">No structured artifacts attached yet.</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground/70">
                No structured delivery evidence has been recorded yet.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-border/70 bg-background/80 px-3 py-3">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              Execution Costs
            </div>
            {(contract.current_execution_costs?.length ?? 0) > 0 ? (
              <div className="mt-3 space-y-2 text-xs">
                {contract.current_execution_costs?.map((cost, index) => (
                  <div
                    key={`${cost.report_id ?? "cost"}-${index}`}
                    className="rounded-lg border border-border/60 px-2.5 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{cost.phase || "execution"}</p>
                      <p>{formatUsd(cost.cost_usd)}</p>
                    </div>
                    <p className="mt-1 text-muted-foreground/80">
                      {resolveName(cost.actor, participantMap)} ·{" "}
                      {[cost.provider, cost.model].filter(Boolean).join(" / ") || "provider not recorded"}
                    </p>
                    <p className="mt-1 text-muted-foreground/80">
                      in {cost.input_tokens ?? 0} / out {cost.output_tokens ?? 0} / {cost.runtime_ms ?? 0} ms
                    </p>
                    {cost.notes && (
                      <p className="mt-1 leading-relaxed text-muted-foreground/80">
                        {cost.notes}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground/70">
                No execution cost reports have been recorded yet.
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border/70 bg-background/80 px-3 py-3">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <UserRound className="h-3.5 w-3.5" />
              Participants
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {participantSnapshots.length === 0 ? (
                <p className="text-xs text-muted-foreground/70">
                  No frozen participant snapshot yet.
                </p>
              ) : (
                participantSnapshots.map((participant) => (
                  <div
                    key={`${participant.role}-${participant.entity_uid}`}
                    className="rounded-lg border border-border/60 px-2.5 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium">
                        {participant.display_name || participant.entity_uid}
                      </p>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "h-5 border-0 text-[10px]",
                          ROLE_COLORS[participant.role] ?? ROLE_COLORS.system,
                        )}
                      >
                        {formatRole(participant.role)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground/70 font-mono">
                      {shortValue(participant.sign_public_key, 16, 8)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-background/80 px-3 py-3">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <FileSignature className="h-3.5 w-3.5" />
              Approvals & Receipts
            </div>
            <div className="mt-3 space-y-3">
              <div>
                <p className="text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
                  Approvals
                </p>
                <div className="mt-2 space-y-2">
                  {approvals.length === 0 ? (
                    <p className="text-xs text-muted-foreground/70">
                      No approvals yet.
                    </p>
                  ) : (
                    approvals.map((approval, index) => (
                      <div
                        key={`${approval.party_role}-${index}`}
                        className="rounded-lg border border-border/60 px-2.5 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium">
                            {resolveName(approval.approved_by, participantMap)}
                          </p>
                          <Badge
                            variant="secondary"
                            className={cn(
                              "h-5 border-0 text-[10px]",
                              ROLE_COLORS[approval.party_role] ?? ROLE_COLORS.system,
                            )}
                          >
                            {formatRole(approval.party_role)}
                          </Badge>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground/70">
                          v{approval.approved_revision} ·{" "}
                          {shortValue(approval.approved_terms_hash, 10, 6)} ·{" "}
                          {formatTime(approval.approved_at)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <p className="text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
                  Receipts
                </p>
                <div className="mt-2 space-y-2">
                  {receipts.length === 0 ? (
                    <p className="text-xs text-muted-foreground/70">
                      No observation receipts yet.
                    </p>
                  ) : (
                    receipts.map((receipt, index) => (
                      <div
                        key={`${receipt.status_message_id}-${index}`}
                        className="rounded-lg border border-border/60 px-2.5 py-2"
                      >
                        <p className="text-xs font-medium">
                          {resolveName(receipt.recipient, participantMap)}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground/70">
                          ACK {shortValue(receipt.snapshot_hash, 10, 6)} ·{" "}
                          {formatTime(receipt.acked_at)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {contract.review && (
          <p className="text-xs italic text-muted-foreground/60">
            "{contract.review}"
          </p>
        )}

        {showReasonFor && (
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)..."
            className="h-8 text-xs"
          />
        )}

        {showRating && (
          <div className="flex items-center gap-2">
            <div className="flex gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(n)}
                  className={cn(
                    "text-sm transition-colors",
                    n <= rating
                      ? "text-yellow-500"
                      : "text-muted-foreground/30",
                  )}
                >
                  ★
                </button>
              ))}
            </div>
            <Input
              value={review}
              onChange={(e) => setReview(e.target.value)}
              placeholder="Review..."
              className="h-8 text-xs flex-1"
            />
          </div>
        )}

        <div className="flex gap-2 flex-wrap">
          {actions.map((action) => (
            <Button
              key={action.kind}
              variant={action.variant}
              size="sm"
              className="h-7 text-xs px-3"
              disabled={loading !== null}
              onClick={() => executeAction(action)}
            >
              {loading === action.kind ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <action.icon className="h-3 w-3 mr-1" />
              )}
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
