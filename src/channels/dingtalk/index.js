// src/channels/dingtalk/index.js
// DingTalk channel plugin: meta (credentials binding) + factory wrappers around
// the driver/adapter/runtime/renderer. First credentials channel — configFields
// declare AppKey/AppSecret + the three console-built card template ids the
// renderer fills. Template ids are optional: absent → renderer degrades to text.
import { DingTalkDriver } from "./driver.js";
import { DingTalkChannelAdapter } from "./adapter.js";
import { DingTalkRuntimeService } from "./runtime.js";
import { createDingTalkRenderer } from "./renderer.js";

function normalizeDingTalkConfig(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    appKey: config.appKey ?? null,
    appSecret: config.appSecret ?? null,
    approvalTemplateId: config.approvalTemplateId ?? null,
    statusTemplateId: config.statusTemplateId ?? null,
    pickerTemplateId: config.pickerTemplateId ?? null,
    linkedUserId: config.linkedUserId ?? null,
    linkedUserName: config.linkedUserName ?? null,
  };
}

function normalizeDingTalkSecretPatch(config = {}) {
  const patch = { ...config };
  if (patch.appSecret === "" || patch.appSecret === "********") delete patch.appSecret;
  return patch;
}

function publicDingTalkConfig(config) {
  return {
    enabled: config.enabled,
    appKey: config.appKey,
    hasAppSecret: Boolean(config.appSecret),
    approvalTemplateId: config.approvalTemplateId,
    statusTemplateId: config.statusTemplateId,
    pickerTemplateId: config.pickerTemplateId,
    configured: Boolean(config.enabled && config.appKey && config.appSecret),
    linkedUserId: config.linkedUserId,
    linkedUserName: config.linkedUserName,
  };
}

function templatesFromConfig(config) {
  return {
    approval: config.approvalTemplateId ?? null,
    status: config.statusTemplateId ?? null,
    picker: config.pickerTemplateId ?? null,
  };
}

function createDingTalkDriver(config) {
  if (!config.enabled || !config.appKey || !config.appSecret) return null;
  return new DingTalkDriver({ appKey: config.appKey, appSecret: config.appSecret });
}

const dingtalkPlugin = {
  meta: {
    id: "dingtalk",
    displayName: "钉钉 / DingTalk",
    inboundMode: "push",
    binding: "credentials",
    capabilities: { cards: 1, media: 1, liveUpdates: 1, milestones: 0, typing: 0, fileButtons: 0, reactions: 0 },
    descriptionKey: "web.channel.dingtalk.desc",
    icon: "钉",
    configFields: [
      { name: "appKey", type: "text", labelKey: "web.channel.dingtalk.appKey" },
      { name: "appSecret", type: "text", secret: true, labelKey: "web.channel.dingtalk.appSecret" },
      { name: "approvalTemplateId", type: "text", labelKey: "web.channel.dingtalk.approvalTemplateId" },
      { name: "statusTemplateId", type: "text", labelKey: "web.channel.dingtalk.statusTemplateId" },
      { name: "pickerTemplateId", type: "text", labelKey: "web.channel.dingtalk.pickerTemplateId" },
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
      { labelKey: "web.channel.dingtalk.row.app", source: "config", field: "appKey", fallbackKey: "web.channel.dingtalk.row.app.unset" },
    ],
    boundWhen: { source: "config", field: "configured" },
    setup: { stepsKey: "web.channel.dingtalk.setup.steps", link: { url: "https://open-dev.dingtalk.com", labelKey: "web.channel.dingtalk.setup.link" } },
  },
  normalizeConfig: (raw) => normalizeDingTalkConfig(raw),
  normalizeSecretPatch: (raw) => normalizeDingTalkSecretPatch(raw),
  publicConfig: (config) => publicDingTalkConfig(config),
  createDriver: (config) => createDingTalkDriver(config),
  createRenderer: (config = {}) => createDingTalkRenderer({ templates: templatesFromConfig(config) }),
  createAdapter: (opts) => new DingTalkChannelAdapter(opts),
  createRuntime: (opts) => new DingTalkRuntimeService(opts),
};

export default dingtalkPlugin;
