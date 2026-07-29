import { SITE_URL } from "./site.ts";
import {
  SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
  boundedSocialDescription,
} from "./bounded-description.ts";

export type MetadataLanguage = "ja" | "en";

export interface SocialImageMetadata {
  url: string;
  altJa: string;
  altEn: string;
  type?: string;
  width?: number;
  height?: number;
}

export interface LocalizedPageMetadata {
  canonicalUrl: string;
  socialUrlJa: string;
  socialUrlEn: string;
  type: "website" | "article";
  titleJa: string;
  titleEn: string;
  socialTitleJa: string;
  socialTitleEn: string;
  descriptionJa: string;
  descriptionEn: string;
  image: SocialImageMetadata;
}

export interface ArticleImageInput {
  src?: string;
  width?: number;
  height?: number;
}

export const SOCIAL_IMAGE_PATH = "/social/tech-dashboard-v1.png";
export const SOCIAL_IMAGE_URL = new URL(SOCIAL_IMAGE_PATH, SITE_URL).toString();
export const SOCIAL_IMAGE_WIDTH = 1_200;
export const SOCIAL_IMAGE_HEIGHT = 630;
export const SOCIAL_IMAGE_TYPE = "image/png";

export const HOME_TITLE_JA = "TECH Dashboard | AI 技術アップデート";
export const HOME_TITLE_EN = "TECH Dashboard | AI Technology Updates";
export const HOME_DESCRIPTION_JA =
  "公式発表、変更履歴、arXiv 論文、コミュニティ記事を毎時 1 バッチ収集し、各ソースを約 6 時間周期で巡回。出典・重要度・AI 要約とともに整理します。";
export const HOME_DESCRIPTION_EN =
  "One hourly batch of official announcements, changelogs, arXiv papers, and community posts, with each source revisited about every six hours and organized with AI summaries.";

function localizedSocialUrl(canonicalUrl: string, lang: MetadataLanguage): string {
  const url = new URL(canonicalUrl);
  if (lang === "en") url.searchParams.set("lang", "en");
  else url.searchParams.delete("lang");
  return url.toString();
}

function absoluteHttpUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value, SITE_URL);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function positiveDimension(value: number | undefined): number | undefined {
  return Number.isFinite(value) && Number(value) > 0 ? Math.round(Number(value)) : undefined;
}

function imageTypeFromUrl(url: string): string | undefined {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  return undefined;
}

function hasUnsupportedSocialImageExtension(url: string): boolean {
  return /\.(?:avif|svg)$/i.test(new URL(url).pathname);
}

export function brandSocialImage(
  altJa = "TECH Dashboard のレーダー型ブランド画像",
  altEn = "TECH Dashboard radar brand image",
): SocialImageMetadata {
  return {
    url: SOCIAL_IMAGE_URL,
    altJa,
    altEn,
    type: SOCIAL_IMAGE_TYPE,
    width: SOCIAL_IMAGE_WIDTH,
    height: SOCIAL_IMAGE_HEIGHT,
  };
}

export function articleSocialImage(
  image: ArticleImageInput | null | undefined,
  titleJa: string,
  titleEn: string,
): SocialImageMetadata {
  const sourceImageUrl = absoluteHttpUrl(image?.src);
  if (!sourceImageUrl || hasUnsupportedSocialImageExtension(sourceImageUrl)) {
    return brandSocialImage(
      "元記事画像が未収録の記事に使用する TECH Dashboard のブランド画像",
      "TECH Dashboard brand image for an article without a source image",
    );
  }

  return {
    url: sourceImageUrl,
    altJa: `「${titleJa}」の元記事画像`,
    altEn: `Source image for "${titleEn}"`,
    type: imageTypeFromUrl(sourceImageUrl),
    width: positiveDimension(image?.width),
    height: positiveDimension(image?.height),
  };
}

export interface ArticleMetadataTitleInput {
  title: string;
  lang: MetadataLanguage;
  sourceLabel: string;
  categoryLabel: string;
  publishedAt: string;
  sourceUrl: string;
  identityDiscriminator?: string;
}

