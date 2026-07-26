// src/channels/telegram/driver.js
// Telegram Bot API driver. All API calls go through an injected fetchImpl so they
// are unit-testable. Inbound is a self-managed getUpdates long-poll loop (push
// model) rather than the base timer poll — startEventStream spawns the loop, which
// advances `offset`, dispatches messages → onEvent and callback_query → onAction.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, basename } from "node:path";

const delay = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export class TelegramDriver {
  constructor({ botToken, fetchImpl = globalThis.fetch, longPollSeconds = 50, backoffMs = 3000, apiBase = "https://api.telegram.org" } = {}) {
    if (!botToken) throw new Error("Telegram botToken is required");
    if (!fetchImpl) throw new Error("fetch implementation is required");
    this.botToken = botToken;
    this.fetch = fetchImpl;
    this.longPollSeconds = longPollSeconds;
    this.backoffMs = backoffMs;
    this.apiBase = apiBase;
    this.offset = 0;
    this.running = false;
    this.lastPollAt = null;
    this._abort = null;
    this._loopPromise = null;
  }

  getStatus() {
    return { state: this.running ? "running" : "configured", driver: "telegram-bot-api", connected: this.running, lastPollAt: this.lastPollAt };
  }

  setOffset(offset) {
    if (typeof offset === "number" && offset > this.offset) this.offset = offset;
  }

  async _call(method, params = {}, { signal } = {}) {
    const res = await this.fetch(`${this.apiBase}/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });
    const body = await res.json();
    if (!body.ok) {
      const err = new Error(`Telegram ${method} failed: ${body.error_code} ${body.description}`);
      err.code = body.error_code;
      throw err;
    }
    return body.result;
  }

  async sendMessage({ chatId, text, parseMode = null, replyMarkup = null }) {
    return this._call("sendMessage", { chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}), ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  async editMessageText({ chatId, messageId, text, parseMode = null, replyMarkup = null }) {
    return this._call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      // An explicit empty keyboard removes the original callback buttons.
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  }

  async setMessageReaction({ chatId, messageId, emoji = null }) {
    return this._call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: "emoji", emoji }] : [],
      is_big: false,
    });
  }

  async answerCallbackQuery({ callbackQueryId, text = null }) {
    return this._call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  async sendChatAction({ chatId, action = "typing" }) {
    return this._call("sendChatAction", { chat_id: chatId, action });
  }

  // Registers the bot's command menu (the "/" button in the Telegram client).
  // commands = [{ command, description }] — names lowercase, no leading slash.
  async setMyCommands(commands) {
    return this._call("setMyCommands", { commands });
  }

  async _sendMultipart(method, chatId, field, localPath, extra = {}, fileName = null) {
    const bytes = await readFile(localPath);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    for (const [k, v] of Object.entries(extra)) if (v != null) form.append(k, String(v));
    form.append(field, new Blob([bytes]), fileName ?? basename(localPath));
    const res = await this.fetch(`${this.apiBase}/bot${this.botToken}/${method}`, { method: "POST", body: form });
    const body = await res.json();
    if (!body.ok) {
      const err = new Error(`Telegram ${method} failed: ${body.error_code} ${body.description}`);
      err.code = body.error_code;
      throw err;
    }
    return body.result;
  }

  async sendPhoto({ chatId, path, caption = null }) {
    return this._sendMultipart("sendPhoto", chatId, "photo", path, { caption });
  }

  async sendDocument({ chatId, path, fileName = null, caption = null }) {
    return this._sendMultipart("sendDocument", chatId, "document", path, { caption }, fileName);
  }

  async getFile(fileId) {
    return this._call("getFile", { file_id: fileId });
  }

  async downloadAttachment({ downloadCode, destPath }) {
    if (!downloadCode) throw new Error("downloadCode is required");
    if (!destPath) throw new Error("destPath is required");
    const file = await this.getFile(downloadCode);
    if (!file?.file_path) throw new Error("Telegram getFile: no file_path");
    const res = await this.fetch(`${this.apiBase}/file/bot${this.botToken}/${file.file_path}`, { method: "GET" });
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, bytes);
    return destPath;
  }

  async startEventStream({ onEvent, onAction = null, onError = null }) {
    if (this.running) return { ok: true };
    this.running = true;
    this._loopPromise = this._loop({ onEvent, onAction, onError });
    return { ok: true };
  }

  async _loop({ onEvent, onAction, onError }) {
    while (this.running) {
      this._abort = new AbortController();
      let updates;
      try {
        updates = await this._call("getUpdates", {
          offset: this.offset,
          timeout: this.longPollSeconds,
          allowed_updates: ["message", "edited_message", "callback_query"],
        }, { signal: this._abort.signal });
        this.lastPollAt = new Date().toISOString();
      } catch (error) {
        if (!this.running) break; // aborted by stopEventStream
        if (error.code === 401) { onError?.(error); this.running = false; break; }
        await delay(this.backoffMs);
        continue;
      }
      for (const update of updates ?? []) {
        if (update.update_id != null) this.offset = update.update_id + 1;
        try {
          if (update.callback_query) await onAction?.(update.callback_query);
          else if (update.message || update.edited_message) await onEvent?.(update);
        } catch {
          // per-update handler error is swallowed here; the runtime logs via its own try/catch
        }
      }
    }
  }

  stopEventStream() {
    this.running = false;
    try { this._abort?.abort(); } catch { /* best effort */ }
    this._abort = null;
  }
}
