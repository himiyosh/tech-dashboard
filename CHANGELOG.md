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

- Publisher が実英語要約から安全に導出できる `titleEn` を publish 前に自動補完し、日本語コミュニティ記事の英語表示で原題 fallback が連続する状態を減らすようにしました。
- 検索は authority・importance・鮮度の後段ランキングを適用する前に十分な候補を確認し、同日の完全一致記事が古い候補の後ろに隠れにくくなりました。Spotlight は「最新」ではなく実際の優先度を示す表現へ統一し、記事詳細の原題言語ラベルを H1 本文から分離しました。
- 要約待ちカードを Status / Footer と同じ Queue・収集状態契約へ統一し、個別記事の準備待ちと全体 Queue の稼働を分け、停止中は解消目安を表示しないようにしました。Status の AI 要約可用性には公開スナップショットの観測時刻を明示し、記事詳細では固定 Footer が要約のみの案内を覆わないようにしました。
- Home の Header、Hero、Ticker、Featured、Top 3 を再構成し、モバイル・タブレットでは本文幅を広げ、デスクトップでは Hero の左右比率と余白を調整しました。
- Ticker のカテゴリ・タグと記事タイトルを 2 行へ分離し、Spotlight と同じ記事の重複表示を除外しました。
- Ticker は同一 source と配信 platform を各 2 件までに抑え、要約済み・重要度・source authority・配信形式を基準に構成するようにしました。要約待ちは Ticker 内で明示し、Home と meta description は community source を含む収集範囲と「毎時 1 バッチ、各 source 約 6 時間周期」という実運用へ統一しました。
- Top 3 は重複した出典情報を整理し、記事固有の要約を残して判断材料と表示密度を両立させました。
- 記事詳細の要約、言語 provenance、外部記事への導線を整理しました。
- 当日の JST 集計と過去日の archive-backed 統計を分離し、日次・カテゴリ推移の表示契約を揃えました。
- Daily Summary の 7 日グラフとカテゴリ概要を小型化し、表示時に一度だけ立ち上がる棒グラフモーションと reduced-motion 対応を追加しました。
- 要約 Queue の未使用枠を AI 解説本文の生成へ動的に配分し、生成済み本文を次回 Publisher で優先的に取り込みつつ、pending と通常候補を合わせた本文 lookup を 1 run の上限内に収めるようにしました。
- Status と footer に要約・AI 解説本文の Queue mode、backlog、共有生成枠を表示し、run 停止中の ETA を再開待ちへ置き換えました。記事詳細では要約待ちと本文の収録済み・Queue 投入済み・要約のみを別の状態として識別できます。
- Research を含む taxonomy、source filter、live/archive の tag・stats 同期を更新しました。
- 2 件以上の記事で使われるタグだけを静的ページ化し、低頻度タグは完全一致のタグ検索から対象記事へ戻れるようにしました。
- 共通 canvas と左 Sidebar の有効幅を広げ、Home と Status の右 rail を中間幅まで段階的に維持する responsive layout へ変更しました。
- Trending Topics と Most Active Sources に順位、件数、カテゴリ、相対量を加え、狭い rail でも比較しやすい視覚階層へ変更しました。
- Status を pipeline run、収集失敗、掲載量、Queue の状態別に再構成し、低活動を障害 alert と区別できる source directory と filter に変更しました。run telemetry が未記録の場合は、エラー 0 件ではなく記録なしと表示します。
- Status の見出しから重複する運用値を除き、run 依存の Queue 待機を中立表示にしました。共有生成枠の未観測理由と、登録・評価可能・未収録 source の母集団も明示しました。
- Publisher の統計を差分更新から、immutable baseline の live index と全 archive を使う完全再構築へ変更しました。

### 修正

- Publisher、PR CI、pre-push の検証で同じ静的サイトを二重 build せず、直前に検証済みの `web/dist` を Playwright preview へ再利用するようにし、E2E 開始前の build timeout を防ぎました。
- Status の全 source が最近掲載済みの場合も、初期表示件数を 0 件ではなく実際の表示件数へ一致させました。
- Source disclosure の固定パネルが閉じた状態でも残る問題を修正し、開閉・再表示・キーボード操作を回帰テストで固定しました。
- Timeline の `arXiv moved` 表記を、arXiv 専用ページへのリンクと分離先が分かる説明へ置き換えました。
- 当日・前日に掲載記事がない場合も、Featured と重複しない最新掲載日の記事を Ticker に表示するようにしました。
- 901〜1100px の中間幅で Sidebar のカテゴリ名が詰まる問題を修正し、右 rail の有無にかかわらず同じ幅契約を適用しました。
- `/search?q=` と `/search/?q=` のどちらでも query と検索結果が一致することを回帰テストで固定しました。
- 存在しない記事・カテゴリ・タグ URL が Home を HTTP 200 で返す soft-404 を廃止し、検索・アーカイブ・Home の回復導線を持つ専用 404 ページを追加しました。
- 狭い viewport で Header control や記事パネルが見切れ、不要な横スクロールや過度な折り返しが発生する問題を修正しました。
- Featured thumbnail とカード幅の不一致、画像周辺の不要な余白を修正しました。
- 要約品質、タイトル言語、body retention、live/archive metadata の不整合を修正しました。
- Publisher runtime fingerprint を現行の生成契約へ同期しました。
- Pagefind を含む本番 Web build が CI job 全体の時間上限や大量の静的 route log、長時間の無出力で中断されないよう、品質 gate の実行上限と Astro build のheartbeatを調整しました。
- Web build の開始時に古い `dist` を削除し、廃止した静的ルートが成果物へ残らないようにしました。
- 共有されたタグ検索 URL の大文字小文字やアクセント表記が異なっても、完全一致の対象記事を回収できるようにしました。
- Linux のフォントメトリクスでも中間幅の Hero と固定 Footer が過度に伸びず、優先記事と重ならないようにしました。
- archive index baseline が `null`、`false`、`0` などの非 object JSON でも欠落扱いされる経路を廃止し、存在する baseline を必ず fail-closed で検証するようにしました。
