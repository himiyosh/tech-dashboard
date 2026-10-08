# Free Publisher / Worker 分割設計

## 背景

旧 `tech-dashboard-harness` は Cloudflare Worker の 1 invocation で収集、multi-megabyte JSON の merge、archive / stats 更新、GitHub commit、Queue enqueue を行っていた。この処理は production で約 0.6-1.6 秒の CPU を使い、Workers Free の CPU 上限では完走しない。また Free plan では `[limits] cpu_ms = 30000` を宣言できない。

重い publisher を GitHub Actions の Node 22 job へ移し、Cloudflare Worker は GitHub Actions OIDC を検証する軽量 KV / Queue bridge に限定する。

## 目的

- Workers Free のまま毎時収集を継続する。
- data の生成、品質検証、Git commitを同じNode jobで完結する。
- Queue / KV副作用をdata検証とmain pushの成功後だけ実行する。
- repositoryに新しい長命secretを追加しない。
- 既存のsummary/body Queue consumerとper-URL cacheを維持する。

## 役割分担

| Runtime | 責務 | 起動 |
|---|---|---|
| GitHub Actions Publisher | immutable snapshot、collect、normalize、merge、fallback、archive/stats、品質ゲート、data-only commit | `0 * * * *` / `workflow_dispatch` |
| `tech-dashboard-harness` Free bridge | GitHub Actions OIDC検証、allowlist済みKV read/writeとQueue送信、public health | HTTPS fetch |
| `tech-dashboard-summarizer` | QueueからCopilot要約を生成し`SUMMARY_CACHE`へ保存 | Queue consumer |
| `tech-dashboard-body` | QueueからCopilot本文を生成し`BODY_CACHE`へ保存 | Queue consumer |

Pages deployは従来どおりCloudflare Pages Git Integrationが担当する。GitHub ActionsからPagesまたはWorkerをdeployしない。

## データフロー

```text
GitHub Actions schedule / workflow_dispatch
  -> Node Publisher
       -> checkout と remote main の SHA 一致確認
       -> contract と全 baseline artifact を immutable SHA から読む
       -> collect + normalize + merge + fallback
       -> OIDC bridge 経由で summary/body cache を読む
       -> Queue/KV effects を RUNNER_TEMP に atomic 保存
       -> typecheck + unit + schema + web build + E2E + secret scan
       -> main drift を再確認
       -> allowlist 済み data file だけを non-force push
       -> push 成功後だけ effects を flush
  -> Cloudflare Free bridge
       -> Queue.sendBatch(summary/body)
       -> KV.get(allowlisted cache)
       -> KV.put(og.v1 only)
  -> Queue consumers
       -> Copilot API
       -> per-URL KV cache
  -> 次回 Publisher run
       -> cache を index / bodies sidecar へ merge
```

## Publisher contract

`worker/publisher-contract.json` のfingerprintをproducer、bridge、consumerの共通契約にする。次をcritical pathとしてhashする。

- `.github/workflows/publisher.yml`
- `scripts/run-publisher.ts`
- `harness/**`
- `worker/src/**`
- `worker/wrangler.toml`
- root / Worker package files
- Worker TypeScript config

critical pathを変更したら同じPRで次を実行する。

```bash
npm run publisher:contract -- --apply
npm run publisher:contract -- --dry-run
```

dry-runが`CURRENT`でなければreleaseしない。

## Snapshot と commit safety

1. Publisher開始時にcheckout HEADとremote main SHAを比較する。
2. contract、index、bodies、archive、statsを同じSHAから読む。
3. 生成結果をrepository fileへ書く前にpayloadを検証する。
4. data差分があるrunは全品質ゲートを通す。
5. push直前にremote mainが開始時SHAのままか再確認する。
6. exact data path allowlistだけをstageする。
7. commit parentを開始時SHAに固定し、non-force pushする。
8. SHAが進んでいればcommitとeffects flushを中止し、次runへ持ち越す。

data差分がないeffect-only runも0 fileのcommit sinkで同じsnapshot CASとcontract確認を通す。collapse guardは失敗として終了し、effects bundleを保存しない。これにより古いsnapshotを新しいmainへ載せず、stale runや異常runのQueue/KV副作用も残さない。

## Deferred effects

Queue enqueueと`og.v1` KV writeはpublisher生成中に送信しない。validated effect bundleを`$RUNNER_TEMP/tech-dashboard-publisher-effects.json`へatomic保存し、次の条件をすべて満たした後だけ`publisher:run -- --flush`で送る。

- data生成が成功した
- data差分がある場合は全品質ゲートが成功した
- main driftがない
- data commitのpushが成功した

検証失敗、main drift、push失敗ではbundleをflushしない。bundleは`RUNNER_TEMP`外からflushできない。

## OIDC bridge security

bridgeはGitHub JWKSを使ってRS256署名を検証し、次のclaimをfail-closedで確認する。

- issuer
- 専用audience
- repository / repository owner
- `refs/heads/main`
- workflow ref
- event name
- subject
- workflow SHA
- issued-at / not-before / expiry

request body size、job件数、Queue名、KV key、publisher fingerprintもallowlistで制限する。KV writeはpublisherが必要とする`og.v1`だけを許可し、summary/body cacheとheartbeatはpublisherから書かない。bindingまたはOIDC設定が不足する`/health`は`503 bridge-misconfigured`を返す。

