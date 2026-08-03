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
    capabilities: { cards: 0, media: 0, liveUpdates: 0, milestones: 1, typing: 1, fileButtons: 0, reactions: 0 },
    descriptionKey: "web.channel.wechat.desc",
    icon: "微",
    configFields: [
      { name: "enabled", type: "checkbox", labelKey: "web.channel.wechat.enabledLabel", default: true, hidden: true },
      { name: "accountId", type: "text", labelKey: "web.channel.wechat.accountLabel", default: "default", hidden: true },
    ],
    states: {
      running: { labelKey: "web.channel.state.running", tone: "success" },
      configured: { labelKey: "web.channel.state.configured", tone: "neutral" },
      not_configured: { labelKey: "web.channel.state.notConfigured", tone: "warning" },
    },
    statusFlags: [
      { source: "runtime", field: "needsRelogin", tone: "warning", badgeKey: "web.channel.flag.needsRelogin.badge", labelKey: "web.channel.flag.needsRelogin.label" },
    ],
    statusRows: [
      { labelKey: "web.channel.row.account", source: "config", field: "linkedUserName", fallback: ["linkedUserId"], fallbackKey: "web.channel.row.account.waiting" },
      { labelKey: "web.channel.wechat.row.hostApp", source: "status", field: "externalAgentHostRequired", map: { true: "web.channel.wechat.row.hostApp.required", false: "web.channel.wechat.row.hostApp.notRequired" } },
    ],
    boundWhen: { source: "config", field: "loggedIn" },
    setup: { stepsKey: "web.channel.wechat.setup.steps" },
  },
  normalizeConfig: (raw) => normalizeWeChatConfig(raw),
  publicConfig: (config) => publicWeChatConfig(config),
  createDriver: (config) => createWeChatDriver(config),
  shouldStoreLoginResult: (result) => shouldStoreWeChatLoginResult(result),
  normalizeLoginStatus: (raw = {}) => {
    const confirmed = Boolean(raw.token && raw.accountId) || (raw.state === "confirmed" && Boolean(raw.accountId));
    const failed = ["cancelled", "canceled", "failed", "error"].includes(raw.state);
    const state = confirmed ? "confirmed"
      : raw.state === "expired" ? "expired"
      : failed ? "failed"
      : raw.state === "scanned" ? "scanned"
      : "pending";
    return {
      state,
      qrUrl: raw.qrUrl ?? null,
      account: confirmed ? { name: raw.userName ?? null, id: raw.accountId ?? null } : null,
      message: raw.message ?? null,
    };
  },
  createRenderer: () => createWeChatRenderer(),
  createAdapter: (opts) => new WeChatChannelAdapter(opts),
  createRuntime: (opts) => new WeChatRuntimeService(opts),
};

export default wechatPlugin;
