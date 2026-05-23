---
description: "Run a tech-dashboard data quality audit and summarize freshness, fallback debt, source coverage, tags, and duplicate URLs."
---

# tech-dashboard Quality Audit

Run:

```bash
npx tsx .claude/skills/quality-audit/run.ts
```

Then report:

| 📌 項目 | 内容 |
|---|---|
| 🔴 Critical | Count and root causes |
| 🟠 Warning | Count and root causes |
| 🟢 Minor | Count and root causes |
| 📝 Summary coverage | Empty, short, real AI, and deterministic fallback counts |
| 🏥 Freshness | Stale/error/no-data sources |

Rules:

- Do not treat `publishedAt` staleness as pipeline failure; use `collectedAt` for source health.
- Highlight deterministic fallback debt even when summary/body fields are non-empty.
- Do not expose secrets or local ignored file contents.
