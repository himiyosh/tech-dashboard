# Worker 分割設計 (LL-037 採用済み)

## 背景

旧 `tech-dashboard-harness` Worker は 1 invocation で以下を全て行っていた。

1. 全 50 sources を 4 batch に分割し、batch 内 collector を並列実行
2. RSS / HTML を normalize + tag
3. **Copilot で要約生成 (停止中: `SUMMARIZE_MAX_NEW=0`)**
4. `data/index.json` を既存とマージ
5. `data/archive/*.json` を touched-month のみ更新
6. `data/stats.json` を incremental 更新
7. GitHub Git Data API で 1 commit にまとめて push

Cloudflare Workers Standard プランの **CPU 時間 30s/invocation** が 3. + 4-7 の合算で枯渇するため、3 を有効化すると HTTP 503 (`Worker exceeded CPU time limit`) になる (LL-037)。

## 目的 / 現状

- Worker 経路で要約生成を復活させ、新着記事に AI 要約を付ける (Cloudflare Queue consumer `tech-dashboard-summarizer` で採用済み)
- cron 健全性 (batch 0/1/3 の HTTP 200) を維持
- ローカル `npm run resummarize` への手動依存を解消

## 設計方針: Cloudflare Queues による分離

### A. 役割分担

| Worker | 責務 | CPU 予算 | 起動 |
|---|---|---|---|
| **harness-collector** (現 `tech-dashboard-harness`) | collect → normalize → merge → publish | 30s (現状 25-28s) | `cron 0 * * * *` |
| **harness-summarizer** (`tech-dashboard-summarizer`) | Queue から URL を pop して Copilot 要約 → KV `SUMMARY_CACHE` に保存 | quality-first: timeout 180s / 6000 tokens | `[[queues.consumers]]` |

### B. データフロー

```
cron tick (collector)
  ├─ collect 12-13 sources
  ├─ merge with prior data/index.json
  ├─ for each entry without cached summary:
  │    SUMMARY_QUEUE.send({ url, title, source, summary snippet, lang, tags })
  └─ commit data/index.json + archive + stats (deterministic fallback 適用済み)

Queue consumer (summarizer)
  ├─ ack 1 メッセージ
  ├─ Copilot /chat/completions 呼び出し (long-form prompt)
  ├─ JSON parse
  └─ SUMMARY_CACHE.put(url, { summaryJa, summaryEn, bodyJa, bodyEn, generatedAt })

cron tick (next hour, collector)
  ├─ collect ...
  ├─ for each entry: SUMMARY_CACHE.get(url) → enrichment 反映
  └─ commit
```

要約はキャッシュ経由で次回 cron 時に index へ反映される (タイムラグ ≤ 1h)。

### C. なぜ Queue か

| 案 | 採否 | 理由 |
|---|---|---|
| Queues | ✅ 採用 | retry 内蔵、ack/nack、batch size 制御、CPU は per-message |
| Cron 専用 Worker | ❌ | cron は最低 1 分間隔。50 件 × 20s = 16 分かかり non-trivial |
| Durable Object | ❌ | overkill。状態を持つ必要なし |
| ローカル resummarize (現状) | ⚠️ 暫定 | 手動依存。サーバ運用とずれる |

### D. 実装ステップ

1. **wrangler.toml に Queue producer + consumer 追加**
   - producer binding: `SUMMARY_QUEUE` (in collector)
   - consumer: 新 Worker `harness-summarizer` (`max_batch_size = 1`, `max_batch_timeout = 5s`)
2. **collector 側に enqueue ロジック追加**
   - `runHarness` の publish 直前で、要約未生成 entry を最大 N 件キューに投入
   - dedupe: 既にキャッシュにあれば skip
3. **summarizer Worker 新規作成**
   - `worker-summarizer/src/index.ts`
   - `queue(batch, env)` handler: 1 メッセージごとに Copilot → KV write
   - `buildPrompt()` の長文 JSON contract を使い、`SUMMARIZE_MAX_TOKENS=6000` / `SUMMARIZE_TIMEOUT_MS=180000` で品質を優先する
   - 失敗時は throw → Queue が自動 retry (最大 2 回, exponential backoff)
4. **KV `SUMMARY_CACHE` を両 Worker に bind**
5. **collector 側で `SUMMARY_CACHE` 参照を強化**
   - 既に部分的に実装済み (`worker/src/index.ts` で cache hit を merge)
   - キャッシュキーを `canonical url` に揃える
6. **デプロイ + smoke test**
   - `wrangler queues create summary-queue`
   - `wrangler deploy` (collector)
   - `cd worker-summarizer && wrangler deploy`
   - `/diag/run-batch?batch=0` で enqueue 件数を観測
   - `wrangler tail tech-dashboard-summarizer` で consumer が処理しているか確認
7. **段階解放**
   - 初期 enqueue cap: 5 件/cron tick
   - 現行 enqueue cap: 35 件/cron tick (KV free tier の 1000 writes/day に収める)
   - producer は eligible fallback jobs の中で `cap` 件ずつ hour-based round-robin するため、同じ先頭 35 件に固定されない
   - backlog 解消後は新着記事数に応じて自然に低下する

### E. 失敗モード/対策

| 失敗 | 検知 | 対策 |
|---|---|---|
| Copilot timeout | Queue retry | max 2 回で Dead Letter Queue へ。手動 backfill |
| KV write 失敗 | throw → retry | Queues が自動再送 |
| Queue 滞留 (生成 < 投入) | `wrangler queues info` の Pending 数監視 | producer 側 cap を下げる |
| Worker CPU 超過 (consumer 側) | `wrangler tail` | timeout / concurrency を確認。Free plan では `cpu_ms` を設定できないため、必要なら Paid plan 化か専用Nodeジョブ化を検討する |
| 重複 enqueue | KV key 重複だけだが double-spend で課金増 | producer で `SUMMARY_CACHE.get` を必ず先行 |

### F. コスト試算 (Workers Paid Standard, $5/月 基本料金)

- 現在: collector cron 24 invocations/day = 720/月。requests 込みで $5 範囲内
- 追加: summarizer は Queue で起動。1 件 1 invocation。20 件/h × 24h × 30d = **14,400 invocations/月**
- Queue 単体料金: 100 万 operation まで含む。14,400 は誤差
- Copilot API 課金: Copilot Enterprise 権限で実行。現在は quality-first の `max_tokens=6000` を前提に、Queue の `max_concurrency=2` で上流 rate を抑える
  - 14,400 件 × $0.01 = **$144/月** (見積もり最大値)
  - キャッシュヒット率が高ければ大幅に下がる

### G. 切り戻し計画

- summarizer Worker を `wrangler delete tech-dashboard-summarizer` で即停止
- collector の enqueue ロジックは feature flag `ENABLE_QUEUE = "0"` で無効化
- 既存キャッシュは保持されるので UI への影響なし

### H. 採用判断

要約品質が UX に直結 (LL-028, LL-029) するため、**B-2 (Queue 分離) を中期で採用推奨**。短期は `npm run resummarize` ローカル運用で穴を埋める。
