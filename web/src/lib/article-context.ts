/**
 * Article context helpers — compose richer narrative on the entry detail page
 * from existing metadata (category, source, tags). No LLM at runtime; this is
 * a curated knowledge base that augments the AI summary with background and
 * cross-references for a more readable, "magazine-style" article body.
 */

import type { Category, NormalizedEntry } from "./data.ts";

interface CategoryBackground {
  oneLiner: string;
  context: string;
}

const CATEGORY_BG: Record<Category, CategoryBackground> = {
  copilot: {
    oneLiner: "GitHub が提供する AI ペアプログラマー。",
    context:
      "GitHub Copilot は OpenAI の Codex を起源に、現在は GPT-4o / Claude / o-series など複数モデルを切り替えて利用できるマルチモデル基盤に発展した。Visual Studio Code / Visual Studio / JetBrains / Neovim などをカバーし、エンタープライズではポリシー制御・監査ログ・モデル選択 (Copilot Business / Enterprise) も整備されている。",
  },
  claude: {
    oneLiner: "Anthropic 製の大規模言語モデルファミリー。",
    context:
      "Claude は安全性研究を出自とする Anthropic が開発する LLM で、長文コンテキスト (200K〜1M tokens) と Constitutional AI による応答整合性が特長。Claude Code をはじめとするエージェント実行系や、Computer Use / Tool Use API の整備により、コーディング領域でも Copilot / Cursor の主要バックエンドとして採用が広がっている。",
  },
  codex: {
    oneLiner: "OpenAI のコード特化モデル / エージェント系列。",
    context:
      "OpenAI の Codex ブランドは初代 GitHub Copilot のバックエンドだったが、近年は ChatGPT Atlas / Codex CLI / GPT-5-Codex 等として再編。クラウド型コーディングエージェントとしてサンドボックス環境でのファイル編集・テスト実行・PR 生成までを自律実行する方向に進化している。",
  },
  gemini: {
    oneLiner: "Google DeepMind の生成 AI ファミリー。",
    context:
      "Gemini は Google の Bard 後継として登場。ネイティブマルチモーダル (画像・動画・音声) と 1M+ トークンの長文コンテキストが特徴で、Google Cloud / Workspace / Android / Chrome に深く統合。Gemini Code Assist は VS Code / IntelliJ プラグインで Copilot 競合を担う。",
  },
  cursor: {
    oneLiner: "VS Code フォークの AI ファースト IDE。",
    context:
      "Cursor (Anysphere 製) は VS Code を fork し、コードベース全体のセマンティック index、Composer / Agent モード、モデル切替 (Claude / GPT / 自社モデル) を統合した IDE。Tab 補完の速度感と Cmd-K による局所編集体験で開発者支持を集めている。",
  },
  cline: {
    oneLiner: "VS Code 拡張のオープンソースエージェント。",
    context:
      "Cline (旧 Claude Dev) は VS Code 拡張として動作するオープンソース AI コーディングエージェントで、ファイル編集・ターミナル実行・ブラウザ操作までを許可制で実行する。Roo Code はその fork で、より積極的な自動化と複数モデル切替を志向する。",
  },
  opencode: {
    oneLiner: "オープンソースのコーディングエージェント。",
    context:
      "OpenCode / OpenHands (旧 OpenDevin) や Aider など、SWE-Bench 等のベンチマークと並走しながら進化するオープンソース系コーディングエージェント群。完全自律実行と検証可能性のトレードオフを実装で探求している。",
  },
  vscode: {
    oneLiner: "Microsoft 製のオープンソースエディタ。",
    context:
      "Visual Studio Code は AI コーディングプラットフォームの事実上の標準として、Copilot / Continue / Cline / Roo / Cursor (fork) など多数のエージェント拡張のホスト基盤になっている。月次リリースで API・UI が継続進化する。",
  },
  "local-llm": {
    oneLiner: "ローカル / オンプレで動作する LLM 群。",
    context:
      "Ollama / LM Studio / llama.cpp / vLLM などを基盤に、Llama / Qwen / Mistral / Phi / DeepSeek 等のオープンウェイトモデルをローカル実行する潮流。プライバシー要件・コスト・レイテンシの観点で SaaS LLM を補完する。",
  },
  "agent-fw": {
    oneLiner: "エージェント構築用フレームワーク。",
    context:
      "LangChain / LlamaIndex / AutoGen / Semantic Kernel / Microsoft Agent Framework / CrewAI などは、ツール呼び出し・メモリ・マルチエージェント協調・evaluation harness を抽象化するライブラリ群。MCP の登場で接続層が標準化されつつある。",
  },
  mcp: {
    oneLiner: "Model Context Protocol — LLM とツールを繋ぐ標準。",
    context:
      "Anthropic が 2024 年に発表した Model Context Protocol (MCP) は、LLM クライアントとデータソース / ツールを繋ぐオープンプロトコル。VS Code / Claude Desktop / Cursor 等が採用し、MCP サーバーのエコシステム (GitHub / Slack / Postgres / Stripe 他) が急速に拡大している。",
  },
  research: {
    oneLiner: "AI / 機械学習の学術研究。",
    context:
      "arXiv の cs.CL / cs.AI / cs.LG / cs.SE 領域では、LLM 評価手法、エージェント、coding-bench、推論時計算 (test-time compute)、安全性などのテーマで日次で大量の論文が投下されている。実装と理論の境界が短期化している分野。",
  },
  "tech-news": {
    oneLiner: "テック業界全般の動向。",
    context:
      "Ars Technica / TechCrunch / The Verge / Apple Newsroom 等の総合テックメディア。AI コーディング領域に直結しない業界再編・買収・規制動向も、エコシステムの方向性を読む上で重要なシグナルとなる。",
  },
};

