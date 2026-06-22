/* Single chat message bubble — premium styling with status tracking. */

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  Loader2,
  Copy,
} from "lucide-react";

import { cn, normalizeTimestamp, extractEntityUid, EASE_SMOOTH } from "@/lib/utils";
import type {
  ApprovalStatusPayload,
  CarbonCopyMessage,
  Message,
  MessageStatus,
} from "@/types";
import { ApprovalCard } from "./approval-card";
import { MarkdownContent } from "./markdown-content";
import { PaymentCard } from "./payment-card";

type Display =
  | { mode: "hidden" }
  | { mode: "system"; text: string }
  | { mode: "card" }
  | { mode: "approval_card" }
  | { mode: "normal" };

const PAYMENT_CARD_KINDS = new Set(["pay_collect", "pay_request", "pay_claim_completed"]);
const HIDDEN_KINDS = new Set([
  "contract_create",
  "contract_approve",
  "contract_reject",
  "contract_complete",
  "contract_rework",
  "contract_rate",
  "contract_cancel",
  "contract_dispute",
  "contract_status_ack",
  "approval_response",
]);
const CONTRACT_STATUS_TEXT: Record<string, string> = {
  draft: "合同草稿已创建",
  settled: "✓ 合同已结算",
  settling: "进入结算阶段",
  active: "合同已激活",
  completing: "已提交完成，等待验收",
  pending: "合同已同意，待生效",
  cancelled: "合同已取消",
  disputed: "合同进入争议",
};

function normalizeApprovalStatusPayload(
  payload: Record<string, unknown>,
): ApprovalStatusPayload | null {
  if (typeof payload.request_id !== "string" || typeof payload.original_kind !== "string") {
    return null;
  }
  return payload as ApprovalStatusPayload;
}

function resolveApprovalStatusText(payload: Record<string, unknown>): string | null {
  const approval = normalizeApprovalStatusPayload(payload);
  if (!approval) {
    const rawMessage = payload?.message;
    return typeof rawMessage === "string" ? rawMessage : null;
  }

  const preview = typeof approval.original_preview === "string" && approval.original_preview
    ? `【${approval.original_preview}】`
    : "";
  const decision = typeof approval.decision === "string" ? approval.decision : "";

  if (approval.flow_side === "inbound" && approval.status === "pending") {
    return `通知：你收到一条 ${approval.original_kind}${preview}，当前由 owner 处理；结果会通知你；你可以提醒 owner。`;
  }
  if (approval.flow_side === "outbound" && approval.status === "pending") {
    return `${preview}消息需要 owner 审核；通过后自动继续发送；驳回则终止发送；结果会通知你。`;
  }
  if (approval.flow_side === "outbound" && approval.status === "approved") {
    return `${preview}owner 已审核通过，消息已自动继续发送给对方。`;
  }
  if (approval.flow_side === "outbound" && approval.status === "rejected") {
    return decision
      ? `${preview}owner 已驳回，消息不会继续发送给对方。${decision}`
      : `${preview}owner 已驳回，消息不会继续发送给对方。`;
  }
  if (approval.flow_side === "inbound" && approval.status === "approved") {
    return decision
      ? `通知：owner 已处理完成。审核通过；你可以继续执行 ${decision}。`
      : "通知：owner 已处理完成。审核通过；你可以继续下一步操作。";
  }
  if (approval.flow_side === "inbound" && approval.status === "rejected") {
    return decision
      ? `通知：owner 已处理完成。审核未通过；当前结果：${decision}。`
      : "通知：owner 已处理完成。审核未通过；当前流程已终止。";
  }
  return typeof approval.message === "string" ? approval.message : null;
}

