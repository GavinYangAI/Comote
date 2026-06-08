// `comote approvals` (list) / `comote approve <code>` / `comote deny <code>`.
//
// approvals → GET /api/approvals, list pending Codex command approvals.
// approve/deny <code> → resolve the short code shown in chat against the live
//   approval list, then POST /api/approvals/:id {decision:'accept'|'decline'}.
//   The server's resolveApproval accepts either an id or the short code, so we
//   match locally to give a clean "unknown code" error before the round-trip,
//   then post the resolved id (falling back to the raw code if unmatched).
//
// --json passes the approval list / the POST result through.

import { createRenderer } from "../render.js";
import { UsageError } from "../index.js";

// Match a user-supplied code against the pending list. Tries shortCode first
// (the code shown in chat), then a raw id, case-insensitively.
export function matchApproval(list, code) {
  if (!Array.isArray(list)) {
    return null;
  }
  const wanted = String(code).toLowerCase();
  return (
    list.find((a) => String(a.shortCode ?? "").toLowerCase() === wanted) ??
    list.find((a) => String(a.id ?? "").toLowerCase() === wanted) ??
    null
  );
}

function describe(a) {
  // A short human label for an approval row: prefer method + the command/path.
  const cmd = a.params?.command;
  if (Array.isArray(cmd)) {
    return cmd.join(" ");
  }
  if (typeof cmd === "string") {
    return cmd;
  }
  if (a.changes && a.changes.length) {
    return `${a.changes.length} file change(s)`;
  }
  return a.method ?? "—";
}

export async function run({ command, parsed, client, env, write }) {
  const r = createRenderer({ flags: parsed.flags, env });

  if (command === "approve" || command === "deny") {
    // The code may land in path[1] (the parser extends the path) or positionals.
    const code = parsed.path[1] ?? parsed.positionals[0];
    if (!code) {
      throw new UsageError(`Usage: comote ${command} <code>`);
    }
    const list = (await client.get("/api/approvals")) ?? [];
    const match = matchApproval(list, code);
    if (!match && list.length > 0) {
      write(`${r.red(`No pending approval matches code: ${code}`)}\n`);
      return 1;
    }
    const id = match?.id ?? code;
    const decision = command === "approve" ? "accept" : "decline";
    const result = await client.post(
      `/api/approvals/${encodeURIComponent(id)}`,
      { decision },
    );
    if (r.json) {
      write(`${r.jsonText(result ?? { ok: true, decision })}\n`);
      return 0;
    }
    const verb = command === "approve" ? r.green("Approved") : r.yellow("Denied");
    write(`${verb} approval ${code}.\n`);
    return 0;
  }

  // approvals (bare list)
  const list = (await client.get("/api/approvals")) ?? [];
  if (r.json) {
    write(`${r.jsonText(list)}\n`);
    return 0;
  }
  if (list.length === 0) {
    write(`${r.dim("No pending approvals.")}\n`);
    return 0;
  }
  const head = ["CODE", "METHOD", "DETAIL"];
  const rows = list.map((a) => [r.bold(a.shortCode ?? a.id), a.method ?? "—", describe(a)]);
  write(`${r.table(rows, { head })}\n`);
  return 0;
}
