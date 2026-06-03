import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_REPO = "GavinYangAI/Comote";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30_000;
const CACHE_TTL_MS = 60 * 60 * 1000;

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

function emptyResult(currentVersion) {
  return {
    current: currentVersion,
    latest: null,
    hasUpdate: false,
    releaseUrl: null,
    releasesUrl: `https://github.com/${DEFAULT_REPO}/releases`,
    downloadUrl: null,
    releaseNotes: null,
    checkedAt: null,
    error: null,
  };
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
    this.lastResult = emptyResult(currentVersion);
    this.lastResult.releasesUrl = this.releasesUrl;
    this._initialTimer = null;
    this._timer = null;
  }

  get releasesUrl() {
    return `https://github.com/${this.repo}/releases`;
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
        this.lastResult = { ...emptyResult(this.currentVersion), releasesUrl: this.releasesUrl, checkedAt: this.now() };
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
        this.lastResult = {
          current: this.currentVersion,
          latest,
          hasUpdate,
          releaseUrl: data.html_url ?? null,
          releasesUrl: this.releasesUrl,
          downloadUrl: selectDownloadUrl(data.assets, {
            platform: this.platform,
            arch: this.arch,
            fallbackUrl: data.html_url ?? this.releasesUrl,
          }),
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

export function selectDownloadUrl(assets, { platform = process.platform, arch = process.arch, fallbackUrl = null } = {}) {
  if (!Array.isArray(assets) || assets.length === 0) {
    return fallbackUrl;
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
    fallbackUrl
  );
}
