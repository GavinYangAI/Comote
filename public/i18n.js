// Frontend i18n engine for the comote web settings page.
// Pure ESM module: importable in the browser AND node:test.
// `applyTranslations` is the only DOM-touching function and is never called in unit tests.
// Mirrors the backend engine (src/core/i18n): fallback current -> zh -> key, {var} interpolation.

export const WEB_LOCALES = ["zh", "en", "ja", "ko", "fr", "es"];
export const WEB_DEFAULT = "zh";
export const WEB_LOCALE_NAMES = {
  zh: "中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
  es: "Español",
};

const DICTS = {
  zh: {
    "web.nav.connectPhone": "连接手机",
    "web.brand.tagline": "手机上的 Codex",
  },
  en: {
    "web.nav.connectPhone": "Connect phone",
    "web.brand.tagline": "Codex on your phone",
  },
  ja: {
    "web.nav.connectPhone": "スマホを接続",
    "web.brand.tagline": "スマホで Codex",
  },
  ko: {
    "web.nav.connectPhone": "휴대폰 연결",
    "web.brand.tagline": "휴대폰 속 Codex",
  },
  fr: {
    "web.nav.connectPhone": "Connecter le téléphone",
    "web.brand.tagline": "Codex sur votre téléphone",
  },
  es: {
    "web.nav.connectPhone": "Conectar teléfono",
    "web.brand.tagline": "Codex en tu teléfono",
  },
};

let current = WEB_DEFAULT;

export function setWebLocale(locale) {
  current = WEB_LOCALES.includes(locale) ? locale : WEB_DEFAULT;
  return current;
}

export function getWebLocale() {
  return current;
}

export function webDict(locale) {
  return DICTS[locale] ?? DICTS[WEB_DEFAULT];
}

export function tWeb(key, vars) {
  const d = DICTS[current] ?? DICTS[WEB_DEFAULT];
  let s = d[key];
  if (s === undefined) s = DICTS[WEB_DEFAULT][key];
  if (s === undefined) return key;
  return vars
    ? s.replace(/\{(\w+)\}/g, (m, n) =>
        Object.prototype.hasOwnProperty.call(vars, n) ? String(vars[n]) : m,
      )
    : s;
}

// DOM application — only called in the browser at runtime (never in unit tests).
// data-i18n="key" sets textContent; data-i18n-attr="placeholder:key; title:key" sets attributes.
export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = tWeb(el.getAttribute("data-i18n"));
  });
  root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    el.getAttribute("data-i18n-attr")
      .split(";")
      .forEach((pair) => {
        const [attr, key] = pair.split(":").map((s) => s.trim());
        if (attr && key) el.setAttribute(attr, tWeb(key));
      });
  });
}
