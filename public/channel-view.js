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

function isBound(channel) {
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

export function readinessFromChannels(channels) {
  return {
    bound: channels.some((c) => isBound(c)),
    running: channels.some((c) => c.runtime?.state === "running"),
  };
}
