/**
 * 手動 AdSense ユニットの slot ID 設定。
 *
 * 承認フローとの関係 (2026-08-08 設計):
 * - AdSense の審査承認後、管理画面「広告 > 広告ユニットごと」でディスプレイ
 *   広告ユニットを作成し、発行された数値 slot ID をここへ貼るだけで有効化される。
 * - 空文字列の間は AdSlot コンポーネントが一切マークアップを描画しない
 *   (審査中・未承認の状態では空白スペースすら出ない)。
 * - 描画後も、既存の opt-in 同意 (privacy-consent) が「許可」かつ本番ドメインの
 *   場合にだけ表示・読込される。同意なしでは <ins> は hidden のまま残り、
 *   AdSense script も読み込まれない (loadAdvertising 側の既存ゲート)。
 */

/** 記事詳細: AI 解説本文の下、関連記事の上。 */
export const ADSENSE_SLOT_ARTICLE_BOTTOM = "";

/** 月別 Archive: 記事一覧の下。 */
export const ADSENSE_SLOT_ARCHIVE_MONTH = "";

/**
 * slot ID として描画してよい値か。AdSense の slot ID は数値列 (実運用では
 * 10 桁)。プレースホルダや貼り間違い (URL・空白・"ca-pub-…" など) を
 * fail-closed で弾く。
 */
export function isRenderableAdSlotId(value: string): boolean {
  return /^\d{6,12}$/.test(value);
}
