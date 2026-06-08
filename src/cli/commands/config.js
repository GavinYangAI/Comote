// `comote config <channel> [field=value ...]`.
//
// No pairs  → GET /api/channels/:id/config and print the redacted PUBLIC config
//             (secrets already arrive as has<X>:true booleans from the wrapper's
//             normalizeSecretPatch; we never see raw secrets on read).
// pairs     → PUT /api/channels/:id/config with the {field:value} patch; the
//             route returns the redacted public config, which we print back.
//
// Display masks any value whose key looks secret as a belt-and-suspenders guard
// in case a non-redacting channel ever returns one. --json passes through.

import { createRenderer } from "../render.js";
import { UsageError } from "../index.js";

// Keys we treat as secret for masking-on-display. The server already redacts,
// but the CLI must never echo a token even if a future channel forgets to.
const SECRET_KEY = /(token|secret|key|password|passwd|appsecret|encryptkey)$/i;

function maskValue(key, value) {
  if (typeof value !== "string") {
    return value;
  }
  if (SECRET_KEY.test(key) && value && value !== "********") {
    return "********";
  }
  return value;
}

export async function run({ parsed, client, env, write }) {
  const r = createRenderer({ flags: parsed.flags, env });
  // `config` is path[0]; the channel id is path[1] (or first positional if the
  // parser kept it there). Reject the bare form with a usage error.
  const id = parsed.path[1] ?? parsed.positionals[0];
  if (!id) {
    throw new UsageError("Usage: comote config <channel> [field=value ...]");
  }
  const route = `/api/channels/${encodeURIComponent(id)}/config`;
  const pairs = parsed.pairs ?? {};
  const hasPatch = Object.keys(pairs).length > 0;

  let config;
  if (hasPatch) {
    // Map empty value → unset (server strips the '********' sentinel itself).
    config = await client.put(route, pairs);
  } else {
    config = await client.get(route);
  }

  if (r.json) {
    write(`${r.jsonText(config)}\n`);
    return 0;
  }

  const entries = Object.entries(config ?? {}).map(([k, v]) => [
    k,
    formatValue(maskValue(k, v), r),
  ]);
  if (entries.length === 0) {
    write(`${r.dim("(not configured)")}\n`);
    return 0;
  }
  if (hasPatch) {
    write(`${r.green(`Updated ${id} config.`)}\n`);
  }
  write(`${r.keyval(entries)}\n`);
  return 0;
}

function formatValue(value, r) {
  if (value === true) {
    return r.green("true");
  }
  if (value === false) {
    return r.dim("false");
  }
  if (value == null || value === "") {
    return r.dim("—");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
