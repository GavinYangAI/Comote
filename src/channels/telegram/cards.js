// src/channels/telegram/cards.js
// Pure Telegram helpers: compact callback_data codec (Telegram caps callback_data
// at 64 bytes, so we use short opcodes — the chat id + from come on the callback_query
// itself, so only the action-specific ref needs encoding), inline keyboards, status
// card text, and pairing-code generation. Config-free, no I/O.
import { randomInt } from "node:crypto";
import { t } from "../../core/i18n/index.js";

// Telegram caps a text message at 4096 chars. Reserve room for a card title +
// step line (and any "(i/n)" chunk prefix) so a split body never overflows once
// those are prepended. Exported so the runtime/renderer share one source of truth.
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const STATUS_BODY_LIMIT = 3500;

// The bot command menu registered via setMyCommands at runtime start. Telegram
// renders ONE global menu (it cannot switch language per user at runtime), so the
// descriptions are plain English — the most universally readable choice.
export const BOT_COMMANDS = [
  { command: "status", description: "Show connection status" },
  { command: "projects", description: "List available projects" },
  { command: "sessions", description: "List conversations" },
  { command: "use", description: "Switch to a conversation" },
  { command: "new", description: "Start a new Codex conversation" },
  { command: "tail", description: "Show recent messages" },
  { command: "approve", description: "Approve a Codex request" },
  { command: "deny", description: "Deny a Codex request" },
  { command: "cancel", description: "Cancel the current task" },
  { command: "file", description: "Send a project file here" },
  { command: "help", description: "Show all commands" },
];

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
export function encodeCallback({ action, code, pickKind, index, threadId, fileIndex }) {
  switch (action) {
    case "approve": return `ap:${code}`;
    case "reject": return `rj:${code}`;
    case "pick": return `pk:${PICK_KIND_CODE[pickKind] ?? "s"}:${index}`;
    case "cancel": return `ck:${threadId}`;
    case "pushfile": return `pf:${threadId}:${fileIndex}`;
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
  if (op === "pf") {
    const sep = rest.indexOf(":");
    if (sep === -1) return null;
    return { action: "pushfile", threadId: rest.slice(0, sep), fileIndex: Number(rest.slice(sep + 1)) };
  }
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

export function filesKeyboard(threadId, files) {
  return {
    inline_keyboard: files.slice(0, 8).map((file, i) => [
      { text: `📎 ${String(file.name || file.path.split(/[/\\]/).pop() || "").slice(0, 36)}`,
        callback_data: encodeCallback({ action: "pushfile", threadId, fileIndex: i }) },
    ]),
  };
}

export function cancelKeyboard(threadId) {
  return { inline_keyboard: [[{ text: t("card.cancelButton"), callback_data: encodeCallback({ action: "cancel", threadId }) }]] };
}

export function statusText({ phase, steps = 0, text = "" }) {
  const title = t(PHASE_TITLE[phase] ?? PHASE_TITLE.progress);
  const stepLine = steps > 0 ? t("card.steps.running", { steps }) : t("card.steps.starting");
  // Clamp the body so the assembled card stays under Telegram's 4096-char ceiling;
  // a too-long editMessageText would 400 and strand the card mid-progress.
  const body = clampStatusBody(String(text ?? ""));
  return [title, stepLine, body].filter(Boolean).join("\n\n");
}

// Trims the status body to STATUS_BODY_LIMIT, keeping the tail (the latest output
// is what matters in a live card) and marking the head as elided.
export function clampStatusBody(text, limit = STATUS_BODY_LIMIT) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  const ellipsis = t("state.chunk.truncated");
  const keep = Math.max(0, limit - ellipsis.length - 1);
  return `${ellipsis}\n${value.slice(value.length - keep)}`;
}

// Splits a long reply into Telegram-sized chunks at line boundaries where possible,
// hard-splitting any single line longer than the limit. Mirrors the WeChat/Feishu
// chunkers so a final answer that overflows editMessageText survives as fresh sends.
export function chunkMessage(text, limit = TELEGRAM_MESSAGE_LIMIT) {
  const value = String(text ?? "");
  if (!value) return [];
  if (value.length <= limit) return [value];
  const chunks = [];
  let current = "";
  for (const rawLine of value.split("\n")) {
    const pieces = rawLine.length > limit ? (rawLine.match(new RegExp(`[\\s\\S]{1,${limit}}`, "g")) ?? [rawLine]) : [rawLine];
    for (const piece of pieces) {
      const candidate = current ? `${current}\n${piece}` : piece;
      if (current && candidate.length > limit) {
        chunks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// HTML-escapes the three characters Telegram's HTML parse mode treats specially.
export function escapeHtml(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Best-effort markdown → Telegram HTML. Deliberately tiny: only the three
// constructs Codex output actually uses heavily — ```fences``` → <pre>,
// `inline code` → <code>, **bold** → <b>. Everything else is escaped verbatim.
// Content is escaped BEFORE the tags are inserted, so user text can never smuggle
// markup in. An unclosed trailing fence is closed. The caller MUST still be
// prepared for Telegram to reject the entities (it falls back to plain text) —
// formatting must never cost a message.
export function markdownToTelegramHtml(text) {
  const value = String(text ?? "");
  const out = [];
  let fenceBuf = null; // null = outside a fence, array = inside (collecting lines)
  for (const line of value.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (fenceBuf === null) {
        fenceBuf = [];
      } else {
        out.push(`<pre>${escapeHtml(fenceBuf.join("\n"))}</pre>`);
        fenceBuf = null;
      }
      continue;
    }
    if (fenceBuf !== null) {
      fenceBuf.push(line);
      continue;
    }
    out.push(inlineMarkdownToHtml(line));
  }
  if (fenceBuf !== null) {
    out.push(`<pre>${escapeHtml(fenceBuf.join("\n"))}</pre>`);
  }
  return out.join("\n");
}

// Inline pass for a single non-fence line: escape first (so the inserted tags are
// the only markup), then `code` before **bold** so a backtick span wins.
function inlineMarkdownToHtml(line) {
  let s = escapeHtml(line);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n](?:[^\n]*?[^*\n])?)\*\*/g, "<b>$1</b>");
  return s;
}

// 8 chars from a no-look-alike alphabet (no 0/O/1/I). The pairing code is a shared
// secret an unpaired sender must reproduce, so it draws from a CSPRNG by default.
// randomIndex(max) → integer in [0, max) is injectable for deterministic tests;
// it defaults to crypto.randomInt (rejection-sampled, unbiased).
const PAIR_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function generatePairingCode(randomIndex = (max) => randomInt(max)) {
  let out = "";
  for (let i = 0; i < 8; i++) out += PAIR_ALPHABET[randomIndex(PAIR_ALPHABET.length)];
  return out;
}

function truncate(value, max) {
  const str = String(value ?? "");
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
