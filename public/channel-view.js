// Pure, DOM-free mappers from a `GET /api/channels` entry to view models.
// Importable by both the browser (app.js) and node:test. `t` is a translate fn.

function pick(channel, source, field) {
  const bag = source === "config" ? channel.config : source === "runtime" ? channel.runtime : channel.status;
  return bag?.[field];
}

export function channelBadge(channel, t) {
  for (const flag of channel.statusFlags ?? []) {
    if (pick(channel, flag.source, flag.field)) {
      return { text: t(flag.badgeKey), tone: flag.tone };
    }
  }
  // A recorded runtime error (bad token, stream drop, poll failure) beats the
  // state-derived badge: "已配置/监听中" over a broken channel is exactly the
  // silent-failure C-1 complained about. Cleared by the runtime on the next
  // successful poll/deliver/start, so this self-heals.
  if (channelLastError(channel)) {
    return { text: t("web.channel.state.error"), tone: "error" };
  }
  // Configured but not yet bound → pending-binding badge (token: 待配对, qr: 待扫码).
  // Only telegram reaches this today (configured !== bound); others have configured≡bound.
  if (isConnected(channel) && !isBound(channel)) {
    const key = channel.binding === "qr" ? "web.channel.state.pendingScan" : "web.channel.state.pendingPair";
    return { text: t(key), tone: "warning" };
  }
  const state = channel.runtime?.state ?? "not_configured";
  const def = channel.states?.[state] ?? channel.states?.not_configured ?? { labelKey: state, tone: "neutral" };
  return { text: t(def.labelKey), tone: def.tone };
}

export function channelRows(channel, t) {
  return (channel.statusRows ?? []).map((row) => {
    let raw = pick(channel, row.source, row.field);
    if ((raw === undefined || raw === null || raw === "") && row.fallback) {
      for (const f of row.fallback) {
        const v = pick(channel, row.source, f);
        if (v !== undefined && v !== null && v !== "") { raw = v; break; }
      }
    }
    let value;
    if (raw === undefined || raw === null || raw === "") {
      value = row.fallbackKey ? t(row.fallbackKey) : "";
    } else if (row.map) {
      value = t(row.map[String(raw)] ?? String(raw));
    } else {
      value = String(raw);
    }
    return { label: t(row.labelKey), value };
  });
}

export function channelFormSpec(channel, t) {
  return (channel.configFields ?? [])
    .filter((f) => !f.hidden)
    .map((f) => ({
      name: f.name,
      type: f.type,
      label: t(f.labelKey),
      secret: Boolean(f.secret),
      value: channel.config?.[f.name] ?? f.default ?? "",
      options: (f.options ?? []).map((o) => ({ value: o.value, label: t(o.labelKey) })),
    }));
}

export function isBound(channel) {
  const bw = channel.boundWhen;
  return bw ? Boolean(pick(channel, bw.source, bw.field)) : false;
}

export function channelBoundButton(channel, t, { activeLoginId } = {}) {
  if (activeLoginId) return { label: t("web.channel.refresh"), variant: "refresh" };
  if (isBound(channel)) return { label: t("web.channel.rebind"), variant: "rebind" };
  return { label: t("web.channel.bind"), variant: "bind" };
}

export function normalizedLoginView(status, t) {
  const phase = status?.state ?? "pending";
  const map = {
    pending: "web.channel.qr.scanHint",
    scanned: "web.channel.qr.scanned",
    confirmed: "web.channel.qr.confirmed",
    expired: "web.channel.qr.expired",
    failed: "web.channel.qr.failed",
  };
  return {
    phase,
    qrUrl: status?.qrUrl ?? null,
    accountLine: status?.account?.name ?? status?.account?.id ?? null,
    message: status?.message ?? (map[phase] ? t(map[phase]) : null),
  };
}

// Resting (no-login-in-flight) view for a qr channel: a bound summary when the
// channel reports bound, otherwise the empty scan hint. Mirrors the normalized
// login view shape ({ phase, qrUrl, accountLine, message }).
export function restingLoginView(channel, t) {
  if (!isBound(channel)) {
    return { phase: "empty", qrUrl: null, accountLine: null, message: null };
  }
  const account = channel.config?.linkedUserName ?? channel.config?.linkedUserId ?? null;
  return {
    phase: "confirmed",
    qrUrl: null,
    accountLine: account ? t("web.channel.row.account") + "：" + account : null,
    message: null,
  };
}

// The runtime's recorded lastError, or null. Trimmed so whitespace-only
// values (defensive) don't render an empty red row.
export function channelLastError(channel) {
  const raw = channel?.runtime?.lastError;
  const text = typeof raw === "string" ? raw.trim() : "";
  return text || null;
}

export function readinessFromChannels(channels) {
  return {
    bound: channels.some((c) => isBound(c)),
    running: channels.some((c) => c.runtime?.state === "running"),
  };
}

// A channel is "connected" (vs available-to-add) once it is bound or has saved
// operational config. Only telegram is ever connected-but-not-bound (待配对);
// feishu/dingtalk have configured≡bound, wechat uses loggedIn (== bound).
export function isConnected(channel) {
  return isBound(channel) || Boolean(channel.config?.configured);
}

export function partitionChannels(channels) {
  const connected = [];
  const available = [];
  for (const c of channels) (isConnected(c) ? connected : available).push(c);
  return { connected, available };
}

// Collapsed-row subtitle: account name when bound; a pending hint when configured
// but not bound; empty when unconfigured (available tile shows binding hint instead).
export function channelSummaryLine(channel, t) {
  if (isBound(channel)) {
    return channel.config?.linkedUserName ?? channel.config?.linkedChatId ?? channel.config?.linkedUserId ?? "";
  }
  if (isConnected(channel)) {
    return channel.binding === "qr" ? t("web.channel.summary.pendingScan") : t("web.channel.summary.pendingPair");
  }
  return "";
}

// Expanded-state binding credential to surface, ONLY when configured-but-not-bound.
// token → the pairing code (from config); qr → the QR login area marker. null when
// bound or unconfigured. This is what fixes #3: pairing code never shows otherwise.
export function bindingAffordance(channel) {
  if (isBound(channel) || !isConnected(channel)) return null;
  if (channel.binding === "token") return { kind: "pairingCode", code: channel.config?.pairingCode ?? null };
  if (channel.binding === "qr") return { kind: "qr" };
  return null;
}

// Per-channel setup help from meta.setup: { stepsKey, link:{url,labelKey} }.
// steps i18n value is a single string with \n between steps. null when no meta.setup.
export function channelSetup(channel, t) {
  const s = channel.setup;
  if (!s) return null;
  const steps = String(t(s.stepsKey) ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
  const link = s.link ? { url: s.link.url, label: t(s.link.labelKey) } : null;
  return { steps, link };
}
