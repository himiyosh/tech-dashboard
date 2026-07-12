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
5. 明示承認のうえ`tech-dashboard-harness`をFree bridgeへdeployする。
6. bridge `/health`、Publisher workflow、data commit、Queue drain、Pages production、公開URLを順に確認する。

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
