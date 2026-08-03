// Channel-neutral approval/diff text formatting, shared by renderers.
// Moved verbatim out of server/state.js so renderers can degrade an approval
// semantic reply to text (wechat) or a card body (feishu) without duplicating.
import { t } from "../../core/i18n/index.js";

export function describeApprovalForChat(approval, { autoApproved = false } = {}) {
  const lines = [t("state.approval.title", { code: approval.shortCode })];
  lines.push(approvalSummaryForChat(approval));
  lines.push(
    autoApproved
      ? t("state.approval.autoApproved")
      : t("state.approval.instructions", { code: approval.shortCode }),
  );
  return lines.join("\n\n");
}

export function describeResolvedApprovalForChat(approval, { code, decision } = {}) {
  const accepted = decision === "accept" || decision === "acceptForSession";
  const title = accepted
    ? t("card.approval.accepted", { code })
    : t("card.approval.rejected", { code });
  return approval ? `${title}\n\n${approvalSummaryForChat(approval)}` : title;
}

// Markdown body for a Feishu approval card — reuses the diff/command summary.
export function approvalDetail(approval) {
  const params = approval.params ?? {};
  if (Array.isArray(approval.changes) && approval.changes.length > 0) {
    return summarizeChanges(approval.changes);
  }
  const detail = params.command ?? params.reason ?? approval.method;
  const cwd = params.cwd ? "\n\n" + t("state.approval.cwdMarkdown", { cwd: params.cwd }) : "";
  return `\`${detail}\`${cwd}`;
}

function approvalSummaryForChat(approval) {
  const params = approval?.params ?? {};
  if (Array.isArray(approval?.changes) && approval.changes.length > 0) {
    return summarizeChanges(approval.changes);
  }
  const detail = params.command ?? params.reason ?? approval?.method ?? t("card.approval.detailFallback");
  const cwd = params.cwd ? "\n" + t("state.approval.cwd", { cwd: params.cwd }) : "";
  return `${detail}${cwd}`;
}

export function summarizeChanges(changes) {
  const rows = changes.slice(0, 10).map((change) => {
    const kind =
      change.kind?.type === "add"
        ? t("state.changes.kind.add")
        : change.kind?.type === "delete"
          ? t("state.changes.kind.delete")
          : t("state.changes.kind.modify");
    const { added, removed } = countDiffLines(change.diff);
    const stat = added || removed ? ` (+${added} -${removed})` : "";
    return `  ${kind} ${change.path}${stat}`;
  });
  if (changes.length > 10) {
    rows.push("  " + t("state.changes.more", { count: changes.length - 10 }));
  }
  return [t("state.changes.summary", { count: changes.length }), ...rows].join("\n");
}

export function countDiffLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}
