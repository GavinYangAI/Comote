import test from "node:test";
import assert from "node:assert/strict";
import {
  channelBadge, channelRows, channelFormSpec,
  channelBoundButton, normalizedLoginView, restingLoginView, readinessFromChannels,
  isConnected, partitionChannels, channelSummaryLine, bindingAffordance, channelSetup,
} from "../public/channel-view.js";

const t = (k) => k; // echo key

const feishu = {
  id: "feishu", displayName: "飞书 / Lark", binding: "qr", icon: "飞",
  descriptionKey: "web.channel.feishu.desc",
  states: { running: { labelKey: "S.running", tone: "success" }, not_configured: { labelKey: "S.nc", tone: "warning" } },
  statusFlags: [],
  statusRows: [{ labelKey: "R.account", source: "config", field: "linkedUserName", fallback: ["linkedUserId"], fallbackKey: "R.account.waiting" }],
  configFields: [{ name: "domain", type: "select", labelKey: "F.domain", default: "feishu", options: [{ value: "feishu", labelKey: "O.feishu" }, { value: "lark", labelKey: "O.lark" }] }],
  boundWhen: { source: "config", field: "configured" },
  status: { state: "adapter_ready" }, runtime: { state: "running" }, config: { configured: true, linkedUserName: "Alice", domain: "lark" },
};
const wechat = {
  id: "wechat", displayName: "微信", binding: "qr", icon: "微",
  states: { running: { labelKey: "S.running", tone: "success" }, configured: { labelKey: "S.cfg", tone: "neutral" } },
  statusFlags: [{ source: "runtime", field: "needsRelogin", tone: "warning", badgeKey: "B.relogin", labelKey: "L.relogin" }],
  statusRows: [{ labelKey: "R.host", source: "status", field: "externalAgentHostRequired", map: { true: "H.req", false: "H.no" } }],
  configFields: [{ name: "enabled", type: "checkbox", labelKey: "F.enabled", default: true }, { name: "accountId", type: "text", labelKey: "F.acc", default: "default", hidden: true }],
  boundWhen: { source: "config", field: "loggedIn" },
  status: { externalAgentHostRequired: false }, runtime: { state: "configured", needsRelogin: true }, config: { loggedIn: false },
};

test("channelBadge uses states[runtime.state] tone+label", () => {
  assert.deepEqual(channelBadge(feishu, t), { text: "S.running", tone: "success" });
});
test("channelBadge: statusFlag overrides state (wechat needsRelogin)", () => {
  assert.deepEqual(channelBadge(wechat, t), { text: "B.relogin", tone: "warning" });
});
test("channelRows resolves source/field with fallback + map", () => {
  assert.deepEqual(channelRows(feishu, t), [{ label: "R.account", value: "Alice" }]);
  const f2 = { ...feishu, config: { configured: true, linkedUserId: "uid7" } };
  assert.equal(channelRows(f2, t)[0].value, "uid7");
  const f3 = { ...feishu, config: { configured: true } };
  assert.equal(channelRows(f3, t)[0].value, "R.account.waiting");
  assert.equal(channelRows(wechat, t)[0].value, "H.no");
});
test("channelFormSpec emits visible fields with current values + select options", () => {
  const spec = channelFormSpec(feishu, t);
  assert.equal(spec[0].name, "domain");
  assert.equal(spec[0].type, "select");
  assert.equal(spec[0].value, "lark");
  assert.deepEqual(spec[0].options, [{ value: "feishu", label: "O.feishu" }, { value: "lark", label: "O.lark" }]);
  assert.ok(!channelFormSpec(wechat, t).some((f) => f.name === "accountId"));
});
test("channelBoundButton is 3-state via boundWhen", () => {
  assert.equal(channelBoundButton(feishu, t, { activeLoginId: null }).label, "web.channel.rebind");
  assert.equal(channelBoundButton(wechat, t, { activeLoginId: null }).label, "web.channel.bind");
  assert.equal(channelBoundButton(wechat, t, { activeLoginId: "x" }).label, "web.channel.refresh");
});
test("normalizedLoginView maps {state} to a phase + lines", () => {
  assert.equal(normalizedLoginView({ state: "pending", qrUrl: "Q" }, t).phase, "pending");
  assert.equal(normalizedLoginView({ state: "confirmed", account: { name: "Bob" } }, t).phase, "confirmed");
  assert.equal(normalizedLoginView({ state: "expired" }, t).phase, "expired");
  assert.equal(normalizedLoginView({ state: "failed", message: "nope" }, t).message, "nope");
});
test("restingLoginView: bound channel → confirmed with account line", () => {
  const view = restingLoginView(feishu, t);
  assert.equal(view.phase, "confirmed");
  assert.equal(view.qrUrl, null);
  assert.equal(view.accountLine, "web.channel.row.account：Alice");
  assert.equal(view.message, null);
});
test("restingLoginView: bound channel without name falls back to linkedUserId", () => {
  const f = { ...feishu, config: { configured: true, linkedUserId: "uid7" } };
  assert.equal(restingLoginView(f, t).accountLine, "web.channel.row.account：uid7");
});
test("restingLoginView: bound channel with no account → null account line", () => {
  const f = { ...feishu, config: { configured: true } };
  assert.equal(restingLoginView(f, t).accountLine, null);
});
test("restingLoginView: unbound channel → empty scan-hint view", () => {
  assert.deepEqual(restingLoginView(wechat, t), {
    phase: "empty", qrUrl: null, accountLine: null, message: null,
  });
});
test("readinessFromChannels: bound + running derived across channels", () => {
  assert.equal(readinessFromChannels([feishu, wechat]).bound, true);
  assert.equal(readinessFromChannels([feishu, wechat]).running, true);
  assert.equal(readinessFromChannels([wechat]).bound, false);
});
test("works for an arbitrary credentials plugin (generalization)", () => {
  const dingtalk = {
    id: "dingtalk", displayName: "钉钉", binding: "credentials", icon: "钉",
    states: { configured: { labelKey: "S.cfg", tone: "neutral" }, not_configured: { labelKey: "S.nc", tone: "warning" } },
    statusFlags: [], statusRows: [],
    configFields: [{ name: "appKey", type: "text", labelKey: "F.key" }, { name: "appSecret", type: "password", labelKey: "F.secret", secret: true }],
    boundWhen: { source: "config", field: "configured" },
    status: {}, runtime: { state: "not_configured" }, config: {},
  };
  assert.equal(channelBadge(dingtalk, t).tone, "warning");
  const spec = channelFormSpec(dingtalk, t);
  assert.equal(spec.find((f) => f.name === "appSecret").type, "password");
});

