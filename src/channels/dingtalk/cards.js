// Pure DingTalk card data builders. DingTalk interactive cards are "template id +
// flat string→string cardParamMap" (NOT inline JSON like Feishu). These helpers
// shape the semantic fields into the named slots a console-built template fills,
// plus the button `params` a click echoes back over TOPIC_CARD. The template id
// itself is injected by the renderer from config; this module stays config-free.
import { t } from "../../core/i18n/index.js";

// cardParamMap key the picker template's loop container is bound to.
export const PICKER_OPTIONS_KEY = "options";

const PHASE_TITLE = {
  started: "card.phase.started",
  progress: "card.phase.progress",
  streaming: "card.phase.streaming",
  completed: "card.phase.completed",
  error: "card.phase.error",
  cancelled: "card.phase.cancelled",
};

// Flatten a record into the string→string cardParamMap DingTalk requires.
// Objects/arrays are JSON-stringified; null/undefined become "" (never "null").
export function toParamMap(record) {
  const out = {};
  for (const [k, v] of Object.entries(record ?? {})) {
    if (v == null) {
      out[k] = "";
    } else if (typeof v === "string") {
      out[k] = v;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

export function approvalCardData({ shortCode, detail }) {
  return {
    title: t("card.approval.title", { code: shortCode }),
    detail: String(detail ?? t("card.approval.detailFallback")),
    approveLabel: t("card.approval.approve"),
    sessionLabel: t("card.approval.acceptForSession"),
    rejectLabel: t("card.approval.reject"),
    approveParams: { action: "approve", code: shortCode },
    sessionParams: { action: "approve_session", code: shortCode },
    rejectParams: { action: "reject", code: shortCode },
  };
}

export function approvalResolvedCardData({ code, decision }) {
  const accepted = decision === "accept" || decision === "acceptForSession";
  const title = accepted ? t("card.approval.accepted", { code }) : t("card.approval.rejected", { code });
  return {
    title,
    body: accepted ? t("card.approval.acceptedBody") : t("card.approval.rejectedBody"),
    accepted,
    done: true,
    statusLabel: title,
    statusType: accepted ? "primary" : "danger",
    statusParams: null,
    approveLabel: accepted ? title : "",
    sessionLabel: "",
    rejectLabel: accepted ? "" : title,
    approveParams: null,
    sessionParams: null,
    rejectParams: null,
  };
}

export function approvalResolvedParamMap({ code, decision }) {
  return toParamMap(approvalResolvedCardData({ code, decision }));
}

// Builds the picker template data. The loop container is bound to a JSON-stringified
// array under PICKER_OPTIONS_KEY; each option carries the click `params`.
export function pickerCardData({ pickKind, title, text = "", items = [], conversationId }) {
  const options = items.slice(0, 20).map((item) => ({
    index: String(item.index),
    label: truncate(item.label, 40),
    params: { action: "pick", pickKind, index: String(item.index), conv: conversationId },
  }));
  return {
    title: title ?? t(pickKind === "project" ? "card.picker.project" : "card.picker.conversation"),
    text: String(text ?? ""),
    [PICKER_OPTIONS_KEY]: JSON.stringify(options),
  };
}

// Raw status fields (renderer turns these into a cardParamMap). Part B uses this
// for the live thread card; Part A ships it so the renderer's buildStatusCard exists.
export function statusCardData({ phase, threadId = null, steps = 0, text = "", done = false, activities = [] }) {
  const titleKey = PHASE_TITLE[phase] ?? PHASE_TITLE.progress;
  const tools = activities.length > 0
    ? `**${t("card.tools.title", { count: activities.length })}**\n${activities.map((item) => `- ${item}`).join("\n")}`
    : "";
  return {
    title: t(titleKey),
    body: [tools, String(text ?? "")].filter(Boolean).join("\n\n"),
    steps: steps > 0 ? t("card.steps.running", { steps }) : t("card.steps.starting"),
    threadId: threadId ?? "",
    done,
    cancelLabel: t("card.cancelButton"),
    cancelParams: threadId && !done ? { action: "cancel", threadId } : null,
  };
}

function truncate(value, max) {
  const str = String(value ?? "");
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
