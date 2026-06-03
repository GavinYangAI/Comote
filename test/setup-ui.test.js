import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("setup flow starts with phone channels instead of asking users to connect Codex", async () => {
  const html = await readFile("public/index.html", "utf8");
  const setupFlow = html.match(/<section id="connectPhone"[\s\S]*?<\/section>/)?.[0] ?? "";

  assert.match(setupFlow, /<h2>连接手机<\/h2>/);
  assert.match(setupFlow, /<h3>微信<\/h3>/);
  assert.match(setupFlow, /<h3>飞书<\/h3>/);
  assert.match(setupFlow, /id="wechatLoginResult"/);
  assert.match(setupFlow, /id="startWechatLogin"[\s\S]*?>绑定微信<\/button>/);
  assert.match(html, /rel="icon" href="\/logo\.svg"/);
  assert.match(setupFlow, /id="feishuLoginResult"/);
  assert.match(setupFlow, /id="feishuConfigForm"/);
  assert.match(setupFlow, /for="feishuDomain"/);
  assert.match(setupFlow, /id="feishuDomain"/);
  assert.match(setupFlow, /name="domain"/);
  assert.match(setupFlow, /id="startFeishuLogin"[\s\S]*?>绑定飞书<\/button>/);
  assert.doesNotMatch(setupFlow, /<h2>连接 Codex Desktop<\/h2>/);
  assert.doesNotMatch(setupFlow, /id="autoConnectDesktop"/);
  assert.doesNotMatch(setupFlow, /id="connectDesktop"/);
  assert.doesNotMatch(setupFlow, /id="startWechat"/);
  assert.doesNotMatch(setupFlow, /id="stopWechat"/);
  assert.doesNotMatch(setupFlow, />开始监听<\/button>/);
  assert.doesNotMatch(setupFlow, />停止<\/button>/);
});

test("authorized user rows use readable wrapped identity layout", async () => {
  const app = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(app, /class="identity-row-main"/);
  assert.match(app, /class="identity-row-title"/);
  assert.match(app, /class="identity-stable-id"/);
  assert.match(app, /class="empty-state-row"/);
  assert.match(app, /data-remove-identity=/);
  assert.match(app, /data-confirm-identity=/);

  assert.match(css, /\.identity-row-main\s*\{[\s\S]*min-width:\s*0;/);
  assert.match(css, /\.identity-stable-id\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
  assert.match(css, /\.identity-row-action\s*\{[\s\S]*flex:\s*0 0 auto;/);
  assert.match(css, /\.list li\.empty-state-row\s*\{[\s\S]*min-height:\s*58px;/);
});

test("secondary link buttons render with button typography", async () => {
  const setupFlow = await readFile("public/index.html", "utf8");
  const app = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(setupFlow, /id="aboutReleasesLink" class="secondary-button"/);
  assert.match(setupFlow, /href="https:\/\/github\.com\/GavinYangAI\/Comote\/releases"/);
  assert.match(app, /data\.downloadUrl \?\? data\.releaseUrl \?\? data\.releasesUrl/);
  assert.match(app, /aboutLink\.href = data\?\.releasesUrl \?\? RELEASES_URL/);
  assert.match(css, /\.secondary-button\s*\{[\s\S]*display:\s*inline-flex;/);
  assert.match(css, /\.secondary-button\s*\{[\s\S]*text-decoration:\s*none;/);
  assert.match(css, /\.panel \.kv a\s*\{[\s\S]*color:\s*var\(--teal-text\);/);
});

test("navigation does not require a top eyebrow element", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /if \(eyebrow\) \{/);
});

test("sidebar height compensates for global zoom", async () => {
  const css = await readFile("public/styles.css", "utf8");

  assert.match(css, /--ui-zoom:\s*0\.85;/);
  assert.match(css, /zoom:\s*var\(--ui-zoom\);/);
  assert.match(css, /\.app-frame\s*\{[\s\S]*min-height:\s*calc\(100vh \/ var\(--ui-zoom\)\);/);
  assert.match(css, /\.side-nav\s*\{[\s\S]*height:\s*calc\(100vh \/ var\(--ui-zoom\)\);/);
});

test("advanced settings expose a desktop Dock icon toggle", async () => {
  const html = await readFile("public/index.html", "utf8");
  const app = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(html, /id="showDockIcon"/);
  assert.match(html, /显示 Dock 图标/);
  assert.match(app, /get_show_dock_icon/);
  assert.match(app, /set_show_dock_icon/);
  assert.match(app, /showDockIconToggle/);
  assert.match(css, /\.setting-toggle\s*\{/);
  assert.match(css, /\.switch-control\s*\{/);
});

test("advanced settings expose a keep-daemon-alive toggle in the last panel", async () => {
  const html = await readFile("public/index.html", "utf8");
  const app = await readFile("public/app.js", "utf8");

  assert.match(html, /id="keepDaemonAlive"/);
  assert.match(html, /保持后台服务在线/);
  assert.match(app, /get_keep_daemon_alive/);
  assert.match(app, /set_keep_daemon_alive/);

  // The desktop-display panel must stay in the LAST advanced section.
  const bodyStart = html.indexOf('class="advanced-body"');
  const dockPanel = html.indexOf("desktop-settings-panel");
  const bodyEnd = html.indexOf("</details>", bodyStart);
  const lastSection = html.lastIndexOf('class="advanced-section"', bodyEnd);
  assert.ok(bodyStart !== -1 && dockPanel !== -1);
  assert.ok(dockPanel >= lastSection, "desktop-settings panel should be in the last advanced section");
});

test("external links route through open_external in the Tauri webview", async () => {
  const app = await readFile("public/app.js", "utf8");

  // Frontend must delegate external link clicks to the open_external command.
  assert.match(app, /open_external/);
  assert.match(app, /closest\?\.\("a\[href\]"\)/);
  assert.match(app, /preventDefault/);
});
