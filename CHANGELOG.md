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

- production Web buildを1回だけ再利用し、desktop/mobileのHome判断面、検索、RSS/OPML購読発見、実404回復、optionalな要約待ち状態をローカル計測するPlaywrightジャーニーを追加しました。出力はstep条件・操作上限・document navigation列・viewport/scroll・route・失敗観測と、現行runだけの情報値である経過msを含む64KiB以下のJSONです。合否は到達性と複雑度だけで判定し、timingの履歴baseline保存、過去比較、delta警告・失敗は行いません。
- site-wide RSS、全カテゴリRSS、arXiv RSS、Knowledge RSSを重複なく一括購読できる静的`/feeds.opml`を追加しました。AboutのJA/EN購読actionと全ページのOPML autodiscoveryから利用でき、JSON FeedはRSSとしてbundleへ含めません。
- Knowledge専用レーンへ静的な`/rss/knowledge.xml`、ページ固有のRSS autodiscovery、JA/ENの購読actionを追加しました。feedはKnowledge画面と同じ公開可能なevergreen記事だけを、既存RSSの順序・上限・XML安全契約で配信します。
- Searchでcold tierの記事をtitleまたはtagから回収し、個別detail routeを復活させず、canonical URL由来のstable anchorを持つ月別Archiveへ遷移できるようにしました。結果は既存Pagefindのexact/category/tag/rankingへ追加的に合成し、JA/EN、source authority、一致理由を維持します。
- arXiv専用レーンへ静的な`/rss/arxiv.xml`、ページ固有のRSS autodiscovery、JA/ENの購読actionを追加しました。feedはHTMLレーンと同じarXiv membershipと公開可能要約の判定を使い、Research RSSにはarXivを戻しません。autodiscoveryのRSS名は各feed固有、JSON Feed名はsite-wideと明示します。
- live/warm の記事詳細、カテゴリ・タグ・月別 Archive と各ページネーションを実際の静的 route 生成条件から列挙する `/sitemap.xml` と、canonical Sitemap directive を持つ `/robots.txt` を追加しました。sitemap は重複・外部・query URL を拒否し、50,000 URL / 50 MB の上限を build 時に fail-closed で検証します。
- Homeと記事詳細へJA/EN別のOpen Graph・Twitter Card metadataとHomeのWebSite構造化データを追加しました。元記事画像が無い記事はrepository-ownedの1200x630 PNGを使用し、`?lang=en`ではPages Functionが静的本文を維持したままcrawler向けheadを英語へ局所化します。
- 日本語・英語の要約やタイトルが片言語だけ利用できる場合に、表示言語の出典を明示する共通 fallback 表示を追加しました。
- 日次サマリーと要約表示の品質契約を固定する unit test、responsive geometry を固定する E2E を追加しました。
- AI 要約待ちの記事へ、収集元の抜粋を「AI 要約ではない」と明示して表示し、元記事を開く前にも内容を判断できるようにしました。
- 検索結果へカテゴリ・タグ・タイトル・source・要約の一致理由、source authority、検索順位の比較基準を追加しました。
- 表示言語 (JA/EN) を `?lang=` の URL query として保持し、EN に切り替えて共有した記事・検索・カテゴリ URL がローカルストレージのない新しいブラウザでも EN を再現できるようにしました。日本語は既定のまま URL に param を付けません。
- About と Status に GitHub Issues への「問題を報告」導線と、稼働状態が ERR の場合の切り分けガイダンス (収集遅延は不具合ではなく、長時間の ERR や誤分類・翻訳欠落・壊れたリンクを報告対象とする案内) を追加しました。
- Status に、匿名いいね機能 (D1 binding・識別子署名用シークレット・Turnstile 検証シークレット・Turnstile 公開サイトキー) の設定状態を確認できる「匿名いいねの設定状態」カードを追加しました。値そのものは一切表示せず、boolean のみを返す読み取り専用 `GET /api/reactions/config` を progressive enhancement で読み、「設定済み / Configured」「未設定 / Not configured (未設定の項目を列挙)」「確認できません / Check unavailable (endpoint 未到達)」の 3 状態を区別して表示します。いずれも安全に degrade する任意機能として neutral tone で表示し、ERR/WARN 相当の色は使いません。
- bilingual `/privacy/`、version付きの明示的な広告opt-in、production custom-domain限定のAdSense gate、local設定消去、current-browser匿名いいね削除を追加しました。未選択・未知・壊れた・旧version・preview/pages.devはfail-closedで広告OFFとなり、閲覧・検索・Archive・RSS・JSON Feedは同意なしで利用できます。
- Google AdSenseのpublisher identityからauthorized seller recordを生成するroot `/ads.txt`を追加し、ID形式をbuild時にfail-closedで検証するようにしました。