function resolveDisplay(
  kind: string | undefined,
  payload: Record<string, unknown>,
  isSelf: boolean,
): Display {
  if (!kind) return { mode: "normal" };
  if (HIDDEN_KINDS.has(kind)) return { mode: "hidden" };
  if (kind === "approval_request") return { mode: "approval_card" };
  if (kind === "approval_status") {
    const message = resolveApprovalStatusText(payload);
    if (message) return { mode: "system", text: message };
  }
  if (PAYMENT_CARD_KINDS.has(kind)) return { mode: "card" };
  if (kind === "pay_confirm_receipt")
    return { mode: "system", text: isSelf ? "✓ 已确认收款" : "✓ 对方已确认收款" };
  if (kind === "pay_completed") return { mode: "system", text: "通知：支付已完成" };
  if (kind === "contract_accept")
    return { mode: "system", text: isSelf ? "我已验收" : "对方已验收" };
  if (kind === "contract_status") {
    const message = payload?.message as string | undefined;
    if (message) return { mode: "system", text: message };
    const status = payload?.status as string | undefined;
    const text = status && CONTRACT_STATUS_TEXT[status];
    if (text) return { mode: "system", text };
  }
  return { mode: "normal" };
}

interface MessageItemProps {
  message: Message;
  isSelf: boolean;
  selfEntityUid?: string;
  paymentState?: "pending" | "claimed" | "completed";
  respondedApprovalIds?: Map<string, { action: string; inputData?: string }>;
  animateOnMount?: boolean;
}

interface CopyMessageButtonProps {
  copied: boolean;
  disabled: boolean;
  isSelf: boolean;
  onCopy: () => void;
}

function CopyMessageButton({
  copied,
  disabled,
  isSelf,
  onCopy,
}: CopyMessageButtonProps) {
  return (
    <button
      type="button"
      onClick={onCopy}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
        disabled
          ? "opacity-40 cursor-not-allowed"
          : isSelf
            ? "text-primary-foreground/60 hover:text-primary-foreground/85 hover:bg-white/10"
            : "text-muted-foreground/70 hover:text-foreground/80 hover:bg-surface-hover",
      )}
    >
      <Copy className="h-2.5 w-2.5" />
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function StatusIcon({ status }: { status?: MessageStatus }) {
  const iconClass = "h-3 w-3";

  switch (status) {
    case "sent":
    case "delivering":
      return <Check className={cn(iconClass, "text-muted-foreground/60")} />;
    case "queued":
      return <Clock className={cn(iconClass, "text-warning")} />;
    case "received":
      return <CheckCheck className={cn(iconClass, "text-info")} />;
    case "processing":
      return <Loader2 className={cn(iconClass, "text-accent animate-spin")} />;
    case "done":
      return <CheckCheck className={cn(iconClass, "text-success")} />;
    case "failed":
      return <AlertCircle className={cn(iconClass, "text-destructive")} />;
    default:
      return <Check className={cn(iconClass, "text-muted-foreground/40")} />;
  }
}

function formatTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(normalizeTimestamp(ts) ?? ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getMotionProps(
  animateOnMount: boolean,
  initial: Record<string, number>,
): {
  initial?: Record<string, number> | false;
  animate?: Record<string, number>;
  transition?: { duration: number; ease: typeof EASE_SMOOTH };
} {
  if (!animateOnMount) {
    return { initial: false };
  }
  return {
    initial,
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: { duration: 0.2, ease: EASE_SMOOTH },
  };
}

export function MessageItem({
  message,
  isSelf,
  selfEntityUid,
  paymentState,
  respondedApprovalIds,
  animateOnMount = true,
}: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const metadata = message.payload.metadata;
  const isCarbonCopy = metadata?._carbonCopy === true;
  const display = resolveDisplay(message.kind, message.payload as Record<string, unknown>, isSelf);

  // 获取消息文本（兼容不同 payload 结构）
  const getMessageText = (): string => {
    const payload = message.payload;
    // 直接的 text 字段
    if (typeof payload.text === "string" && payload.text) {
      return payload.text;
    }
    if (typeof payload.message === "string" && payload.message) {
      return payload.message;
    }
    // friend_request 消息有 sender_card
    if (payload.sender_card && typeof payload.sender_card === "object") {
      const senderCard = payload.sender_card as Record<string, unknown>;
      const senderName = (senderCard.name as string) || "Unknown";
      return `${senderName} 发送了好友请求`;
    }
    if (
      typeof message.kind === "string" &&
      (message.kind.startsWith("contract_") || message.kind.startsWith("pay_"))
    ) {
      return summarizePayload(message.kind, payload as Record<string, unknown>);
    }
    return "";
  };

  const messageText = getMessageText();

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current != null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async (): Promise<void> => {
    if (!messageText || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      if (copyResetTimerRef.current != null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore clipboard failures
    }
  };

  // CarbonCopy messages are rendered in the sidebar panel, not inline
  if (isCarbonCopy) return null;
  if (display.mode === "hidden") return null;

  if (display.mode === "system") {
    return (
      <motion.div
        {...(animateOnMount
          ? {
              initial: { opacity: 0, y: 4 },
              animate: { opacity: 1, y: 0 },
              transition: { duration: 0.15, ease: EASE_SMOOTH },
            }
          : { initial: false })}
        className="flex justify-center my-1"
      >
        <span className="rounded-full bg-muted/50 px-3 py-1 text-[11px] text-muted-foreground">
          {display.text}
        </span>
      </motion.div>
    );
  }

  if (display.mode === "card" && selfEntityUid) {
    return (
      <motion.div
        {...getMotionProps(animateOnMount, { opacity: 0, y: 8, scale: 0.98 })}
        className={cn("flex", isSelf ? "justify-end" : "justify-start")}
      >
        <PaymentCard
          message={message}
          selfEntityUid={selfEntityUid}
          state={paymentState ?? "pending"}
          isSelf={isSelf}
        />
      </motion.div>
    );
  }

  if (display.mode === "approval_card" && selfEntityUid) {
    const reqId = (message.payload as Record<string, unknown>)?.request_id as string | undefined;
    const responded = reqId ? respondedApprovalIds?.get(reqId) : undefined;
    return (
      <motion.div
        {...getMotionProps(animateOnMount, { opacity: 0, y: 8, scale: 0.98 })}
        className={cn("flex", isSelf ? "justify-end" : "justify-start")}
      >
        <ApprovalCard
          message={message}
          selfEntityUid={selfEntityUid}
          alreadyRespondedAction={responded?.action}
          alreadyRespondedInputData={responded?.inputData}
        />
      </motion.div>
    );
  }

  // Normal message rendering
  return (
    <motion.div
      {...getMotionProps(animateOnMount, { opacity: 0, y: 8, scale: 0.98 })}
      className={cn("flex", isSelf ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[75%] rounded-md border-2 px-4 py-2.5 text-sm leading-relaxed shadow-[0_3px_0_rgba(0,0,0,0.28)]",
          isSelf
            ? "border-primary/70 bg-sender-bubble text-primary-foreground"
            : "border-border bg-card text-card-foreground",
        )}
      >
        {/* Text */}
        <MarkdownContent content={messageText} className="space-y-1.5" />

        {/* Footer: time + status */}
        <div
          className={cn(
            "flex items-center gap-1.5 mt-1.5",
            isSelf ? "justify-end" : "justify-start",
          )}
        >
          <CopyMessageButton
            copied={copied}
            disabled={!messageText}
            isSelf={isSelf}
            onCopy={handleCopy}
          />
          <span className={cn(
            "text-[10px]",
            isSelf ? "text-primary-foreground/50" : "text-muted-foreground/50",
          )}>
            {formatTime(message.timestamp)}
          </span>
          {isSelf && <StatusIcon status={message.status} />}
        </div>

        {/* Token usage (for AI responses) */}
        {!isSelf && message.payload.metadata?.usage != null && (
          <div className="mt-2 pt-1.5 border-t border-border/50">
            <span className="text-[10px] font-mono text-muted-foreground/40">
              tokens:{" "}
              {(message.payload.metadata.usage as Record<string, number>)
                .input_tokens ?? 0}
              {" / "}
              {(message.payload.metadata.usage as Record<string, number>)
                .output_tokens ?? 0}
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ── CarbonCopy item — chat bubble layout ── */

interface CarbonCopyItemProps {
  cc: CarbonCopyMessage;
  contactUid: string;
}

function summarizePayload(kind: string, p: Record<string, unknown>): string {
  const cid = typeof p.contract_id === "string" ? p.contract_id.slice(0, 12) : "";
  const pid = typeof p.payment_id === "string" ? p.payment_id.slice(0, 12) : "";
  switch (kind) {
    case "contract_create": return `Contract created: ${p.title ?? cid}`;
    case "contract_amend": return `Contract amended: ${cid}`;
    case "contract_approve": return `Contract approved: ${cid}`;
    case "contract_reject": return `Contract rejected: ${cid}`;
    case "contract_complete": return `Delivery completed: ${cid}`;
    case "contract_accept": return `Delivery accepted: ${cid}`;
    case "contract_rework": return `Rework requested: ${cid}`;
    case "contract_rate": return `Rated ${p.rating ?? "?"}/5: ${cid}`;
    case "contract_cancel": return `Contract cancelled: ${cid}`;
    case "contract_dispute": return `Dispute raised: ${cid}`;
    case "contract_status": return `Status → ${p.status ?? "?"}: ${cid}`;
    case "contract_status_ack": return `Status acknowledged: ${cid}`;
    case "contract_timeout": return `Contract timed out: ${cid}`;
    case "pay_collect": return `Payment collected: $${p.amount ?? "?"}`;
    case "pay_request": return `Payment requested: $${p.amount ?? "?"}`;
    case "pay_approve": return `Payment approved: ${pid}`;
    case "pay_reject": return `Payment rejected: ${pid}`;
    case "pay_confirm_receipt": return `Receipt confirmed: ${pid}`;
    case "pay_claim_completed": return `Payment claimed: ${pid}`;
    case "pay_completed": return `Payment completed: ${pid}`;
    case "pay_failed": return `Payment failed: ${pid}`;
    case "pay_timeout": return `Payment timed out: ${pid}`;
    default: return kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}

export function CarbonCopyItem({ cc, contactUid }: CarbonCopyItemProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const senderUid = extractEntityUid(cc.originalSender);
  const isSelf = senderUid === contactUid;
  const senderDisplay = cc.originalSenderName || senderUid;
  const text = cc.payload.text
    || (cc.originalPayload ? summarizePayload(cc.messageKind, cc.originalPayload) : "");

  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (!text || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  };

  return (
    <div className={cn("flex", isSelf ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-md border-2 px-3.5 py-2 text-sm leading-relaxed shadow-[0_3px_0_rgba(0,0,0,0.24)]",
          isSelf
            ? "border-primary/70 bg-sender-bubble text-primary-foreground"
            : "border-border bg-card",
        )}
      >
        {/* Sender name */}
        <p className={cn(
          "text-[11px] font-medium mb-1",
          isSelf ? "text-primary-foreground/70" : "text-muted-foreground",
        )}>
          {senderDisplay}
        </p>

        {/* Message text */}
        <MarkdownContent content={text} className="space-y-1 text-xs" />

        {/* Footer: kind, copy, time */}
        <div className={cn(
          "flex items-center gap-1.5 mt-1.5 flex-wrap",
          isSelf ? "justify-end" : "justify-start",
        )}>
          {cc.messageKind && (
            <span className={cn(
              "text-[10px] px-1.5 py-0.5 rounded shrink-0",
              isSelf
                ? "bg-white/10 text-primary-foreground/60"
                : "bg-surface text-muted-foreground/60",
            )}>
              {cc.messageKind}
            </span>
          )}
          <CopyMessageButton copied={copied} disabled={!text} isSelf={isSelf} onCopy={handleCopy} />
          <span className={cn(
            "text-[10px]",
            isSelf ? "text-primary-foreground/50" : "text-muted-foreground/50",
          )}>
            {formatTime(cc.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}
