/**
 * web/src/lib/lang-url.ts
 *
 * Shareable-URL language contract for the JA/EN interface toggle.
 *
 * The toggle itself (Portal.astro) only ever stored the chosen language in
 * `localStorage`, so a URL a reader shares after switching to EN could not
 * reproduce EN in a fresh browser (no localStorage) or for a different
 * reader. These pure helpers make the current `?lang=` query parameter the
 * source of truth when present, and keep the address bar in sync with the
 * active language without discarding any other existing query parameter
 * (search query, tag filter, etc.) or adding browser-history entries.
 *
 * Japanese remains the default: a URL with no `lang` parameter always
 * resolves to "ja", and the parameter is omitted (not written as
 * `lang=ja`) so default URLs stay clean, canonical, and unaffected by this
 * contract.
 */

export type SiteLang = "ja" | "en";

const DEFAULT_LANG: SiteLang = "ja";
const LANG_PARAM = "lang";

function isSiteLang(value: string | null | undefined): value is SiteLang {
  return value === "ja" || value === "en";
}

export interface ResolvedLang {
  /** The language that should render for this request. */
  lang: SiteLang;
  /** True when `lang` was determined by an explicit `?lang=` query value. */
  fromUrl: boolean;
}

/**
 * Resolve which language should render given the current URL query string
 * and a previously stored preference (typically `localStorage`).
 *
 * Priority: explicit `?lang=` query value (truthful for a shared URL) >
 * stored preference (local persistence across pages without the param) >
 * "ja" default. An unrecognized `lang` value is ignored, not treated as an
 * error, so malformed or unrelated query strings degrade safely.
 */
export function resolveLangFromUrl(
  search: string,
  storedLang: string | null | undefined,
): ResolvedLang {
  const urlLang = new URLSearchParams(search).get(LANG_PARAM);
  if (isSiteLang(urlLang)) return { lang: urlLang, fromUrl: true };
  if (isSiteLang(storedLang)) return { lang: storedLang, fromUrl: false };
  return { lang: DEFAULT_LANG, fromUrl: false };
}

/**
 * Return the href that truthfully reflects `lang`, preserving every other
 * existing query parameter and the hash. Throws are swallowed by callers;
 * an invalid `href` simply leaves the caller's current URL untouched.
 */
export function hrefWithLang(href: string, lang: SiteLang): string {
  const url = new URL(href);
  if (lang === "en") url.searchParams.set(LANG_PARAM, "en");
  else url.searchParams.delete(LANG_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Build a copy of `url` (a canonical share URL, typically without a query
 * string) that carries `lang=en` when `lang` is "en", or the bare `url`
 * when "ja" (the default is kept clean). Used by share/copy actions so the
 * copied link reproduces the language the reader is currently viewing.
 */
export function shareUrlWithLang(url: string, lang: SiteLang): string {
  if (lang !== "en") return url;
  const target = new URL(url);
  target.searchParams.set(LANG_PARAM, "en");
  return target.toString();
}
