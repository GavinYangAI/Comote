// WeChat (iLink) channel plugin: meta block + factory wrappers around the
// existing driver/adapter/runtime/renderer constructors and config helpers.
// The config/driver helpers below are copied VERBATIM from src/server/state.js
// (B3 will rewire state.js onto these and delete its copies). WeChat is
// poll-mode and text-only; login lives on the runtime (startLogin/getLoginStatus),
// so there is no createLoginDriver and no normalizeSecretPatch (unlike feishu).
import { WeChatIlinkDriver } from "./ilink-driver.js";
import { WeChatChannelAdapter } from "./adapter.js";
import { WeChatRuntimeService } from "./runtime.js";
import { createWeChatRenderer } from "./renderer.js";

function normalizeWeChatConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    baseUrl: config.baseUrl ?? null,
    token: config.token ?? null,
    accountId: config.accountId ?? "default",
    linkedUserId: config.linkedUserId ?? null,
    linkedUserName: config.linkedUserName ?? null,
  };
}

function publicWeChatConfig(config) {
  return {
    enabled: config.enabled,
    accountId: config.accountId,
    linkedUserId: config.linkedUserId,
    linkedUserName: config.linkedUserName,
    loggedIn: Boolean(config.token),
  };
}

function shouldStoreWeChatLoginResult(result) {
  const state = result.state?.toString?.().toLowerCase?.() ?? "";
  if (["expired", "cancelled", "canceled", "failed", "error"].includes(state)) {
    return false;
  }
  return Boolean(result.token && result.accountId);
}

function createWeChatDriver(config) {
  if (!config.enabled) {
    return null;
  }
  return new WeChatIlinkDriver({
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    token: config.token,
    accountId: config.accountId,
  });
}

const wechatPlugin = {
  meta: {
    id: "wechat",
    displayName: "微信 / WeChat",
    inboundMode: "poll",
    binding: "qr",
    capabilities: { cards: 0, media: 0, liveUpdates: 0, typing: 1 },
    configFields: [],
  },
  normalizeConfig: (raw) => normalizeWeChatConfig(raw),
  publicConfig: (config) => publicWeChatConfig(config),
  createDriver: (config) => createWeChatDriver(config),
  shouldStoreLoginResult: (result) => shouldStoreWeChatLoginResult(result),
  createRenderer: () => createWeChatRenderer(),
  createAdapter: (opts) => new WeChatChannelAdapter(opts),
  createRuntime: (opts) => new WeChatRuntimeService(opts),
};

export default wechatPlugin;
