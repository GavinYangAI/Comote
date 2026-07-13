import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "GavinYangAI/comote";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
// Update guidance is keyed on the INSTALL SOURCE, not the OS: an npm-installed
// daemon (any platform — README documents npm installs on macOS/Windows/Linux)
// gets an npm command; a desktop-App install gets a download link.
export const NPM_UPDATE_COMMAND = "npm install -g comote@latest";
// Back-compat alias: Linux used to be the only npm-installed target.
export const LINUX_UPDATE_COMMAND = NPM_UPDATE_COMMAND;

// True when `p` contains `segment` as a whole path segment (either separator,
// so Windows paths behave when tests run on POSIX and vice versa).
function hasPathSegment(p, segment) {
  return String(p)
    .split(/[\\/]/)
    .includes(segment);
}

function moduleSelfPath() {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
}

// Detect how this Comote instance was installed:
//   "desktop" — running out of the Tauri App's bundled resources. Signals:
//               an explicit COMOTE_LAUNCHED_BY=tauri env (future-proof hook),
//               or a path inside the App's resource dir — the bundled server
//               lives under a `comote-server` directory (main.rs:
//               resource_dir/comote-server/src/server/index.js), macOS under
//               <App>.app/Contents/Resources/. Checked FIRST because the
//               bundle also ships a node_modules for its deps.
//   "npm"     — this module (or argv[1], or its realpath — npm global bins are
//               symlinks into lib/node_modules) lives under a node_modules
//               directory.
// Fallback when neither signal fires (e.g. a git checkout): Linux has no
// desktop build, so npm is the only channel there; elsewhere assume desktop.
export function detectInstallSource({
  argv1 = process.argv[1],
  modulePath = moduleSelfPath(),
  env = process.env,
  platform = process.platform,
  realpath = realpathSync,
} = {}) {
  if (env?.COMOTE_LAUNCHED_BY === "tauri") {
    return "desktop";
  }
  const candidates = [];
  for (const p of [modulePath, argv1]) {
    if (!p) continue;
    candidates.push(String(p));
    try {
      candidates.push(String(realpath(p)));
    } catch {
      // Path may not exist (tests, packed snapshots) — the literal string is enough.
    }
  }
  if (
    candidates.some(
      (p) => hasPathSegment(p, "comote-server") || p.includes(`${sep}Contents${sep}Resources${sep}`),
    )
  ) {
    return "desktop";
  }
  if (candidates.some((p) => hasPathSegment(p, "node_modules"))) {
    return "npm";
  }
  return platform === "linux" ? "npm" : "desktop";
}

