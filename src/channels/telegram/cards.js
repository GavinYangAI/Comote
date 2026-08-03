// src/channels/telegram/cards.js
// Pure Telegram helpers: compact callback_data codec (Telegram caps callback_data
// at 64 bytes, so we use short opcodes — the chat id + from come on the callback_query
// itself, so only the action-specific ref needs encoding), inline keyboards, status
// card text, and pairing-code generation. Config-free, no I/O.
import { randomInt } from "node:crypto";
import { t } from "../../core/i18n/index.js";
import { chunkTextByLines } from "../base/chunk.js";

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
  { command: "automode", description: "Toggle Approve for me" },
  { command: "model", description: "Choose model and reasoning" },
  { command: "cancel", description: "Cancel the current task" },
  { command: "file", description: "Send a project file here" },
  { command: "help", description: "Show all commands" },
];

const PICK_KIND_CODE = { project: "p", session: "s", model: "m", reasoning: "r" };
const PICK_KIND_NAME = { p: "project", s: "session", m: "model", r: "reasoning" };

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
    case "approve_session": return `as:${code}`;
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
  if (op === "as") return { action: "approve_session", code: rest };
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
    inline_keyboard: [
      [
        { text: t("card.approval.approve"), callback_data: encodeCallback({ action: "approve", code }) },
        { text: t("card.approval.acceptForSession"), callback_data: encodeCallback({ action: "approve_session", code }) },
      ],
      [{ text: t("card.approval.reject"), callback_data: encodeCallback({ action: "reject", code }) }],
    ],
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

export function statusText({ phase, steps = 0, text = "", activities = [], content = [], model = null, reasoningEffort = undefined }) {
  const title = t(PHASE_TITLE[phase] ?? PHASE_TITLE.progress);
  const stepLine = steps > 0 ? t("card.steps.running", { steps }) : t("card.steps.starting");
  const settings = modelSettingsLine(model, reasoningEffort);
  const orderedContent = statusContent(content, text, activities);
  const toolLength = orderedContent
    .filter((block) => block.type === "activities")
    .flatMap((block) => block.activities)
    .map(formatActivityText)
    .join("\n").length;
  // Clamp the body so the assembled card stays under Telegram's 4096-char ceiling;
  // a too-long editMessageText would 400 and strand the card mid-progress.
  const blocks = clampContentText(orderedContent, Math.max(500, STATUS_BODY_LIMIT - toolLength))
    .map(formatContentText)
    .filter(Boolean);
  return [title, stepLine, settings, ...blocks].filter(Boolean).join("\n\n");
}

// Telegram supports expandable blockquotes in HTML messages. Keep the normal
// answer visible and place tool activity in a collapsed block so live updates
// stay readable without losing operational detail.
export function statusHtml({ phase, steps = 0, text = "", activities = [], content = [], model = null, reasoningEffort = undefined }) {
  const title = escapeHtml(t(PHASE_TITLE[phase] ?? PHASE_TITLE.progress));
  const stepLine = escapeHtml(steps > 0 ? t("card.steps.running", { steps }) : t("card.steps.starting"));
  const settings = modelSettingsLine(model, reasoningEffort);
  const escapedSettings = settings ? escapeHtml(settings) : null;
  const orderedContent = statusContent(content, text, activities);
  const toolLength = orderedContent
    .filter((block) => block.type === "activities")
    .flatMap((block) => block.activities)
    .map(formatActivityText)
    .join("\n").length;
  const blocks = clampContentText(orderedContent, Math.max(500, STATUS_BODY_LIMIT - toolLength))
    .map(formatContentHtml)
    .filter(Boolean);
  return [title, stepLine, escapedSettings, ...blocks].filter(Boolean).join("\n\n");
}

function modelSettingsLine(model, reasoningEffort) {
  if (!model && reasoningEffort === undefined) {
    return null;
  }
  return t("card.model.settings", {
    model: model ?? t("card.model.unknown"),
    reasoningEffort: reasoningEffort ?? t("card.model.defaultReasoning"),
  });
}

function statusContent(content, text, activities) {
  if (content.length > 0) return content;
  return [
    ...(activities.length > 0 ? [{ type: "activities", activities }] : []),
    ...(text ? [{ type: "text", text: String(text) }] : []),
  ];
}

function formatContentText(block) {
  if (block.type === "text") return block.text;
  const items = block.activities.map(formatActivityText).join("\n");
  return items ? `${t("card.tools.title", { count: block.activities.length })}\n${items}` : "";
}

function formatContentHtml(block) {
  if (block.type === "text") return markdownToTelegramHtml(block.text);
  if (block.activities.length === 0) return "";
  return `<blockquote expandable><b>${escapeHtml(t("card.tools.title", { count: block.activities.length }))}</b>\n${block.activities.map(formatActivityHtml).join("\n")}</blockquote>`;
}

function clampContentText(content, limit) {
  const total = content.reduce(
    (sum, block) => sum + (block.type === "text" ? String(block.text ?? "").length : 0),
    0,
  );
  if (total <= limit) return content;

  const marker = t("state.chunk.truncated");
  let remove = total - limit + marker.length + 1;
  let marked = false;
  return content
    .map((block) => {
      if (block.type !== "text" || remove <= 0) return block;
      const value = String(block.text ?? "");
      if (value.length <= remove) {
        remove -= value.length;
        return { ...block, text: "" };
      }
      const text = `${marker}\n${value.slice(remove)}`;
      remove = 0;
      marked = true;
      return { ...block, text };
    })
    .filter((block) => block.type !== "text" || block.text)
    .map((block, index, blocks) => {
      if (marked || block.type !== "text" || index !== blocks.findIndex((entry) => entry.type === "text")) {
        return block;
      }
      marked = true;
      return { ...block, text: `${marker}\n${block.text}` };
    });
}

function activityParts(activity) {
  if (typeof activity === "string") return { label: activity, detail: "" };
  return {
    label: String(activity?.label ?? ""),
    detail: String(activity?.detail ?? "").trim(),
  };
}

function formatActivityText(activity) {
  const { label, detail } = activityParts(activity);
  if (!detail) return `- ${label}`;
  return `- ${label}\n${detail.split("\n").map((line) => `  ${line}`).join("\n")}`;
}

function formatActivityHtml(activity) {
  const { label, detail } = activityParts(activity);
  if (!detail) return `- ${escapeHtml(label)}`;
  return `- <b>${escapeHtml(label)}</b>\n${escapeHtml(detail)}`;
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

// Splits a long reply into Telegram-sized chunks at line boundaries where
// possible. Delegates to the shared code-point-safe chunker: the old regex
// hard-split counted UTF-16 code units and could sever an emoji surrogate
// pair at a chunk boundary. fenceAware keeps code blocks renderable per chunk
// (markdownToTelegramHtml converts each chunk's fences independently).
export function chunkMessage(text, limit = TELEGRAM_MESSAGE_LIMIT) {
  return chunkTextByLines(text, limit, { fenceAware: true });
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
