import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop navigation switches between exclusive application views", async () => {
  const [html, boot, js, css] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/boot.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  const navTargets = [...html.matchAll(/class="nav-item[^"]*" href="#([^"]+)"/g)].map((match) => match[1]);
  assert.ok(navTargets.length >= 6);
  for (const target of navTargets) {
    assert.match(html, new RegExp(`<section id="${target}" class="[^"]*app-page`));
  }

  assert.equal((html.match(/class="[^"]*app-page active[^"]*"/g) ?? []).length, 1);
  assert.match(html, /<img class="brand-logo" src="\/icon\.png"/);
  assert.match(boot, /<img class="logo" src="\.\/icon\.png"/);
  assert.match(js, /window\.addEventListener\("hashchange"/);
  assert.doesNotMatch(js, /IntersectionObserver/);
  assert.match(css, /\.app-page\.active\s*\{\s*display:\s*block/);
  assert.doesNotMatch(css, /--ui-zoom|zoom:\s*var\(--ui-zoom\)/);
});

test("identity rows and channel summaries constrain long dynamic text", async () => {
  const [js, css] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(js, /class="identity-id" title=/);
  assert.match(css, /\.list-row-copy\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.identity-meta \.identity-id\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /\.channel-row-head \.ch-summary[\s\S]*text-overflow:\s*ellipsis/);
});

test("desktop approvals expose the allow-for-session decision", async () => {
  const [js, i18n, css] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/i18n.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);
  assert.match(js, /\|acceptForSession/);
  assert.match(i18n, /web\.approvals\.acceptForSession/);
  assert.match(js, /class="list-row approval-row"/);
  assert.match(css, /\.approval-copy\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.approval-actions\s*\{[^}]*flex:\s*1 1 360px[^}]*grid-template-columns:\s*repeat\(3/s);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.approval-actions\s*\{[^}]*grid-template-columns:\s*1fr/s);
});

test("phone commands expose localized hover and keyboard tooltips", async () => {
  const [html, css] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);
  assert.equal((html.match(/class="command-chip"/g) ?? []).length, 7);
  assert.equal((html.match(/role="tooltip"/g) ?? []).length, 7);
  assert.equal((html.match(/<code tabindex="0" aria-describedby=/g) ?? []).length, 7);
  for (const command of ["projects", "open", "sessions", "new", "approve", "automode", "cancel"]) {
    assert.match(html, new RegExp(`data-i18n="web\\.commands\\.tooltip\\.${command}"`));
    assert.match(html, new RegExp(`aria-describedby="command-${command}-tooltip"`));
    assert.match(html, new RegExp(`id="command-${command}-tooltip"`));
  }
  assert.match(css, /\.command-chip:hover \.command-tooltip/);
  assert.match(css, /\.command-chip:focus-within \.command-tooltip/);
  assert.match(css, /\.command-chip code:focus-visible/);
  assert.match(css, /white-space:\s*pre-line/);
  assert.match(css, /max-width:\s*min\(320px, calc\(100vw - 40px\)\)/);
});

test("advanced settings expose a persistent Codex connector selector", async () => {
  const [html, js, css] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(html, /id="preferredConnector" class="segmented-selector"/);
  assert.match(html, /name="preferredConnector" value="desktop"/);
  assert.match(html, /name="preferredConnector" value="cli"/);
  assert.match(js, /JSON\.stringify\(\{ preferredConnector: radio\.value \}\)/);
  assert.match(css, /\.segmented-selector\s*\{[^}]*grid-template-columns:\s*repeat\(2/s);
});

test("narrow-window layout has one responsive system and a stable sidebar", async () => {
  const css = await readFile("public/styles.css", "utf8");

  assert.doesNotMatch(css, /@media \(max-width: 960px\)/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.nav-list\s*\{[^}]*flex-flow:\s*row nowrap/);
  assert.match(css, /\.nav-item > span:not\(\.nav-count\)[\s\S]*white-space:\s*nowrap/);
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*\.command-grid\s*\{[^}]*repeat\(2/);
});

test("color theme follows the operating system without JavaScript state", async () => {
  const [css, js] = await Promise.all([
    readFile("public/styles.css", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light dark/s);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^}]*--canvas:\s*#[0-9a-f]{6}/s);
  for (const variable of ["surface", "ink", "line", "teal", "success", "warning", "error"]) {
    assert.match(css, new RegExp(`@media \\(prefers-color-scheme: dark\\)[\\s\\S]*--${variable}:`));
  }
  assert.doesNotMatch(js, /prefers-color-scheme|matchMedia\([^)]*color-scheme/i);
});