function ch(over = {}) {
  return { id: "x", binding: "token", boundWhen: { source: "config", field: "linkedChatId" },
    config: {}, runtime: { state: "not_configured" }, status: {}, states: {}, statusFlags: [], statusRows: [], ...over };
}

test("isConnected: bound OR config.configured; unconfigured is false", () => {
  assert.equal(isConnected(ch({ config: {} })), false);
  assert.equal(isConnected(ch({ config: { configured: true } })), true);
  assert.equal(isConnected(ch({ config: { linkedChatId: "9" } })), true); // bound
});

test("partitionChannels splits connected vs available, stable order", () => {
  const a = ch({ id: "a", config: {} });                       // available
  const b = ch({ id: "b", config: { configured: true } });      // connected
  const c = ch({ id: "c", config: { linkedChatId: "9" } });     // connected (bound)
  const { connected, available } = partitionChannels([a, b, c]);
  assert.deepEqual(connected.map((x) => x.id), ["b", "c"]);
  assert.deepEqual(available.map((x) => x.id), ["a"]);
});

test("channelBadge shows pending-pair for token configured-but-not-bound", () => {
  const tg = ch({ binding: "token", config: { configured: true } }); // configured, not bound
  assert.deepEqual(channelBadge(tg, t), { text: "web.channel.state.pendingPair", tone: "warning" });
  const qr = ch({ binding: "qr", config: { configured: true }, boundWhen: { source: "config", field: "loggedIn" } });
  assert.deepEqual(channelBadge(qr, t), { text: "web.channel.state.pendingScan", tone: "warning" });
});

test("channelBadge unchanged for bound/running and statusFlags still win", () => {
  const bound = ch({ config: { linkedChatId: "9" }, runtime: { state: "running" }, states: { running: { labelKey: "web.channel.state.running", tone: "success" } } });
  assert.deepEqual(channelBadge(bound, t), { text: "web.channel.state.running", tone: "success" });
  const flagged = ch({ statusFlags: [{ source: "runtime", field: "needsRelogin", tone: "warning", badgeKey: "FLAG" }], runtime: { needsRelogin: true, state: "running" } });
  assert.deepEqual(channelBadge(flagged, t), { text: "FLAG", tone: "warning" });
});

test("channelSummaryLine: account when bound, pending hint otherwise, empty when unconfigured", () => {
  assert.equal(channelSummaryLine(ch({ config: { linkedChatId: "9", linkedUserName: "Ann" } }), t), "Ann");
  assert.equal(channelSummaryLine(ch({ binding: "token", config: { configured: true } }), t), "web.channel.summary.pendingPair");
  assert.equal(channelSummaryLine(ch({ config: {} }), t), "");
});

test("bindingAffordance: pairing code for token-pending, qr for qr-pending, null otherwise", () => {
  assert.deepEqual(bindingAffordance(ch({ binding: "token", config: { configured: true, pairingCode: "7K2M9Q" } })), { kind: "pairingCode", code: "7K2M9Q" });
  assert.deepEqual(bindingAffordance(ch({ binding: "qr", config: { configured: true }, boundWhen: { source: "config", field: "loggedIn" } })), { kind: "qr" });
  assert.equal(bindingAffordance(ch({ config: { linkedChatId: "9" } })), null); // bound
  assert.equal(bindingAffordance(ch({ config: {} })), null); // unconfigured
});

test("channelSetup: splits steps by newline + maps link, null when no meta.setup", () => {
  const c = ch({ setup: { stepsKey: "S", link: { url: "https://x", labelKey: "L" } } });
  const tt = (k) => (k === "S" ? "step one\nstep two\n" : k === "L" ? "open" : k);
  assert.deepEqual(channelSetup(c, tt), { steps: ["step one", "step two"], link: { url: "https://x", label: "open" } });
  assert.equal(channelSetup(ch({}), t), null);
});
