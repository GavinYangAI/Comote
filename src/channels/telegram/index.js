// src/channels/telegram/index.js
// Telegram channel plugin: meta (token binding) + factory wrappers. First token
// channel — a single botToken config field. configured = enabled && botToken (gates
// driver creation + auto-start so the runtime can receive the pairing code), while
// boundWhen = linkedChatId (set only after the user sends the pairing code). The
// pairing code + linked chat live in config and persist via channelConfigs.
import { TelegramDriver } from "./driver.js";
import { TelegramChannelAdapter } from "./adapter.js";
import { TelegramRuntimeService } from "./runtime.js";
import { createTelegramRenderer } from "./renderer.js";

function normalizeTelegramConfig(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    botToken: config.botToken ?? null,
    linkedChatId: config.linkedChatId ?? null,
    linkedUserName: config.linkedUserName ?? null,
    pairingCode: config.pairingCode ?? null,
    offset: typeof config.offset === "number" ? config.offset : 0,
  };
}

function normalizeTelegramSecretPatch(config = {}) {
  const patch = { ...config };
  if (patch.botToken === "" || patch.botToken === "********") delete patch.botToken;
  return patch;
}

function publicTelegramConfig(config) {
  return {
    enabled: config.enabled,
    hasBotToken: Boolean(config.botToken),
    configured: Boolean(config.enabled && config.botToken),
    linkedChatId: config.linkedChatId,
    linkedUserName: config.linkedUserName,
    pairingCode: config.pairingCode, // not a secret — shown so the user can send it
  };
}

function createTelegramDriver(config) {
  if (!config.enabled || !config.botToken) return null;
  const driver = new TelegramDriver({ botToken: config.botToken });
  if (typeof config.offset === "number") driver.setOffset(config.offset);
  return driver;
}

const telegramPlugin = {
  meta: {
    id: "telegram",
    displayName: "Telegram",
    inboundMode: "push",
    binding: "token",
    capabilities: { cards: 1, media: 1, liveUpdates: 1, typing: 1, fileButtons: 0 },
    descriptionKey: "web.channel.telegram.desc",
    icon: "TG",
    configFields: [
      { name: "botToken", type: "text", secret: true, labelKey: "web.channel.telegram.botToken" },
    ],
    states: {
      running: { labelKey: "web.channel.state.running", tone: "success" },
      configured: { labelKey: "web.channel.state.configured", tone: "neutral" },
      not_configured: { labelKey: "web.channel.state.notConfigured", tone: "warning" },
      reserved: { labelKey: "web.channel.state.reserved", tone: "warning" },
    },
    statusFlags: [],
    statusRows: [
      { labelKey: "web.channel.row.account", source: "config", field: "linkedUserName", fallback: ["linkedChatId"], fallbackKey: "web.channel.telegram.row.account.unpaired" },
    ],
    boundWhen: { source: "config", field: "linkedChatId" },
    setup: { stepsKey: "web.channel.telegram.setup.steps", link: { url: "https://t.me/BotFather", labelKey: "web.channel.telegram.setup.link" } },
  },
  normalizeConfig: (raw) => normalizeTelegramConfig(raw),
  normalizeSecretPatch: (raw) => normalizeTelegramSecretPatch(raw),
  publicConfig: (config) => publicTelegramConfig(config),
  createDriver: (config) => createTelegramDriver(config),
  createRenderer: () => createTelegramRenderer(),
  createAdapter: (opts) => new TelegramChannelAdapter(opts),
  createRuntime: (opts) => new TelegramRuntimeService(opts),
};

export default telegramPlugin;
