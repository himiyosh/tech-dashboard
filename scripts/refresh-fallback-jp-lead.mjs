// scripts/refresh-fallback-jp-lead.mjs
// One-off: rewrite existing fallback summaryJa entries to lead with Japanese
// instead of the English title. Mirrors the template in
// worker/src/content-fallback.ts updated for LL-041.
import fs from "node:fs";

const path = "data/index.json";
const d = JSON.parse(fs.readFileSync(path, "utf8"));

const text = (v) => (typeof v === "string" && v.trim()) ? v.trim() : "";
const firstText = (...vs) => vs.map(text).find(Boolean) || "";
const hasCjk = (v) => /[\u3040-\u30ff\u3400-\u9fff]/.test(text(v));
const englishText = (v) => { const n = text(v); return n && !hasCjk(n) ? n : ""; };
const shortenForSummary = (v, max) => { const t = v.replace(/\s+/g, " ").trim(); return t.length <= max ? t : t.slice(0, max - 1) + "…"; };

let summaryRefreshed = 0;
let bodyRefreshed = 0;
for (const e of d.entries) {
  const sj = e.summaryJa || "";
  const bj = e.bodyJa || "";
  const isFallback = sj.includes("AI 要約") && sj.includes("未生成");
  if (!isFallback) continue;
  const titleAny = firstText(e.titleJa, e.titleEn, e.title, e.url, "TECH Dashboard entry");
  const titleEn = englishText(e.titleEn) || englishText(e.title) || englishText(titleAny);
  const titleJa = hasCjk(e.titleJa || "") ? text(e.titleJa) : hasCjk(e.title) ? text(e.title) : "";
  const source = firstText(e.source, "unknown source");
  const sourceType = firstText(e.sourceType, "source");
  const category = firstText(e.category, "tech-news");
  const newSummary = titleJa
    ? shortenForSummary(titleJa, 140)
    : shortenForSummary(`このエントリは ${source} から収集した ${category} 領域の最新アップデートです。原題:「${titleEn || titleAny}」。AI による日本語要約は次回以降の Worker run で生成されます。`, 220);
  if (newSummary !== e.summaryJa) { e.summaryJa = newSummary; summaryRefreshed++; }
  // bodyJa: rewrite first paragraph if it starts with English (titleJaIsCjk false)
  const titleJaIsCjk = hasCjk(e.titleJa || "") || hasCjk(e.title);
  if (!titleJaIsCjk && bj) {
    const paragraphs = bj.split("\n\n");
    if (paragraphs.length >= 1) {
      const newLead = `このエントリは ${source} から収集した ${category} 領域の最新アップデートです。原題は「${firstText(e.titleJa, e.titleEn, e.title, "TECH Dashboard entry")}」。${newSummary}。`;
      paragraphs[0] = newLead;
      const newBody = paragraphs.join("\n\n");
      if (newBody !== e.bodyJa) { e.bodyJa = newBody; bodyRefreshed++; }
    }
  }
}

d.generatedAt = new Date().toISOString();
d.count = d.entries.length;
fs.writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
console.log(`refreshed summaryJa: ${summaryRefreshed}`);
console.log(`refreshed bodyJa lead: ${bodyRefreshed}`);
