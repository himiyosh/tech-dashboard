import { shareUrlWithLang, type SiteLang } from "./lang-url.ts";
import { SITE_URL } from "./site.ts";

export interface ArticleShareInput {
  url: string;
  target: "detail" | "source";
  titleJa: string;
  titleEn: string;
}

export interface ArticleSharePayload {
  title: string;
  text: string;
  url: string;
}

export function buildArticleSharePayload(
  input: ArticleShareInput,
  lang: SiteLang,
): ArticleSharePayload {
  const title = (lang === "en" ? input.titleEn : input.titleJa).trim();
  if (!title) throw new Error("Article share requires a title");

  const url = new URL(input.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Article share requires an HTTP(S) URL");
  }
  if (input.target === "detail"
    && (url.origin !== new URL(SITE_URL).origin || !/^\/e\/[^/]+\/$/.test(url.pathname))) {
    throw new Error("Article detail share must use the canonical site");
  }

  return {
    title,
    text: title,
    url: input.target === "detail"
      ? shareUrlWithLang(url.toString(), lang)
      : url.toString(),
  };
}
