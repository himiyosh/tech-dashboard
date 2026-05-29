export const ARXIV_SOURCE_INFO = [
  {
    id: "arxiv-cs-ai",
    code: "cs.AI",
    title: "Artificial Intelligence",
    descriptionJa:
      "人工知能全般のカテゴリです。推論、計画、エージェント、知識表現、AI システム評価などを扱います。",
    shortJa: "AI システム、推論、計画、エージェント",
  },
  {
    id: "arxiv-cs-cl",
    code: "cs.CL",
    title: "Computation and Language",
    descriptionJa:
      "自然言語処理のカテゴリです。LLM、対話、翻訳、言語データ、評価ベンチマークなどを扱います。",
    shortJa: "LLM、NLP、言語データ、評価",
  },
  {
    id: "arxiv-cs-se",
    code: "cs.SE",
    title: "Software Engineering",
    descriptionJa:
      "ソフトウェア工学のカテゴリです。開発支援、テスト、保守、コード生成、開発プロセスなどを扱います。",
    shortJa: "開発支援、テスト、コード生成、保守",
  },
  {
    id: "arxiv-cs-lg",
    code: "cs.LG",
    title: "Machine Learning",
    descriptionJa:
      "機械学習のカテゴリです。学習アルゴリズム、最適化、モデル訓練、汎用 ML 手法などを扱います。",
    shortJa: "学習アルゴリズム、訓練、最適化",
  },
] as const;

export type ArxivSourceId = (typeof ARXIV_SOURCE_INFO)[number]["id"];

export function arxivSourceInfo(source: string) {
  return ARXIV_SOURCE_INFO.find((item) => item.id === source) ?? null;
}
