import { describe, expect, it } from "vitest";
import {
  ADSENSE_SLOT_ARCHIVE_MONTH,
  ADSENSE_SLOT_ARTICLE_BOTTOM,
  isRenderableAdSlotId,
} from "../web/src/lib/ad-slots.ts";
import { shouldLoadAdvertising } from "../web/src/lib/privacy-consent.ts";
import { SITE_URL } from "../web/src/lib/site.ts";

describe("ad slot configuration", () => {
  it("設定済み slot ID は数値列のみ描画対象になる", () => {
    expect(isRenderableAdSlotId("1234567890")).toBe(true);
    expect(isRenderableAdSlotId("123456")).toBe(true);
  });

  it("プレースホルダ・貼り間違いは fail-closed で弾く", () => {
    expect(isRenderableAdSlotId("")).toBe(false);
    expect(isRenderableAdSlotId("TODO")).toBe(false);
    expect(isRenderableAdSlotId("ca-pub-3044810068333301")).toBe(false);
    expect(isRenderableAdSlotId(" 1234567890")).toBe(false);
    expect(isRenderableAdSlotId("1234567890123")).toBe(false); // 13 桁は範囲外
    expect(isRenderableAdSlotId("12345")).toBe(false); // 短すぎ
  });

  it("設定値は空 (未承認) か描画可能な形式のどちらかである", () => {
    // 中途半端な値 (貼りかけ・typo) を commit すると、審査中に壊れた <ins> を
    // 出すか、承認後に黙って無表示になる。どちらの定数も常にこの不変条件を守る。
    for (const value of [ADSENSE_SLOT_ARTICLE_BOTTOM, ADSENSE_SLOT_ARCHIVE_MONTH]) {
      expect(value === "" || isRenderableAdSlotId(value)).toBe(true);
    }
  });

  // cross-file contract pin: revealAdSlots (privacy-consent-client) はこの
  // 述語をそのまま表示条件に使う。真理値表自体は web-privacy-consent.test.ts
  // にもあるが、広告ユニット側から見た契約として重複を承知で固定する
  // (実挙動は tests/e2e/smoke.spec.ts の ad slot ゲートテストが担保)。
  it("広告は本番ドメインかつ同意「許可」のときだけ有効になる", () => {
    const production = new URL(SITE_URL).hostname;
    expect(shouldLoadAdvertising(production, "allowed")).toBe(true);
    expect(shouldLoadAdvertising(production, "denied")).toBe(false);
    expect(shouldLoadAdvertising(production, "undecided")).toBe(false);
    // preview / pages.dev / localhost は同意があっても読み込まない
    expect(shouldLoadAdvertising("tech-dashboard.pages.dev", "allowed")).toBe(false);
    expect(shouldLoadAdvertising("127.0.0.1", "allowed")).toBe(false);
    expect(shouldLoadAdvertising("localhost", "allowed")).toBe(false);
  });
});