const SOURCE_BG: Record<string, string> = {
  "anthropic-news":
    "Anthropic 公式の発表チャネル。Claude モデルのリリース・安全性レポート・パートナーシップなど一次情報。",
  "anthropic-engineering":
    "Anthropic エンジニアリングブログ。プロンプトエンジニアリング・MCP・エージェント実装などの実践知見が中心。",
  "openai-news": "OpenAI のニュースルーム。モデルリリースと製品アナウンス。",
  "openai-blog": "OpenAI の技術ブログ。研究成果と製品の背景説明。",
  "google-deepmind": "Google DeepMind の研究ブログ。Gemini / 基礎研究の発表元。",
  "google-developers": "Google Developers Blog。Gemini API / Workspace 連携など実装者向け情報。",
  "github-blog-ai": "GitHub Blog の AI/ML カテゴリ。Copilot 製品アップデートや採用事例。",
  "github-changelog": "GitHub Changelog。Copilot を含むプラットフォーム変更の一次情報。",
  "huggingface-blog":
    "Hugging Face Blog。オープンウェイトモデル・Transformers ライブラリ・Datasets / Spaces のアップデート。",
  "ollama-releases": "Ollama の GitHub リリース。ローカル LLM ランタイムの新機能・対応モデル。",
  "vscode-updates": "VS Code 公式の月次リリースノート。AI 機能を含む全アップデート。",
  "cursor-changelog": "Cursor の変更履歴。Composer / Agent / Tab 補完の進化を追う。",
  "simonw-blog":
    "Simon Willison のブログ。LLM ツーリングと API の実験的レビューで定評がある。",
  "ars-technica": "Ars Technica。深掘りしたテックジャーナリズムで業界動向を解説。",
  "techcrunch": "TechCrunch。スタートアップ・資金調達・買収などビジネス面の速報。",
  "the-verge": "The Verge。消費者向けテクノロジー報道。",
};

