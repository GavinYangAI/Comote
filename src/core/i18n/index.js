import zh from "./locales/zh.js";
import en from "./locales/en.js";
import ja from "./locales/ja.js";
import ko from "./locales/ko.js";
import fr from "./locales/fr.js";
import es from "./locales/es.js";

export const SUPPORTED_LOCALES = ["zh", "en", "ja", "ko", "fr", "es"];
export const DEFAULT_LOCALE = "zh";
const DICTS = { zh, en, ja, ko, fr, es };

let currentLocale = DEFAULT_LOCALE;

export function setLocale(locale) {
  currentLocale = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  return currentLocale;
}

export function getLocale() {
  return currentLocale;
}

export function t(key, vars) {
  const dict = DICTS[currentLocale] ?? DICTS[DEFAULT_LOCALE];
  let template = dict[key];
  if (template === undefined) template = DICTS[DEFAULT_LOCALE][key];
  if (template === undefined) return key;
  return vars ? interpolate(template, vars) : template;
}

function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}
