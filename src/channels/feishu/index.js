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
    capabilities: { cards: 1, media: 1, liveUpdates: 1, typing: 0 },
    configFields: [],
  },
  normalizeConfig: (raw) => normalizeFeishuConfig(raw),
  normalizeSecretPatch: (raw) => normalizeFeishuSecretPatch(raw),
  publicConfig: (config) => publicFeishuConfig(config),
  createDriver: (config) => createFeishuDriver(config),
  createLoginDriver: ({ domain } = {}) => createFeishuLoginDriver({ domain }),
  shouldStoreLoginResult: (result) => shouldStoreFeishuLoginResult(result),
  createRenderer: () => createFeishuRenderer(),
  createAdapter: (opts) => new FeishuChannelAdapter(opts),
  createRuntime: (opts) => new FeishuRuntimeService(opts),
};

export default feishuPlugin;