export function compareSemver(a, b) {
  const parse = (value) =>
    String(value ?? "0.0.0")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

function normalizeTag(tag) {
  if (typeof tag !== "string") return null;
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function emptyResult(currentVersion, platform = process.platform, installSource = "desktop") {
  return {
    current: currentVersion,
    latest: null,
    hasUpdate: false,
    releaseUrl: null,
    downloadUrl: null,
    updateCommand: installSource === "npm" ? NPM_UPDATE_COMMAND : null,
    platform,
    installSource,
    releaseNotes: null,
    checkedAt: null,
    error: null,
  };
}

export function selectDownloadUrl(assets, { platform = process.platform, arch = process.arch, releasesUrl = null } = {}) {
  if (!Array.isArray(assets) || assets.length === 0) {
    return releasesUrl;
  }
  const candidates = assets
    .filter((asset) => asset?.browser_download_url && asset?.name)
    .map((asset) => ({
      name: String(asset.name).toLowerCase(),
      url: asset.browser_download_url,
    }));
  const platformMatchers =
    platform === "darwin"
      ? [/\.dmg$/, /mac|darwin|apple/]
      : platform === "win32"
        ? [/(setup|installer).*\.exe$/, /\.msi$/, /\.exe$/]
        : [/\.appimage$/, /\.deb$/, /\.rpm$/, /linux|gnu|musl|\.tar\.gz$|\.tgz$/];
  const archMatchers =
    arch === "arm64"
      ? [/arm64|aarch64|universal|apple|mac|darwin|\.dmg$/]
      : arch === "x64"
        ? [/x64|x86_64|amd64|universal|\.dmg$|\.exe$|\.msi$/]
        : [];
  return (
    candidates.find((asset) => platformMatchers.some((matcher) => matcher.test(asset.name)) && archMatchers.some((matcher) => matcher.test(asset.name)))?.url ??
    candidates.find((asset) => platformMatchers.some((matcher) => matcher.test(asset.name)))?.url ??
    candidates[0]?.url ??
    releasesUrl
  );
}

export class VersionChecker {
  constructor({
    currentVersion,
    repo = DEFAULT_REPO,
    fetchImpl = globalThis.fetch,
    cacheFilePath = null,
    intervalMs = DEFAULT_INTERVAL_MS,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    now = () => Date.now(),
    platform = process.platform,
    arch = process.arch,
    installSource = null,
  } = {}) {
    if (!currentVersion) {
      throw new Error("VersionChecker requires currentVersion");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("VersionChecker requires a fetch implementation");
    }
    this.currentVersion = currentVersion;
    this.repo = repo;
    this.fetchImpl = fetchImpl;
    this.cacheFilePath = cacheFilePath;
    this.intervalMs = intervalMs;
    this.initialDelayMs = initialDelayMs;
    this.now = now;
    this.platform = platform;
    this.arch = arch;
    // Explicit override wins (tests, callers that already know); otherwise
    // detect from the runtime paths, with the injected platform as fallback.
    this.installSource = installSource ?? detectInstallSource({ platform });
    this.lastResult = emptyResult(currentVersion, platform, this.installSource);
    this._initialTimer = null;
    this._timer = null;
  }

  getLastResult() {
    return { ...this.lastResult };
  }

  async loadCache() {
    if (!this.cacheFilePath) return;
    try {
      const raw = await readFile(this.cacheFilePath, "utf8");
      const cached = JSON.parse(raw);
      if (cached && cached.current === this.currentVersion) {
        this.lastResult = { ...this.lastResult, ...cached };
      }
    } catch {
      // No usable cache; keep the empty result.
    }
  }

  async checkNow({ force = false } = {}) {
    if (!force && this.lastResult.checkedAt) {
      const age = this.now() - this.lastResult.checkedAt;
      if (age < CACHE_TTL_MS) {
        return this.getLastResult();
      }
    }
    try {
      const response = await this.fetchImpl(
        `https://api.github.com/repos/${this.repo}/releases/latest`,
        { headers: { accept: "application/vnd.github+json" } },
      );
      if (response.status === 404) {
        // No published release yet — valid state, not an error.
        this.lastResult = {
          ...emptyResult(this.currentVersion, this.platform, this.installSource),
          checkedAt: this.now(),
        };
      } else if (!response.ok) {
        this.lastResult = {
          ...this.lastResult,
          checkedAt: this.now(),
          error: `GitHub API returned ${response.status}`,
        };
      } else {
        const data = await response.json();
        const latest = normalizeTag(data.tag_name);
        const hasUpdate = latest ? compareSemver(latest, this.currentVersion) > 0 : false;
        const fromNpm = this.installSource === "npm";
        this.lastResult = {
          current: this.currentVersion,
          latest,
          hasUpdate,
          releaseUrl: data.html_url ?? null,
          // npm installs (any platform) update via npm — a desktop download
          // link would be the wrong (or, on Linux, a dead) affordance. Desktop
          // installs get the release asset for their platform/arch instead.
          downloadUrl: fromNpm
            ? null
            : selectDownloadUrl(data.assets, {
                platform: this.platform,
                arch: this.arch,
                releasesUrl: data.html_url ?? `https://github.com/${this.repo}/releases`,
              }),
          updateCommand: fromNpm ? NPM_UPDATE_COMMAND : null,
          platform: this.platform,
          installSource: this.installSource,
          releaseNotes: data.body ?? null,
          checkedAt: this.now(),
          error: null,
        };
      }
      await this._persist();
    } catch (error) {
      this.lastResult = {
        ...this.lastResult,
        checkedAt: this.now(),
        error: error?.message ?? String(error),
      };
    }
    return this.getLastResult();
  }

  start() {
    if (this._initialTimer || this._timer) return;
    this._initialTimer = setTimeout(() => {
      this._initialTimer = null;
      this.checkNow().catch(() => {});
      this._timer = setInterval(() => {
        this.checkNow().catch(() => {});
      }, this.intervalMs);
      this._timer.unref?.();
    }, this.initialDelayMs);
    this._initialTimer.unref?.();
  }

  stop() {
    if (this._initialTimer) {
      clearTimeout(this._initialTimer);
      this._initialTimer = null;
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _persist() {
    if (!this.cacheFilePath) return;
    try {
      await mkdir(dirname(this.cacheFilePath), { recursive: true });
      await writeFile(this.cacheFilePath, JSON.stringify(this.lastResult, null, 2));
    } catch {
      // Cache persistence is best-effort.
    }
  }
}