### 変更

- body Queueの単一記事で本文生成が繰り返し失敗してもservice全体を503にせず、entry warningとruntime failureを分離するようにしました。missing KV bindingは例外ではなく構造化JSON 503を返します。
- 通常PRを`working branch -> develop`、production releaseを`develop -> main`へ分離し、CIが誤ったbase/headをfail-closedに拒否するbranch-flow gateを追加しました。default branchとPublisher/Pages production branchはmainのまま維持し、releaseはmerge commitでancestryを保ちます。
- 毎時Publisherを変更data・route impact・schema・CASの増分gateへ分離し、全Astro/Pagefind/E2E reconciliationを毎日02:17 UTC・manual・PR CIへ移しました。impact manifestは変更detail/body IDと、pagination/category/tag/feed/sitemap/search/global shellの波及を記録し、unrelated historical detailをGitHub Actionsで毎時再renderしません。
- Fully-free incremental servingの第2段階として、既存Astro detail pageをroute単位でJA/ENのcontent-addressed HTMLへpre-renderし、専用R2/D1 shadow generationへ手動dual-publishできる無効既定の経路を追加しました。production Pages、custom domain、scheduled Publisherは変更せず、detail-only coverage、traffic未観測、budget超過ではcutoverをfail-closedに拒否します。
- staleな3,200 HTML route上限を撤去し、Cloudflare Freeの20,000 static filesから余裕を引いた18,000 files、18分build、RSS、route-family growth、crawl/detail parityのprovider-aligned gateへ置き換えました。productionはPages Git Integrationを維持し、Healthはcommitted indexとpublic metrics snapshotの一致を検証します。
- Knowledgeはsource-levelのevergreen retentionを候補母集団として維持しつつ、raw title/snippet/source contextの共有契約で提供開始・一般提供・preview・月次告知・award・event登録などの告知専用記事を除外するようにしました。告知形式のtitleでもsetup、API parameter、CLI運用などの具体的なprocedural evidenceを持つ記事は維持します。Timeline、カテゴリ、検索、Archive、canonical URL、要約、AI解説本文は維持し、Knowledge HTMLとKnowledge RSSだけを同じ適格性契約へ揃えます。
- Knowledgeのfresh entryは、掲載可否の判定とartifactへ保存するraw source contextを同じ800文字上限から導出するようにしました。判定根拠が旧280文字境界より後ろにあるGoogle Cloud告知でもPublisher gateが再現でき、lossyなprior/archive restampは保存済みの除外を具体的なprocedural evidenceなしに解除しません。
- RSSとJSON Feedの各記事へ、reader-facingな出典名、出典区分、重要度、検証済み要約をまとめた短いdecision digestを追加しました。JSON Feedは標準の`summary`と`content_text`へ同じ内容を出し、既存のprivate extension、記事集合、順序、上限、canonical URLは維持します。
- remote summary cacheの反映で記事が要約待ちから公開可能へ変わっても、全addressable detailのJA/EN metadata titleが重複しないようにしました。同じ原題・source表示名・公開時刻が衝突する場合だけ、既存のsource URL pathを事実ベースの識別子として付与し、canonical URLとsource provenanceは維持します。要約Queueもfinal entry集合から1回だけ候補を選び、その同じsnapshotを送信・healthへ保存するため、実送信7件とfinal候補6件のようなstage混在を防ぎます。
- sparseまたはtitle-onlyのsource inputでは十分な収集元contextがない限りAI要約・解説本文を生成せず、公式title/snippetから決定論的に抽出できる料金plan・対象地域・価格/決済、または既存productのnamed platform展開と矛盾する生成結果をsummary/body cache、Publisher、sidecarの全経路で拒否するようにしました。United Statesの略記と英語の代名詞`us`を区別し、先行platformの言い回しやsnippet切り詰めでも既知のplatform展開hallucinationを準備待ちへ戻します。不合格cacheは再生成対象へ戻し、記事は収集元の抜粋を伴う準備待ち状態に留まります。
- AI要約待ちの記事は、画面上の原題をHTML title・Open Graph・Twitter Card・構造化データへ揃え、要約未生成をdescriptionへ明示するようにしました。長い原題でも160文字以内に原題の先頭、出典、カテゴリ、準備中状態を残し、要約済み記事のmetadata、canonical URL、出典情報は従来どおり維持します。
- Categoriesのcompact directory、arXivのsource filter・Cards/Compact切替、Home・カテゴリ・arXivのCards/Compact両表示の記事linkをmobileで45px以上の操作面に揃え、375px/390pxでも横overflowや操作密度を崩さないようにしました。
- PrivacyのJA/EN説明へCloudflare Web Analytics (RUM)を明記し、任意のAdSense同意とは独立して通常閲覧時に性能・request情報がCloudflareへ送信される場合があること、保持とcontrolはCloudflareのpolicyに従うことを公開しました。カテゴリRSSの案内も実装済みの`/rss/<category>.xml`へ訂正しました。
- PR CIでexact-head独立レビューgateを独立jobとして実行し、marker待ちでもunit・typecheck・Web build・E2Eを継続できるようにしました。event由来のPR番号・head、REST由来のcurrent open state、repository ownerかつ`author_association=OWNER`の投稿者境界、外部reviewer session、統括session、厳格なmarkerをfail-closedで検証します。closed済みPRのhistorical rerunだけはREST state確認後にskipし、open PRのmarker投稿後は同一headのfailed runを再実行します。CI成功後もmerge直前のlocal gateは必須です。
- 初回の広告同意promptを全viewportで通常flow内のcompact stripへ変更し、Spotlight・Top 3・記事詳細・Search・focus可能なcontrolを覆わないようにしました。Google AdSenseが任意であること、拒否しても全機能を利用できること、外部mediaは別に読み込む場合があることを維持し、JA/ENの許可・拒否・プライバシー詳細controlは45px以上の操作面と具体的なaccessible nameを持ちます。別tabで広告選択が未決定へ戻った場合や言語切替でstrip高が変わった場合も、開いているSearchをstripの下へ再配置します。同意未決定のdesktopではFooterを通常flowへ戻し、Top 3のsource controlを覆わないようにします。決定後は既存の固定Footerへ復帰します。
- AboutのMenu説明とPageHeroでRSS/JSON Feed購読を明示し、カテゴリRSSを含む購読actionだけをmobileでも44px以上の操作面で表示するようにしました。mobileではHero説明文より購読actionを優先し、既存metricと他のPageHero action契約は維持します。
- カテゴリ画面の RSS link と autodiscovery を、query を無視する全体 feed から静的な `/rss/<category>.xml` へ変更しました。各 feed は該当カテゴリのAI要約済み記事だけを最大100件配信し、全体 `/rss.xml` は従来どおり維持します。
- RSS autodiscoveryを維持したまま、JSON Feedのalternate linkをendpointと同じ標準MIME type `application/feed+json`へ揃えました。
- JSON Feedの本文とautodiscoveryを維持したまま、Cloudflare Pagesの`/feed.json`配信を標準MIME type `application/feed+json`へ揃え、production health checkでMIME driftを検出するようにしました。
- Home の Spotlight と Top 3 は、異なる source が同じモデル発表を扱う場合も1つの話題として重複を抑え、別の重要更新を判断枠へ補充するようにしました。
- Categories の Research overview で、arXiv を除くキュレーション Research と専用 arXiv 論文レーンの件数・移動先を分けて表示し、両方へ直接移動できるようにしました。
- 外部 Google Fonts の render-blocking stylesheet と多数の日本語font requestを廃止し、OS標準のsans-serif stackへ切り替えました。文字情報とアクセシビリティtreeを維持しながら、mobile LCPと初期network負荷を削減します。
- 匿名いいねのcurrent-browser削除をTurnstile設定から分離し、same-origin DELETEがD1の票・rate-limit行とHttpOnly cookieを冪等に削除できるようにしました。privacy disclosureにはURL-visibleな言語・検索query、外部media、保持期間、第三者serviceを実装どおり明記します。
- 匿名いいねにactive identity rowと`article_likes(voter_hash)` indexを追加し、identity確認、rate-limit、票変更を同一D1 transactionへまとめました。current-browser DELETEと並行するPUTは削除済みidentityの票・rate-limit行を再生成できません。
- cold / dropped の記事カードは存在しない内部 detail route ではなく canonical source URL を開くようにし、hot / warm は従来どおり内部 detail を使います。新しいタブで開く source link は共有 `noopener noreferrer nofollow`、共通の `↗`、表示言語別の読み上げ補足を持ちます。production build は sitemap URL と生成済み canonical HTML の双方向 parity、redirect-only 除外、標準 HTML parser が抽出した実要素の href を各 HTML の canonical route 基準で解決し、全内部 detail link が実在することを fail-closed で検証します。
- 記事詳細の「タイトルと URL をコピー」は EN 表示時に `?lang=en` を含む URL を共有できるようにし、共有相手が別ブラウザで開いても表示言語が一致するようにしました。
- Publisher が実英語要約から安全に導出できる `titleEn` を publish 前に自動補完し、日本語コミュニティ記事の英語表示で原題 fallback が連続する状態を減らすようにしました。
- 毎時 Publisher は生成データに関係する Home・記事詳細・metrics・Archive・404 の専用 E2E を実行し、全 UI 回帰は PR CI で維持するようにしました。成功した Publisher の完了後は Worker Health を自動確認します。
- Publisher は収集開始前、data commit直前、Queue/KV effects送信直前にFree bridgeのpublisher fingerprintを確認し、rollout不一致時にdataだけを先行公開しないようにしました。
- PR CI は unit・typecheck と Web build を独立jobに分け、runner中断後に失敗したbuildだけを再実行できるようにしました。
- 大規模な静的Web buildとPlaywright、毎時Publisherは、公開repository向けのUbuntu 24.04 ARM runnerで実行するようにしました。
- Astro の静的ページ生成をlocal/Cloudflareでは2並列、16GB GitHub runnerでは1並列へ変更し、phase別 CPU/RSS・route/file数をbounded telemetryとして記録するようにしました。低頻度tagはexact searchへ送って静的生成量を抑え、route/file数はprovider-aligned budgetとfamily telemetryで監視します。
- Astro childのV8 old-spaceを512MiBへ制限し、detail route生成中の一時objectを小さい世代で回収するようにしました。V8 heap・external・arrayBuffers・route進捗とprocess tree RSSを継続計測し、GitHub Actionsでは12,000MiBのRSS上限を超えるbuildをfail-closedにします。
- Archive は閲覧可能な要約付き履歴と、live収録時点のhot統計snapshotを含む保存行を分けて表示し、All-time・月別・metrics APIの母集団を明示するようにしました。
- モバイル記事詳細の「トップに戻る」ボタンを下部tabbarの上へ配置し、スクロール後も操作できるようにしました。
- 収集後に別公式ブログへ移転した既知記事は、canonical publisher・元記事URL・検索metadataを移転先へ揃え、収集元feedを記事詳細へ別表示するようにしました。
- 記事詳細の前後記事を関連記事カードから除外し、同じリンクが連続して重複表示されないようにしました。
- Archiveのwarm記事は保持契約どおり内部detail routeを生成し、cold記事は存在しないdetail pageではなく元記事へ直接遷移するようにしました。
- 公開日補正で月が変わった同一記事をArchive全月で1件へreconcileし、月別件数・All-time・statsの重複加算を防ぐようにしました。
- 検索は authority・importance・鮮度の後段ランキングを適用する前に十分な候補を確認し、同日の完全一致記事が古い候補の後ろに隠れにくくなりました。Spotlight は「最新」ではなく実際の優先度を示す表現へ統一し、記事詳細の原題言語ラベルを H1 本文から分離しました。
- 要約待ちカードを Status / Footer と同じ Queue・収集状態契約へ統一し、個別記事の準備待ちと全体 Queue の稼働を分け、停止中は解消目安を表示しないようにしました。Status の AI 要約可用性には公開スナップショットの観測時刻を明示し、記事詳細では固定 Footer が要約のみの案内を覆わないようにしました。
- Home の Header、Hero、Ticker、Featured、Top 3 を再構成し、モバイル・タブレットでは本文幅を広げ、デスクトップでは Hero の左右比率と余白を調整しました。
- Header、breadcrumb、Hero、Ticker、本文、Footer の共通 gutter を揃え、1280px 前後の Categories とカテゴリ詳細で主カラム幅・左 rail 位置が切り替わらないようにしました。タブレットでは主要 shortcut 名と 44px 操作面を維持します。
- Ticker のカテゴリ・タグと記事タイトルを 2 行へ分離し、Spotlight と同じ記事の重複表示を除外しました。
- Ticker は同一 source と配信 platform を各 2 件までに抑え、要約済み・重要度・source authority・配信形式を基準に構成するようにしました。要約待ちは判断枠へ出さずTimelineに残し、Home と meta description は community source を含む収集範囲と「毎時 1 バッチ、各 source 約 6 時間周期」という実運用へ統一しました。
- Ticker は代替候補がある場合に同じ source を連続表示せず、Spotlight と Top 3 は重複する重要度・出典の説明を減らして要約済み候補とsource多様性を明示するようにしました。
- Top 3 は重複した出典情報を整理し、記事固有の要約を残して判断材料と表示密度を両立させました。
- 記事詳細の要約、言語 provenance、外部記事への導線を整理しました。
- 当日の JST 集計と過去日の archive-backed 統計を分離し、日次・カテゴリ推移の表示契約を揃えました。
- Daily Summary の 7 日グラフとカテゴリ概要を小型化し、表示時に一度だけ立ち上がる棒グラフモーションと reduced-motion 対応を追加しました。
- 要約 Queue の未使用枠を AI 解説本文の生成へ動的に配分し、生成済み本文を次回 Publisher で優先的に取り込みつつ、pending と通常候補を合わせた本文 lookup を 1 run の上限内に収めるようにしました。
- Status と footer に要約・AI 解説本文の Queue mode、backlog、共有生成枠を表示し、run 停止中の ETA を再開待ちへ置き換えました。記事詳細では要約待ちと本文の収録済み・Queue 投入済み・要約のみを別の状態として識別できます。
- 全 PageHero 指標へ母集団・期間・snapshot provenance を必須化し、arXiv、Glossary、Timeline・カテゴリ・タグのページ送りまで同じ説明契約へ統一しました。Archive の重複 KPI、無分母の peak 比率、カテゴリ/source 件数、Status の掲載閾値と生成枠、Knowledge の各source説明、Home右railの件数単位も具体化しました。
- `collectedAt` 基準の `NEW` を `新規収集 / INDEXED` へ変更し、記事の公開日時ではなくDashboardへの収録時刻を示す状態だと明確化しました。
- Research を含む taxonomy、source filter、live/archive の tag・stats 同期を更新しました。
- AWS ML Blogの一般QuickSight機能・BI運用記事・DeepRacer端末告知と、一般宇宙・防衛・副業案内・AI写真講評・indie game投資記事をAgent Frameworks / Tech Newsから除外し、正当なAI/ML・agentic engineering記事は維持するtitle-scope filterへ更新しました。
- actual title corpus に基づき、AWS Weekly Roundup、GeForce NOW・Logitech G Cloudなどのconsumer cloud gaming、Gemini Startup Forumの募集・cohort記事、一般software投資、connected-car cloud、臨床code predictionをTech News / Knowledge / Researchから除外し、source filterのkeep/drop契約を強化しました。
- GitHub Changelog と Google Developers Blog は feed 全体を Copilot / Gemini へ一括分類していたため、Xcode runner イメージ、SSO/Settings、secret scanning、Dependabot、Visual Studio Subscription、GitHub Code Quality、GHES、npm、Google Pay 決済・Sign in with Google セッションなど無関係な GitHub/Google プラットフォーム記事を Tech News へ再分類し、実 Copilot/Gemini 記事は維持する title/snippet ベースの分類ルールへ更新しました。`llm/llms`、`coding-agent/coding-agents`、`llm-agent/llm-agents`、`ai-model/ai-models`、`foundation-model/foundation-models`、`autonomous-agent/autonomous-agents`、`guardrail/guardrails` のタグ単数・複数ゆれも共通 alias で統一しました。既存 live/archive/stats は canonical URL 損失 0・body 損失 0 で migration 済みです。
- 品質監査にregistryの全evergreen sourceを母集団とする収集・stamp・両言語要約件数と、summary/body Queueのbacklog・candidate・実enqueue・lookup・merge・ETAを追加し、0 entry、stamp欠落、未観測値を省略または0件へnormalizationしないようにしました。既存artifactで同一runの共有enqueue合計から実body enqueueを安全に導出できる場合は、その値もmigrationで補完します。
- 10 件以上の記事で使われるタグだけをfull静的ページ化し、従来公開済みの2-9件tag URLは小さなnoindex recovery pageから完全一致検索へ戻れるようにしました。
- 共通 canvas と左 Sidebar の有効幅を広げ、Home と Status の右 rail を中間幅まで段階的に維持する responsive layout へ変更しました。
- Trending Topics と Most Active Sources に順位、件数、カテゴリ、相対量を加え、狭い rail でも比較しやすい視覚階層へ変更しました。
- Status を pipeline run、収集失敗、掲載量、Queue の状態別に再構成し、低活動を障害 alert と区別できる source directory と filter に変更しました。run telemetry が未記録の場合は、エラー 0 件ではなく記録なしと表示します。
- Status の見出しから重複する運用値を除き、run 依存の Queue 待機を中立表示にしました。共有生成枠の未観測理由と、登録・評価可能・未収録 source の母集団も明示しました。
- Status のAI解説本文Queueで、今回反映数、送信件数の未計測状態、ETAが基準にする1 runのenqueue上限を分けて表示しました。
- Status の共有生成枠を合計値と内訳へ分け、Footer のQueue表示をサイト全体の状態として明示し、個別記事の準備状態と区別しました。
- Publisher の統計を差分更新から、immutable baseline の live index と全 archive を使う完全再構築へ変更しました。
- 緊急Direct Uploadはcleanなmainと`origin/main`の一致をbuild前後・upload後に検証し、検証済みcommit SHAをdeploymentへ明示するようにしました。
- `tech-dashboard-harness`のWorker deploy直後にrelease verifierからの`/health`が旧fingerprintを返す場合に備え、`node scripts/verify-worker-deploy.mjs`によるbounded pollingで観測経路の安定収束を確認するようにしました。全edge PoPの収束証明ではなく、毎時の運用監視 (`npm run health:prod`) とPublisherの自動precondition確認は従来どおりimmediateかつfail-closedのままです。