const TAG_GLOSSARY: Record<string, string> = {
  rag: "Retrieval-Augmented Generation。外部知識を取得して LLM に供給するパターン。",
  agent: "自律的にツール呼び出しと推論を繰り返す LLM 利用形態。",
  agents: "自律的にツール呼び出しと推論を繰り返す LLM 利用形態。",
  mcp: "Model Context Protocol。LLM クライアントとツール・データソースを繋ぐ標準。",
  llm: "Large Language Model。大規模言語モデル。",
  copilot: "GitHub が提供する AI コーディング支援。",
  claude: "Anthropic 製の LLM ファミリー。",
  gpt: "OpenAI の GPT 系モデル。",
  gemini: "Google DeepMind の生成 AI モデル。",
  vscode: "Microsoft 製のエディタ。AI コーディング拡張のホスト基盤。",
  cursor: "VS Code fork の AI 統合 IDE。",
  cline: "VS Code 上で動作するオープンソース AI エージェント。",
  ollama: "ローカル LLM ランタイム。",
  llama: "Meta が公開するオープンウェイト LLM ファミリー。",
  qwen: "Alibaba の Qwen LLM ファミリー。",
  arxiv: "AI/CS の主要プレプリントサーバ。",
  paper: "学術論文。",
  release: "ソフトウェアの公式リリース。",
  changelog: "変更履歴。",
  benchmark: "性能評価指標。SWE-Bench / HumanEval / MMLU 等。",
  evaluation: "モデル・エージェントの定量評価。",
  finetuning: "事前学習済みモデルの追加学習。",
  "fine-tuning": "事前学習済みモデルの追加学習。",
  embedding: "テキストをベクトル空間に写像する表現。検索・RAG の基盤。",
  embeddings: "テキストをベクトル空間に写像する表現。検索・RAG の基盤。",
  vector: "ベクトル検索 / vector database。RAG パイプラインの構成要素。",
  prompt: "LLM への入力指示。プロンプトエンジニアリングは品質を左右する。",
  azure: "Microsoft の クラウド。Azure OpenAI / Azure AI Foundry が AI 系サービス。",
  aws: "Amazon Web Services。Bedrock / Q Developer などの AI サービスを展開。",
  cloudflare: "エッジクラウド。Workers AI / AI Gateway を提供。",
  github: "コード共有プラットフォーム。Copilot / Actions / Codespaces を擁する。",
  microsoft: "Copilot / Azure / VS Code を擁する AI エコシステムの中核プレイヤー。",
  google: "Gemini / DeepMind / Google Cloud を擁する。",
  openai: "ChatGPT / GPT / Codex の開発元。",
  anthropic: "Claude / MCP / Constitutional AI の開発元。",
  meta: "Llama / PyTorch を擁するオープンソース志向のプレイヤー。",
  apple: "Apple Intelligence / Foundation Models / Xcode AI を展開。",
  nvidia: "GPU インフラと CUDA エコシステムの覇者。",
  qiita: "日本のエンジニア向け情報共有サービス。",
  zenn: "日本のエンジニア向けナレッジ共有サービス。",
  podcast: "音声形式のコンテンツ。情報のインプット手段の一つ。",
  trend: "業界動向 / トレンド。",
  research: "学術・基礎研究領域。",
  community: "コミュニティ発の情報・OSS。",
};

export interface ArticleContext {
  /** 1-2 sentence opening that frames the entry. */
  lead: string;
  /** Background paragraph: what the source/category is, why it's covered. */
  background: string;
  /** Tag-based related knowledge paragraph (may be empty). */
  related: string;
  /** "Why this matters" paragraph from importance/halfLife/sourceType. */
  takeaway: string;
}