function buildLocalizedArticleMetadataTitle(
  input: ArticleMetadataTitleInput,
  preserveSourceTitle: boolean,
): string {
  const hasJapaneseScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const rawTitle = input.title.trim();
  const languageSafeTitle = !preserveSourceTitle
    && input.lang === "en"
    && hasJapaneseScript.test(rawTitle)
    ? ""
    : rawTitle;
  const fallbackTitle = input.lang === "ja"
    ? `${input.sourceLabel}の${input.categoryLabel}更新`
    : `${input.categoryLabel} update from ${input.sourceLabel}`;
  const title = languageSafeTitle || fallbackTitle;
  const parsedPublishedAt = new Date(input.publishedAt);
  const publishedLabel = Number.isFinite(parsedPublishedAt.getTime())
    ? parsedPublishedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "publication time unavailable";
  let sourceDiscriminator = "";
  if (!languageSafeTitle) {
    try {
      const pathname = new URL(input.sourceUrl).pathname;
      const lastSegment = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "");
      const isOpaqueId = /^[a-f0-9]{8,}$/i.test(lastSegment);
      if (
        lastSegment.length >= 2
        && lastSegment.length <= 48
        && !isOpaqueId
        && (
          lastSegment.includes("/")
          || /(?:^|[-_])v?\d+(?:\.\d+)+/i.test(lastSegment)
        )
      ) {
        sourceDiscriminator = lastSegment;
      }
    } catch {
      sourceDiscriminator = "";
    }
  }
  const sourceCharacters = Array.from(input.sourceLabel);
  const boundedSourceLabel = sourceCharacters.length > 20
    ? `${sourceCharacters.slice(0, 19).join("")}…`
    : input.sourceLabel;
  const baseIdentity = languageSafeTitle
    ? `${boundedSourceLabel} | ${publishedLabel}`
    : sourceDiscriminator || publishedLabel;
  const identityDiscriminator = truncateMetadataPart(
    input.identityDiscriminator ?? "",
    48,
  );
  const identity = identityDiscriminator
    ? `${baseIdentity} | ${identityDiscriminator}`
    : baseIdentity;
  const separator = " | ";
  const titleCharacters = Array.from(title);
  const boundedTitle = identityDiscriminator
    ? truncateMetadataPart(
        title,
        Math.max(1, 120 - Array.from(`${separator}${identity}`).length),
      )
    : !preserveSourceTitle && titleCharacters.length > 64
      ? `${titleCharacters.slice(0, 63).join("")}…`
      : title;
  return `${boundedTitle} | ${identity}`;
}

export function localizedArticleMetadataTitle(
  input: ArticleMetadataTitleInput,
): string {
  return buildLocalizedArticleMetadataTitle(input, false);
}

export function localizedPendingArticleMetadataTitle(
  input: ArticleMetadataTitleInput,
): string {
  return buildLocalizedArticleMetadataTitle(input, true);
}

export function localizedArticleMetadataDescription(input: {
  summary: string;
  lang: MetadataLanguage;
  sourceLabel: string;
  categoryLabel: string;
}): string {
  const summary = input.summary.trim();
  if (summary) return boundedSocialDescription(summary, input.lang);
  return input.lang === "ja"
    ? `${input.sourceLabel}が公開した${input.categoryLabel}の記事です。タイトル、公開日、カテゴリ、元記事へのリンクを確認できます。`
    : `An article from ${input.sourceLabel} in ${input.categoryLabel}. Review its title, publication date, category, and original-source link.`;
}

function truncateMetadataPart(value: string, limit: number): string {
  const characters = Array.from(value.trim());
  if (characters.length <= limit) return characters.join("");
  if (limit <= 1) return "…";
  return `${characters.slice(0, limit - 1).join("")}…`;
}

export function localizedPendingArticleMetadataDescription(input: {
  title: string;
  lang: MetadataLanguage;
  sourceLabel: string;
  categoryLabel: string;
}): string {
  const sourceLabel = truncateMetadataPart(input.sourceLabel, 36)
    || (input.lang === "ja" ? "収集元" : "source");
  const categoryLabel = truncateMetadataPart(input.categoryLabel, 36)
    || (input.lang === "ja" ? "技術" : "technology");
  const rawTitle = input.title.trim();
  if (!rawTitle) {
    return input.lang === "ja"
      ? `AI 要約は準備中です。${sourceLabel}が公開した${categoryLabel}の記事です。`
      : `AI summary pending for an article from ${sourceLabel} in ${categoryLabel}.`;
  }

  const buildDescription = input.lang === "ja"
    ? (title: string) =>
        `AI 要約は準備中です。「${title}」は${sourceLabel}が公開した${categoryLabel}の記事です。`
    : (title: string) =>
        `AI summary pending. "${title}" comes from ${sourceLabel} in ${categoryLabel}.`;
  const titleBudget = SOCIAL_DESCRIPTION_CHARACTER_LIMIT
    - Array.from(buildDescription("")).length;
  return buildDescription(truncateMetadataPart(rawTitle, Math.max(1, titleBudget)));
}

export function createLocalizedPageMetadata(input: {
  canonicalUrl: string;
  type: LocalizedPageMetadata["type"];
  titleJa: string;
  titleEn: string;
  descriptionJa: string;
  descriptionEn: string;
  image: SocialImageMetadata;
  socialTitleJa?: string;
  socialTitleEn?: string;
}): LocalizedPageMetadata {
  const canonicalUrl = new URL(input.canonicalUrl, SITE_URL).toString();
  return {
    canonicalUrl,
    socialUrlJa: localizedSocialUrl(canonicalUrl, "ja"),
    socialUrlEn: localizedSocialUrl(canonicalUrl, "en"),
    type: input.type,
    titleJa: input.titleJa,
    titleEn: input.titleEn,
    socialTitleJa: input.socialTitleJa ?? input.titleJa,
    socialTitleEn: input.socialTitleEn ?? input.titleEn,
    descriptionJa: input.descriptionJa,
    descriptionEn: input.descriptionEn,
    image: input.image,
  };
}

export const HOME_PAGE_METADATA = createLocalizedPageMetadata({
  canonicalUrl: `${SITE_URL}/`,
  type: "website",
  titleJa: HOME_TITLE_JA,
  titleEn: HOME_TITLE_EN,
  descriptionJa: HOME_DESCRIPTION_JA,
  descriptionEn: HOME_DESCRIPTION_EN,
  image: brandSocialImage(),
});
