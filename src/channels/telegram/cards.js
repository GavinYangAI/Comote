// src/channels/telegram/cards.js
// Pure Telegram helpers: compact callback_data codec (Telegram caps callback_data
// at 64 bytes, so we use short opcodes — the chat id + from come on the callback_query
// itself, so only the action-specific ref needs encoding), inline keyboards, status
// card text, and pairing-code generation. Config-free, no I/O.
import { t } from "../../core/i18n/index.js";

const PICK_KIND_CODE = { project: "p", session: "s" };
const PICK_KIND_NAME = { p: "project", s: "session" };

const PHASE_TITLE = {
  started: "card.phase.started",
  progress: "card.phase.progress",
  streaming: "card.phase.streaming",
  completed: "card.phase.completed",
  error: "card.phase.error",
  cancelled: "card.phase.cancelled",
};

// action → compact callback_data string.
export function encodeCallback({ action, code, pickKind, index, threadId }) {
  switch (action) {
    case "approve": return `ap:${code}`;
    case "reject": return `rj:${code}`;
    case "pick": return `pk:${PICK_KIND_CODE[pickKind] ?? "s"}:${index}`;
    case "cancel": return `ck:${threadId}`;
    default: throw new Error(`unknown callback action: ${action}`);
  }
}

// callback_data string → action object, or null if unrecognized.
export function decodeCallback(data) {
  if (typeof data !== "string") return null;
  const firstColon = data.indexOf(":");
  if (firstColon === -1) return null;
  const op = data.slice(0, firstColon);
  const rest = data.slice(firstColon + 1);
  if (op === "ap") return { action: "approve", code: rest };
  if (op === "rj") return { action: "reject", code: rest };
  if (op === "ck") return { action: "cancel", threadId: rest };
  if (op === "pk") {
    const sep = rest.indexOf(":");
    if (sep === -1) return null;
    return { action: "pick", pickKind: PICK_KIND_NAME[rest.slice(0, sep)] ?? "session", index: rest.slice(sep + 1) };
  }
  return null;
}

export function approvalKeyboard(code) {
  return {
    inline_keyboard: [[
      { text: t("card.approval.approve"), callback_data: encodeCallback({ action: "approve", code }) },
      { text: t("card.approval.reject"), callback_data: encodeCallback({ action: "reject", code }) },
    ]],
  };
}

export function pickerKeyboard(pickKind, items = []) {
  return {
    inline_keyboard: items.slice(0, 20).map((it) => [{
      text: truncate(`${it.index}. ${it.label}`, 60),
      callback_data: encodeCallback({ action: "pick", pickKind, index: String(it.index) }),
    }]),
  };
}

export function cancelKeyboard(threadId) {
  return { inline_keyboard: [[{ text: t("card.cancelButton"), callback_data: encodeCallback({ action: "cancel", threadId }) }]] };
}

export function statusText({ phase, steps = 0, text = "" }) {
  const title = t(PHASE_TITLE[phase] ?? PHASE_TITLE.progress);
  const stepLine = steps > 0 ? t("card.steps.running", { steps }) : t("card.steps.starting");
  return [title, stepLine, String(text ?? "")].filter(Boolean).join("\n\n");
}

// 6 chars from a no-look-alike alphabet (no 0/O/1/I). rng() ∈ [0,1) injectable.
const PAIR_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function generatePairingCode(rng = Math.random) {
  let out = "";
  for (let i = 0; i < 6; i++) out += PAIR_ALPHABET[Math.floor(rng() * PAIR_ALPHABET.length)];
  return out;
}

function truncate(value, max) {
  const str = String(value ?? "");
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