const sourceTypeNarrative: Record<NormalizedEntry["sourceType"], string> = {
  release:
    "本記事は新バージョンや新機能の公式リリース告知に分類されます。リリースノートは API 互換性・breaking change・移行手順の確認が重要です。",
  changelog:
    "本記事は変更履歴 (changelog) に分類されます。連続的な改善を追うことで、プロダクトの開発速度や注力領域が見えてきます。",
  paper:
    "本記事は学術論文に分類されます。再現性・評価データセット・先行研究との差分を読むことで、業界の理論的フロンティアを把握できます。",
  blog:
    "本記事は技術ブログ / 記事に分類されます。実装の意思決定・運用知見・ベストプラクティスの一次情報源となることが多いカテゴリです。",
  community:
    "本記事はコミュニティ / OSS 情報に分類されます。エコシステムの草の根動向や、公式チャネルでは見えない実装パターンの発信源です。",
};

const importanceNarrative: Record<1 | 2 | 3, string> = {
  3: "TECH Dashboard は本記事を「重要 (HOT)」と判定しています。メジャーリリース・業界全体に影響しうるアナウンスメントが該当し、エコシステムの方向性を左右する可能性があります。",
  2: "TECH Dashboard は本記事を「通常」レベルの更新として扱っています。日々の積み上げ型情報で、関連プロダクトを使う開発者にとっては有用な参考情報です。",
  1: "TECH Dashboard は本記事を「情報」レベルとして収集しました。文脈補完・周辺知識として位置づけられます。",
};

const halfLifeNarrative: Record<string, string> = {
  news: "情報の鮮度は短く (news)、数日〜数週間で価値が減衰するタイプの記事です。",
  tutorial: "情報の鮮度は中期 (tutorial)、数ヶ月単位で参照される実装手順型コンテンツです。",
  architecture:
    "情報の鮮度は長期 (architecture)、設計思想・アーキテクチャ的洞察として年単位で価値を保ちます。",
  fundamental:
    "情報の鮮度は永続 (fundamental)、基礎概念やパラダイムレベルの知見です。",
};

export function buildArticleContext(
  entry: NormalizedEntry,
  catName: string,
  catSlug: Category,
  srcDisplay: string,
  hostName: string,
): ArticleContext {
  const cb = CATEGORY_BG[catSlug];
  const sb = SOURCE_BG[entry.source];

  const titleHook = (entry.titleJa || entry.title || entry.titleEn).trim();

  const lead = [
    titleHook
      ? `「${titleHook}」は、${srcDisplay} (${hostName}) で公開された${catName}カテゴリの記事です。`
      : `本記事は ${srcDisplay} (${hostName}) で公開された${catName}カテゴリのエントリです。`,
    cb?.oneLiner ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const background = [
    cb?.context ?? "",
    sb ?? `${srcDisplay} は本サイトが定常的に収集している情報源の一つです。`,
  ]
    .filter(Boolean)
    .join(" ");

  // Build a per-tag glossary paragraph (skip duplicates and unknowns).
  const tagBlurbs: string[] = [];
  const seen = new Set<string>();
  for (const tag of entry.tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const blurb = TAG_GLOSSARY[key];
    if (blurb) tagBlurbs.push(`「${tag}」: ${blurb}`);
    if (tagBlurbs.length >= 4) break;
  }
  const related = tagBlurbs.length
    ? `本記事に付与されたタグから関連知見を補足します。${tagBlurbs.join(" ")} これらのキーワードは AI コーディングエコシステムを読み解くうえで頻出する概念群であり、関連記事を辿ることで全体像が把握しやすくなります。`
    : "";

  const takeaway = [
    sourceTypeNarrative[entry.sourceType] ?? "",
    importanceNarrative[entry.importance] ?? "",
    entry.halfLife ? halfLifeNarrative[entry.halfLife] ?? "" : "",
    `詳細は元記事 (${hostName}) を参照することを推奨します。本サイトは要約と分類によりキャッチアップ効率を高めることを目的としており、原典の読み込みを置き換えるものではありません。`,
  ]
    .filter(Boolean)
    .join(" ");

  return { lead, background, related, takeaway };
}
