# 変更履歴

TECH Dashboard の利用者向け機能、データ契約、収集・公開基盤に関する主要な変更を記録します。
毎時生成されるデータのみの更新、表記修正、内部整理は原則として省略します。

## 運用ルール

- 未リリースの変更は `Unreleased` に追記します。
- `main` へ反映する際に日付付きセクションへ移します。
- 利用者向け UI、データ schema・taxonomy、Publisher・Worker の運用契約を変更した場合は同じ変更単位で更新します。
- このファイル導入前の詳細な履歴は Git の commit と pull request を参照してください。

## Unreleased

### 追加

- 日本語・英語の要約やタイトルが片言語だけ利用できる場合に、表示言語の出典を明示する共通 fallback 表示を追加しました。
- 日次サマリーと要約表示の品質契約を固定する unit test、responsive geometry を固定する E2E を追加しました。

### 変更

- Home の Header、Hero、Ticker、Featured、Top 3 を再構成し、モバイル・タブレットでは本文幅を広げ、デスクトップでは Hero の左右比率と余白を調整しました。
- Ticker のカテゴリ・タグと記事タイトルを 2 行へ分離し、Spotlight と同じ記事の重複表示を除外しました。
- Top 3 は重複した出典情報を整理し、記事固有の要約を残して判断材料と表示密度を両立させました。
- 記事詳細の要約、言語 provenance、外部記事への導線を整理しました。
- 当日の JST 集計と過去日の archive-backed 統計を分離し、日次・カテゴリ推移の表示契約を揃えました。
- Research を含む taxonomy、source filter、live/archive の tag・stats 同期を更新しました。
- 2 件以上の記事で使われるタグだけを静的ページ化し、低頻度タグは完全一致のタグ検索から対象記事へ戻れるようにしました。

### 修正

- 狭い viewport で Header control や記事パネルが見切れ、不要な横スクロールや過度な折り返しが発生する問題を修正しました。
- Featured thumbnail とカード幅の不一致、画像周辺の不要な余白を修正しました。
- 要約品質、タイトル言語、body retention、live/archive metadata の不整合を修正しました。
- Publisher runtime fingerprint を現行の生成契約へ同期しました。
- Pagefind を含む本番 Web build が CI job 全体の時間上限で中断されないよう、品質 gate の実行上限を調整しました。
- Web build の開始時に古い `dist` を削除し、廃止した静的ルートが成果物へ残らないようにしました。
- 共有されたタグ検索 URL の大文字小文字やアクセント表記が異なっても、完全一致の対象記事を回収できるようにしました。
