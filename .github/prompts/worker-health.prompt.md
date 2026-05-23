---
description: "Investigate tech-dashboard Worker and Queue health without exposing Cloudflare or GitHub secrets."
---

# tech-dashboard Worker Health Check

Inspect local data and public status surfaces first:

```bash
node -e "const d=require('./data/index.json'); console.log(JSON.stringify(d.health,null,2))"
npm run secrets:scan
```

When summarizing, include:

| 📌 項目 | 内容 |
|---|---|
| 🏥 Worker run | lastRunAt, batch, sourcesOk/sourcesAttempted |
| 📝 Summary backlog | fallbackTotal, fallbackPercent, queueMode, enqueueCandidates |
| 🧠 Summarizer | queue cap, KV lookup cap, timeout/model assumptions |
| ⚠️ Risks | stale worker, queue missing binding, KV daily write cap, subrequest cap |

Rules:

- Never print Wrangler OAuth tokens, Cloudflare API tokens, GitHub PATs, or `.env*` contents.
- Do not run `wrangler deploy`, merge PRs, or push to `main` without explicit user approval.
- Prefer public URL/status checks and redacted local metadata over secret-bearing config reads.
