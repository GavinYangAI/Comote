import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("settings page contains the global-manager binding panel and shared Feishu QR flow", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="globalManager"/);
  assert.match(html, /id="globalManagerLoginResult"/);
  assert.match(app, /\/api\/channels\/feishu\/login\/start/);
  assert.match(app, /\/api\/global-manager\/bind/);
  assert.match(app, /web\.globalManager\.rescanConfirm/);
});