### 修正

- evergreen記事のarchive行へsummaryが供給されない経路を塞ぎました。`selectArchiveUpdateEntries`は「今回変化したentryだけ」をarchiveへ流すため、変化のない安定したevergreen entryはarchive行が二度と更新されず、旧`compactArchiveEntry`に剥がされたsummaryが入らないまま残っていました (実測128件)。この状態でcapにevictされると、tierだけwarmへ昇格して「warmなのにsummary無し」という不正recordが生まれ、publisherのfail-closed検証を恒久停止させ得ました。evergreenは変化の有無に関わらず常にarchive更新対象へ含め、昇格側もbilingual summaryが揃っている行だけに限定します。data gateも、archive層が修復できない状態 (summary未供給のままevictされたhot行) では落ちないよう対象を限定しました。
- evergreen記事がlive indexのcap (`PER_SOURCE_CAP` / `CATEGORY_CAPS` / `INDEX_LIMIT`) でevictされた際に、全ての閲覧面から消える問題を修正しました。capはevergreenを考慮せず永久にevictするため、archive行はtier `hot`のまま凍結し、LL-044でsummaryを剥がされた状態で固定されていました。結果として月別Archive (summary必須) にも個別記事ページ (warm由来) にも現れず、`data/archive/{YYYY-MM}.json`にだけ存在する記事になっていました。archive書き出し時にevergreenのsummaryを保持し、liveから外れたevergreen行をwarmへ昇格するようにし、既に凍結していた78件はgit履歴のsummaryを復元してwarmへ戻しました (R-022)。
- Knowledgeの告知専用判定を、Gartner Magic Quadrantの評価記事、title途中の`Introducing`・`What's new`・`New Capabilities Announced`まで拡張しました。`Today, we're announcing`や一般的な`This post covers ... how you access it`という告知定型文は、保存済み除外をhow-toとして再採用する根拠にせず、具体的なsetup・API parameter・CLI手順は引き続き維持します。
- ResearchカテゴリRSSを、HTMLのResearch一覧と同じarXiv除外predicateへ接続しました。`/rss/research.xml`はキュレーションResearchだけを配信し、全体RSS・JSON Feed・他カテゴリRSS・専用arXivレーンは従来の母集団を維持します。
- PR merge の exact-head 独立レビュー gate が拒否した場合、valid・stale・wrong reviewer・self-issued・malformed marker と走査済み review/comment の件数を 1 行で診断できるようにしました。malformed は marker 形式の HTML comment を試みた本文だけを数え、`Independent-Review` / `INDEPENDENT-REVIEW` のような protocol 名の case variant も invalid clearance のまま malformed attempt として可視化し、通常の議論や script 名への言及は除外します。JSON・GitHub API・evidence normalization が結果生成前に失敗した場合は件数を生成しません。
- RSSの共有serializerはXML 1.0で許可される文字だけをcode point単位で保持し、NUL、禁止制御文字、孤立surrogate、U+FFFE/U+FFFFを除去してからentity escapeするようにしました。全体RSSとカテゴリRSSは同じfail-safe契約を使い、日本語とastral Unicode、TAB/LF/CRを維持します。
- mobileの購読action付きPageHeroは説明文を視覚的にだけ畳み、JA/ENのページ目的をHeroのaccessible descriptionとして支援技術へ残すようにしました。購読actionの44px操作面とcompactなHero高は維持します。
- モバイル・タブレットで Search を開いた際、固定された閉じるボタンが JA/EN 言語切替を覆いながら背面の言語ボタンが Tab・支援技術から到達できていた問題を修正しました。Search は実測した Header 下端の下へ配置し、短いタブレット画面では残りの viewport 高へ検索結果を収めて内部スクロールできるようにしました。閉じる・言語切替の44px操作面、focus復帰、言語切替、検索状態を維持します。
- 記事のJA/EN別social descriptionを160文字で機械的に切らず、収まる最長の完全文を優先し、`.NET`、`U.S.`、`Dr.`を誤った文末にせず、文境界が無い場合も単語・grapheme・HTML entityを壊さず省略記号を付けるようにしました。
- modal Menuを開いている間は背景documentのscroll位置を固定し、wheel・keyboard・touch操作で本文が動かないようにしました。Menu内の長いnavigationは引き続きscrollでき、閉じた後は元の位置とfocusを復元します。
- 初回訪問のモバイル表示で、広告同意promptを保存済み状態から初回paint前に配置し、本文全体が後から約205px移動するlayout shiftを防ぐようにしました。許可・拒否済み、Privacy画面、preview hostでは従来どおりpromptを表示しません。
- 本番の `/sitemap.xml` と `/sitemap-index.xml` が 404 で、robots.txt に Sitemap directive が無かったため、単一の standards-compliant sitemap を静的配信するよう修正しました。記事詳細と sitemap は同じ addressability policy を共有し、cold / dropped 記事は月別 Archive のみに残します。
- モバイルで開いた navigation sheet の top-layer backdrop が下部 tabbar の Menu 操作を遮る問題を修正しました。実際の Menu button を sheet の top layer へ一時的に移し、同じ位置・同じ操作面で閉じられるようにして、Escape・backdrop・Search 遷移時の focus restoration を維持しました。
- 広い Zenn AI feed の Local LLM 判定を、`DiffusionGemma`、`LLM` / `SLM`、`Ollama`、明示model/runtime、`VRAM`、`ローカルLLM` / `ローカルAI` などタイトル上の主題根拠へ限定し、本文中または題名中のbare「ローカル」だけを理由に、業務・DB・一般AIデモが `local-llm` として掲載されないようにしました。正当なDiffusionGemma推論とVRAM動画モデルの記事を保持し、既存の live/archive data にも同じ source filter を再適用しています。変更したPublisher fingerprintのrolloutはR-027に従い、PR-headのQueue consumer deployとdrain、merge後の旧harness mismatch観測、明示承認後のbridge/harness deployの順で行います。
- 静的build時に固定されていた「N分前・N時間前」を閲覧時と1分周期で再計算し、Status、Home、記事一覧・詳細、PageHero、footerが古い経過時間を表示し続ける問題を修正しました。6時間の遅延境界を越えた場合は、run、Queue、Home、About、要約待ちcardも同じ状態へ切り替わります。
- AboutのPurpose、Freshness、History、Pipeline説明をJA/EN切替へ接続し、EN表示で収集方針だけが日本語のまま残る問題を修正しました。
- Statusのsource掲載状態は公開スナップショット時点の絶対日時として表示し、相対時刻だけが古くなる状態を廃止しました。Aboutのrun指標も同じsnapshotから一体で更新し、欠落telemetryはJA/ENそれぞれで記録なしと表示します。
- Publisher、PR CI、pre-push の検証で同じ静的サイトを二重 build せず、直前に検証済みの `web/dist` を Playwright preview へ再利用するようにし、E2E 開始前の build timeout を防ぎました。
- 並行worktreeのpreview portが重ならないよう、absolute worktree pathのSHA-256から`PLAYWRIGHT_PORT`を決定し、既存serverを再利用しない検証contractへ統一しました。
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
- Taxonomy migration後の本文保持対象数を最終indexから、backlogと解消目安をPublisherと同じ`needsBody`契約から再計算し、Status向けtelemetryが古いsnapshotを残す問題を修正しました。
- Amazon Quickの公式原題が生成titleとsummaryでAmazon QuickSightへ置き換わる問題を修正し、Publisher最終化とmigrationで製品名を保持しました。矛盾する既存AI解説本文はsidecarから失効させ、正しい情報からの再生成対象へ戻しました。
- Publisher runtime fingerprint を現行の生成契約へ同期しました。
- Pagefind を含む本番 Web build が CI job 全体の時間上限や大量の静的 route log、長時間の無出力で中断されないよう、品質 gate の実行上限と Astro build のheartbeatを調整しました。
- Web build の開始時に古い `dist` を削除し、廃止した静的ルートが成果物へ残らないようにしました。
- 新規作業branchのpre-push secret scanを`origin/main..HEAD`へ限定し、既にremoteへ存在する全履歴を毎回再走査しないようにしました。
- pre-pushのWeb影響判定をupstream状態ではなく実際のpush rangeから導出し、初回branch pushでfocused E2Eを誤って省略しないようにしました。
- Full PlaywrightとVitestを1 workerで実行し、同一hostのpeak負荷を抑えるようにしました。pre-pushは生成Home・記事詳細・metrics・Archive・404のPublisher E2Eを実行し、warm/cold・exact tag・navを含む全PlaywrightはPR CIで必須とします。
- 共有されたタグ検索 URL の大文字小文字やアクセント表記が異なっても、完全一致の対象記事を回収できるようにしました。
- 完全一致タグ検索と一般検索を独立した期限で実行し、一般検索が遅い場合もタグから対象記事へ戻れるようにしました。
- Linux のフォントメトリクスでも中間幅の Hero と固定 Footer が過度に伸びず、優先記事と重ならないようにしました。
- archive index baseline が `null`、`false`、`0` などの非 object JSON でも欠落扱いされる経路を廃止し、存在する baseline を必ず fail-closed で検証するようにしました。
- `data/bodies.json` が evergreen・importance 2/3 の蓄積で運用上限へ近づき、scheduled Publisher run が失敗する問題を修正しました。retention の boolean gate (evergreen・importance 2/3・直近日数) とは別に、実バイト量が 9,000,000 bytes の target を必ず超えないよう importance の低い記事の最古から決定論的に prune する budget enforcement を追加し、既存データへも同じ policy を一度だけ適用しました。evergreen は最優先 (最後に prune される) ですが絶対的な免除ではなく、他の全 tier を prune してもなお target を超える場合は evergreen も最古から last-resort として prune されます。budget で prune された記事は次回以降の生成候補から永続的に除外し (disabled/エラー時のモード遷移でも記憶を保持)、registry 変更等で優先度が改善した場合は自動的に候補へ復帰します。10MB の hard ceiling test は安全網として維持し、上限自体は変更していません。prune された記事は要約と原文リンクを引き続き表示します。
