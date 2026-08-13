import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("settings page contains the global-manager binding panel and shared Feishu QR flow", async () => {
  const [html, app, i18n] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/i18n.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="globalManager"/);
  assert.match(html, /id="globalManagerLoginResult"/);
  assert.match(app, /\/api\/channels\/feishu\/login\/start/);
  assert.match(app, /web\.globalManager\.bindInChat/);
  assert.match(i18n, /\/manager bind/);
  assert.match(
    app,
    /document\.querySelector\("#globalManagerRescan"\)\?\.addEventListener\("click", async \(\) => \{\s*await startGlobalManagerQr\(\);\s*\}\);/,
  );
});
