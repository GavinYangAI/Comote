// `comote start <channel>` / `comote stop <channel>` — channel runtime toggle.
//
// Maps POST /api/channels/:id/runtime/start | /runtime/stop, mirroring the UI
// toggle. `start` on a not-configured channel surfaces the API error verbatim
// (the dispatcher renders ApiError). --json passes the runtime status through.

import { createRenderer } from "../render.js";
import { UsageError } from "../index.js";

export async function run({ command, parsed, client, env, write }) {
  const r = createRenderer({ flags: parsed.flags, env });
  // `command` is start|stop; the channel id is path[1] or the first positional.
  const id = parsed.path[1] ?? parsed.positionals[0];
  if (!id) {
    throw new UsageError(`Usage: comote ${command} <channel>`);
  }
  const action = command === "stop" ? "stop" : "start";
  const result = await client.post(
    `/api/channels/${encodeURIComponent(id)}/runtime/${action}`,
  );

  if (r.json) {
    write(`${r.jsonText(result ?? { ok: true })}\n`);
    return 0;
  }

  const state = result?.state ?? (action === "start" ? "running" : "configured");
  const verb = action === "start" ? "started" : "stopped";
  write(`${r.green(`Channel ${id} ${verb}.`)} ${r.dim("state:")} ${r.state(state)}\n`);
  return 0;
}
