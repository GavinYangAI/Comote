import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("thread rows expose explicit expand controls backed by persistent state", async () => {
  const app = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(app, /expandedThreadStates/);
  assert.match(app, /class="thread-toggle-btn"/);
  assert.match(app, /aria-expanded=/);
  assert.match(app, /aria-label="\$\{expanded \? "收回" : "展开"\}"/);
  assert.match(app, /updateThreadToggle\(row, isExpanded\)/);
  assert.match(app, /toggleThreadDetail/);
  assert.match(css, /\.thread-toggle-btn\s*\{/);
  assert.match(css, /width:\s*18px;/);
  assert.match(css, /background:\s*transparent;/);
  assert.match(css, /box-shadow:\s*none;/);
  assert.match(css, /appearance:\s*none;/);
  assert.match(css, /transform:\s*none;/);
  assert.match(css, /color:\s*var\(--muted\);/);
  assert.match(css, /\.thread-toggle-btn::after\s*\{/);
  assert.match(css, /\.thread-toggle-btn\[aria-expanded="true"\]::after\s*\{[\s\S]*transform:\s*rotate\(90deg\);/);
  assert.match(css, /\.thread-detail\[hidden\]\s*\{[\s\S]*display:\s*none;/);
});

test("expanded thread detail panels refresh their transcript during background sync", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /async function refreshExpandedThreadDetails/);
  assert.match(app, /await refreshExpandedThreadDetails\(\)/);
  assert.match(app, /refreshLimit/);
  assert.match(app, /offset=0/);
});

test("background refresh preserves the number of loaded log rows", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /let logsVisibleLimit = 5;/);
  assert.match(app, /const logsLimit = Math\.max\(logsVisibleLimit, 5\);/);
  assert.match(app, /\/api\/logs\?limit=\$\{logsLimit\}&offset=0/);
  assert.match(app, /renderLogs\(logs, logsLimit, logsRequestEpoch\)/);
});

test("stale log refresh responses cannot collapse loaded log rows", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /function renderLogs\(result, requestedLimit = 5, requestEpoch = logsRefreshEpoch\)/);
  assert.match(app, /if \(requestEpoch !== logsRefreshEpoch\) \{/);
  assert.match(app, /if \(requestedLimit < logsVisibleLimit\) \{/);
  assert.match(app, /logsVisibleLimit = Math\.max\(logsVisibleLimit, visibleCount, 5\);/);
});

test("manual log refresh resets loaded rows to the default page size", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /function resetLogVisibleLimit\(\) \{/);
  assert.match(app, /logsVisibleLimit = 5;/);
  assert.match(app, /logsOffset = 0;/);
  assert.match(app, /logsRefreshEpoch \+= 1;/);
  assert.match(app, /#refreshLogs[\s\S]*resetLogVisibleLimit\(\);[\s\S]*await render\(\);/);
});
