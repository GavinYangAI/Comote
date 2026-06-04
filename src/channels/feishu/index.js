// Feishu / Lark channel plugin: meta block + factory wrappers around the
// existing driver/adapter/runtime/renderer constructors and config helpers.
// The six config/driver helpers below are copied VERBATIM from src/server/state.js
// (B3 will rewire state.js onto these and delete its copies).
import { FeishuDriver } from "./driver.js";
import { FeishuChannelAdapter } from "./adapter.js";
import { FeishuRuntimeService } from "./runtime.js";
import { createFeishuRenderer } from "./renderer.js";

function normalizeFeishuConfig(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    appId: config.appId ?? null,
    appSecret: config.appSecret ?? null,
    verificationToken: config.verificationToken ?? null,
    encryptKey: config.encryptKey ?? null,
    baseUrl: config.baseUrl ?? null,
    domain: config.domain ?? "feishu",
    linkedUserId: config.linkedUserId ?? null,
    linkedUserName: config.linkedUserName ?? null,
  };
}

function normalizeFeishuSecretPatch(config = {}) {
  const patch = { ...config };
  if (patch.appSecret === "" || patch.appSecret === "********") {
    delete patch.appSecret;
  }
  if (patch.verificationToken === "" || patch.verificationToken === "********") {
    delete patch.verificationToken;
  }
  if (patch.encryptKey === "" || patch.encryptKey === "********") {
    delete patch.encryptKey;
  }
  return patch;
}

function publicFeishuConfig(config) {
  return {
    enabled: config.enabled,
    appId: config.appId,
    hasAppSecret: Boolean(config.appSecret),
    hasVerificationToken: Boolean(config.verificationToken),
    hasEncryptKey: Boolean(config.encryptKey),
    configured: Boolean(config.enabled && config.appId && config.appSecret),
    domain: config.domain,
    linkedUserId: config.linkedUserId,
    linkedUserName: config.linkedUserName,
  };
}

function createFeishuDriver(config) {
  if (!config.enabled || !config.appId || !config.appSecret) {
    return null;
  }
  return new FeishuDriver({
    appId: config.appId,
    appSecret: config.appSecret,
    verificationToken: config.verificationToken,
    encryptKey: config.encryptKey,
    domain: config.domain,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });
}

function createFeishuLoginDriver({ domain = "feishu" } = {}) {
  return new FeishuDriver({
    appId: "comote-registration",
    appSecret: "comote-registration",
    domain,
  });
}

function shouldStoreFeishuLoginResult(result) {
  return Boolean(result?.appId && result?.appSecret);
}

const feishuPlugin = {
  meta: {
    id: "feishu",
    displayName: "飞书 / Lark",
    inboundMode: "push",
    binding: "qr",
    capabilities: { cards: 1, media: 1, liveUpdates: 1, typing: 0, fileButtons: 1 },
    descriptionKey: "web.channel.feishu.desc",
    icon: "飞",
    configFields: [
      {
        name: "domain",
        type: "select",
        labelKey: "web.channel.feishu.domainLabel",
        default: "feishu",
        options: [
          { value: "feishu", labelKey: "web.channel.feishu.domainFeishu" },
          { value: "lark", labelKey: "web.channel.feishu.domainLark" },
        ],
      },
    ],
    states: {
      running: { labelKey: "web.channel.state.running", tone: "success" },
      configured: { labelKey: "web.channel.state.configured", tone: "neutral" },
      not_configured: { labelKey: "web.channel.state.notConfigured", tone: "warning" },
      reserved: { labelKey: "web.channel.state.reserved", tone: "warning" },
    },
    statusFlags: [],
    statusRows: [
      { labelKey: "web.channel.row.account", source: "config", field: "linkedUserName", fallback: ["linkedUserId"], fallbackKey: "web.channel.row.account.waiting" },
      { labelKey: "web.channel.feishu.row.app", source: "config", field: "appId", fallbackKey: "web.channel.feishu.row.app.unset" },
    ],
    boundWhen: { source: "config", field: "configured" },
    setup: { stepsKey: "web.channel.feishu.setup.steps", link: { url: "https://open.feishu.cn/app", labelKey: "web.channel.feishu.setup.link" } },
  },
  normalizeConfig: (raw) => normalizeFeishuConfig(raw),
  normalizeSecretPatch: (raw) => normalizeFeishuSecretPatch(raw),
  publicConfig: (config) => publicFeishuConfig(config),
  createDriver: (config) => createFeishuDriver(config),
  createLoginDriver: ({ domain } = {}) => createFeishuLoginDriver({ domain }),
  shouldStoreLoginResult: (result) => shouldStoreFeishuLoginResult(result),
  normalizeLoginStatus: (raw = {}) => {
    const confirmed = raw.state === "confirmed" && Boolean(raw.appId);
    const failed = ["access_denied", "timeout", "error", "cancelled"].includes(raw.state);
    const state = confirmed ? "confirmed"
      : raw.state === "expired" ? "expired"
      : failed ? "failed"
      : raw.state === "scanned" ? "scanned"
      : "pending";
    return {
      state,
      qrUrl: raw.qrUrl ?? null,
      account: confirmed ? { name: raw.userName ?? null, id: raw.appId ?? raw.userId ?? null } : null,
      message: raw.message ?? null,
    };
  },
  createRenderer: () => createFeishuRenderer(),
  createAdapter: (opts) => new FeishuChannelAdapter(opts),
  createRuntime: (opts) => new FeishuRuntimeService(opts),
};

export default feishuPlugin;