## Queue / cache contract

- summary cache keyは`s:<sha256(url)>`。
- body cache keyは`b:<sha256(url)>`。
- jobとcacheに`publisherFingerprint`を保存する。
- explicit mismatchは採用せず、再生成対象へ戻す。
- summary完了条件は`titleJa + summaryJa + summaryEn`で、bodyを要求しない。
- bodyは`data/bodies.json`へmergeし、indexへ戻さない。
- Queue producer/consumerは少なくとも1回配送を前提にcache keyで冪等化する。

## Release sequence

fingerprintを変えるreleaseは次の順序を固定する。

1. CI合格済みPR headのsummarizer/body consumerを明示承認のうえ先にdeployする。
2. 旧consumerのin-flight処理が残っていないことを確認する。
3. PRをmergeする。
4. 旧harnessが新markerとのmismatchでdata publishを停止したことを確認する。
5. 明示承認のうえ`tech-dashboard-harness`をFree bridgeへdeployする。`wrangler deployments list`が100%を示した直後でも、release verifierからの`/health`が最大60秒ほど旧fingerprintを返すことがある。immediateな1回の応答だけで「bundleが壊れている」と判断せず、`node scripts/verify-worker-deploy.mjs` (bounded polling、既定120s timeout / 5s interval / 3回連続一致) で観測経路の安定収束を確認する。これは全edge PoPの収束証明ではない。
6. bridge `/health`、Publisher workflow、data commit、Queue drain、Pages production、公開URLを順に確認する。

### #364 の旧writer停止証拠に限る一回限りの条項案 (未適用)

通常の旧harness marker mismatch観測、例外時の旧run terminal failure・merge後data commit不在・旧heartbeat非更新の全実測、consumer-firstと旧consumer drain、bridge-lastは既定のまま維持する。今回の別案は #364 のmain merge `91a8a3b713841b8d2fd9aba06e977f278101349f` と、その後に別途審査・承認されたdocs/policy-onlyの `working branch → develop → main` mergeにだけ限定する。後続mainのexact diffがdocs/policyだけで、#364からdata tree、fingerprint、全critical pathが不変であることを実refで示せなければSTOP。develop全体がmainに489 commit遅れていた事実は2026-10-09時点の観測であり、これをpolicy-only releaseの許可に読み替えない。policy自身のmain mergeがR-001c/R-027を通る根拠または別のowner判断なしに、自己例外として先行mergeしない。draft PRはrelease許可ではない。証拠の正本は [.github/copilot-instructions.md](../.github/copilot-instructions.md) R-027とする。

| 段階 | 独立した証拠と実行境界 |
| --- | --- |
| 段階A: workflow停止中、暫定置換前 | (1) workflow ID/状態履歴、schedule/手動/bridge dispatchのprovider read-back、(2) 全旧Actions invocationのterminalとactiveなし、関連Queue/DLQ/in-flightのprovider確認、(3) exact main SHA/data treeと旧runnerのcheckout・開始時/commit直前/effects flush直前のpreflight/CAS拒否、(4) 候補bridgeの旧fingerprint Queue/KV拒否と新版markerの隔離fixture。欠測やQueue sampleの0では証明できない。全て揃いownerがpolicy適用と暫定置換を**別々に明示承認**するまで置換しない。 |
| 段階B: 別承認の暫定bridge置換後、Publisher停止中 | (4) 実deploy version、bundle/code provenanceとpublic `/health`の新版markerへの安定read-back、旧fingerprint拒否をproviderで確認する。(1)〜(3)とmain/data/Queue/KVも再確認する。旧`heartbeat.v1`の404は非更新の証明ではない。mock/local preflight、production bindingsを共有するWorker Version URLやdeployment 100%だけではproduction code/read-backと同等にならない。いずれか未証明ならSTOPし、Publisherを動かさない。 |

本番側の(4)は暫定bridge置換**後**にしか観測できないため、Aの証拠を4/4達成と報告しない。暫定置換自体はrelease gate通過でもworkflow再開でもなく、4/4の確認後もPublisher再有効化/dispatch、data/effects書込みはそれぞれ別の明示承認を要する。main mergeにも事前の別承認が必要である。暫定bridge置換を1回実行した時点で条項の置換許可は消費され、成否を問わず再置換・将来releaseへ再利用しない。既存の会話修復・POST-MERGE全ID read-backとimmutable snapshot/CASも変えず、無承認rollbackは行わない。

## Observability

| Signal | Source |
|---|---|
| Publisher conclusion / age | GitHub Actions `Publisher / publish`。診断用`Publisher / dry-run`は除外 |
| data freshness / collection outcome | `data/index.json.generatedAt`と完全な`health.sourcesAttempted / sourcesOk / sourcesFailed` |
| bridge readiness | `tech-dashboard-harness/health` |
| summary issue | `tech-dashboard-summarizer/health` |
| backlog / fallback / bodies | `data/index.json.health` と `/status` |
| production aggregate | `npm run health:prod` / `worker-health.yml` |

Publisherが落ちても既存dataは維持される。consumerが落ちてもdeterministic summary fallbackを公開し続ける。bridgeがmisconfiguredなら副作用をfail-closedで拒否し、data push済みrunのeffectsは次回runで再選択される。
