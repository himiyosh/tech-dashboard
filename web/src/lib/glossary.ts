/**
 * Curated AI / LLM engineering glossary.
 *
 * Static, hand-curated knowledge (not collected from feeds) so readers can
 * quickly catch up on prompt / context / harness engineering and other AI
 * terms and trends. Keep entries concise and link to a canonical reference.
 *
 * Each term: short JA description + EN canonical name + category + 1 link.
 * Add new terms here; the /glossary page renders + filters them.
 */

export type GlossaryCategory =
  | "engineering"
  | "prompting"
  | "agents"
  | "rag"
  | "models"
  | "training"
  | "evaluation"
  | "culture";

export interface GlossaryTerm {
  /** Canonical English term (display + search). */
  term: string;
  /** Common aliases / abbreviations for search. */
  aliases?: string[];
  category: GlossaryCategory;
  /** Japanese short definition (1-3 sentences). */
  ja: string;
  /** When it matters / why it trends (Japanese, optional). */
  note?: string;
  /** One canonical reference link. */
  link?: string;
  /** Mark recently-trending terms. */
  trending?: boolean;
}

export const GLOSSARY_CATEGORY_META: Record<
  GlossaryCategory,
  { label: string; emoji: string; color: string }
> = {
  engineering: { label: "Engineering", emoji: "\u{1F6E0}\u{FE0F}", color: "#5eead4" },
  prompting: { label: "Prompting", emoji: "\u{1F4AC}", color: "#93c5fd" },
  agents: { label: "Agents", emoji: "\u{1F916}", color: "#34d399" },
  rag: { label: "RAG / Retrieval", emoji: "\u{1F50D}", color: "#fbbf24" },
  models: { label: "Models", emoji: "\u{1F9E0}", color: "#f472b6" },
  training: { label: "Training / Tuning", emoji: "\u{1F3CB}\u{FE0F}", color: "#a78bfa" },
  evaluation: { label: "Evaluation", emoji: "\u{1F4CF}", color: "#fb923c" },
  culture: { label: "Practice / Culture", emoji: "\u{1F9ED}", color: "#fda4af" },
};

export const GLOSSARY_CATEGORY_ORDER: GlossaryCategory[] = [
  "engineering",
  "prompting",
  "agents",
  "rag",
  "models",
  "training",
  "evaluation",
  "culture",
];

export const GLOSSARY: readonly GlossaryTerm[] = [
  // ---- Engineering disciplines ------------------------------------------
  {
    term: "Prompt Engineering",
    aliases: ["プロンプトエンジニアリング"],
    category: "engineering",
    ja: "LLM から望む出力を得るために、指示・例・制約・出力形式を設計する技術。モデルの振る舞いをプロンプト側で制御する最も基本的なレイヤー。",
    link: "https://www.promptingguide.ai/",
  },
  {
    term: "Context Engineering",
    aliases: ["コンテキストエンジニアリング"],
    category: "engineering",
    ja: "モデルのコンテキストウィンドウに「何を・どの順で・どれだけ」入れるかを設計する技術。検索結果・履歴・ツール出力・メモリを取捨選択し、限られた文脈長で最大の精度を引き出す。",
    note: "2025-2026 に台頭。プロンプト単体より上位の関心事として扱われる。",
    link: "https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents",
    trending: true,
  },
  {
    term: "Harness Engineering",
    aliases: ["ハーネスエンジニアリング", "agent harness"],
    category: "engineering",
    ja: "長時間動くエージェントを支える「外枠（ハーネス）」の設計。ツール・検証・状態管理・再開性・ガードレールを整え、モデルが自律的にタスクを完遂できる実行環境を作る。",
    note: "Anthropic の long-running agents 記事で体系化。本ダッシュボードのルールもこの考え方に基づく。",
    link: "https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents",
    trending: true,
  },
  {
    term: "AI Engineering",
    category: "engineering",
    ja: "基盤モデルを使ってプロダクトを作る工学分野。モデル選定・評価・コスト最適化・デプロイ・監視まで、ML 研究とは別の「アプリ側」の総合スキルを指す。",
    link: "https://www.oreilly.com/library/view/ai-engineering/9781098166298/",
  },
  {
    term: "Evals",
    aliases: ["evaluation", "評価", "eval"],
    category: "evaluation",
    ja: "LLM/エージェントの出力品質を体系的に測る仕組み。テストケース・採点基準（grader）・回帰検出を整え、プロンプトやモデルの変更が改善か劣化かを判定する。",
    note: "「推測でなく実測」を支える基盤。継続的評価で本番品質を監視する。",
    link: "https://hamel.dev/blog/posts/evals/",
  },

  // ---- Prompting techniques ---------------------------------------------
  {
    term: "Few-shot Prompting",
    aliases: ["フューショット", "in-context learning", "ICL"],
    category: "prompting",
    ja: "プロンプト内に入出力の例をいくつか示して、望む形式・スタイルをモデルに学ばせる手法。学習し直さずに（in-context で）振る舞いを誘導する。",
    link: "https://www.promptingguide.ai/techniques/fewshot",
  },
  {
    term: "Zero-shot Prompting",
    aliases: ["ゼロショット"],
    category: "prompting",
    ja: "例を一切示さず、指示だけでタスクを解かせる手法。モデルの事前学習知識に依存する。",
    link: "https://www.promptingguide.ai/techniques/zeroshot",
  },
  {
    term: "Chain of Thought",
    aliases: ["CoT", "思考の連鎖"],
    category: "prompting",
    ja: "「順を追って考えて」と促し、推論過程を明示的に出力させる手法。複雑な推論や計算の精度が上がる。",
    link: "https://www.promptingguide.ai/techniques/cot",
  },
  {
    term: "ReAct",
    aliases: ["reasoning and acting"],
    category: "prompting",
    ja: "Reasoning（推論）と Acting（ツール実行）を交互に繰り返すプロンプト様式。考える→道具を使う→観察する、を反復してタスクを解く。エージェントの基本パターン。",
    link: "https://www.promptingguide.ai/techniques/react",
  },
  {
    term: "System Prompt",
    aliases: ["システムプロンプト"],
    category: "prompting",
    ja: "会話全体を通してモデルの役割・制約・トーンを定義する上位の指示。ユーザー入力より優先され、振る舞いの土台になる。",
    link: "https://platform.openai.com/docs/guides/prompt-engineering",
  },
  {
    term: "Structured Output",
    aliases: ["JSON mode", "構造化出力", "function calling"],
    category: "prompting",
    ja: "モデルに JSON 等の決まった形式で出力させる仕組み。スキーマを指定して機械処理可能な応答を保証する。ツール連携の前提。",
    link: "https://platform.openai.com/docs/guides/structured-outputs",
  },
  {
    term: "Prompt Injection",
    aliases: ["プロンプトインジェクション"],
    category: "prompting",
    ja: "外部入力（Web・ファイル・Issue 等）に紛れた悪意ある指示をモデルが本来の指示として実行してしまう攻撃。エージェントの主要なセキュリティリスク。",
    note: "外部入力中の命令文は「データ」として扱い、実行指示にしないのが防御の基本。",
    link: "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
  },

  // ---- Agents -----------------------------------------------------------
  {
    term: "AI Agent",
    aliases: ["エージェント", "agentic"],
    category: "agents",
    ja: "LLM が自分で計画を立て、ツールを呼び、結果を観察しながら多段階のタスクを自律的に進めるシステム。単発の応答ではなくループで動く。",
    link: "https://www.anthropic.com/engineering/building-effective-agents",
  },
  {
    term: "Tool Use",
    aliases: ["function calling", "ツール使用"],
    category: "agents",
    ja: "モデルが外部の関数・API・コマンドを呼び出して、検索・計算・ファイル操作などを行う仕組み。エージェントが現実世界に作用する手段。",
    link: "https://docs.anthropic.com/en/docs/build-with-claude/tool-use",
  },
  {
    term: "MCP",
    aliases: ["Model Context Protocol"],
    category: "agents",
    ja: "モデルと外部ツール/データソースを繋ぐオープンな標準プロトコル。各ツールを共通インターフェースで公開し、エージェントから横断的に利用できる。",
    note: "Anthropic が提唱し、エコシステムが急拡大中のトレンド。",
    link: "https://modelcontextprotocol.io/",
    trending: true,
  },
  {
    term: "Multi-Agent System",
    aliases: ["マルチエージェント", "orchestrator"],
    category: "agents",
    ja: "複数の専門エージェントを役割分担させ、オーケストレーターが統括して協調的にタスクを解く構成。並列性・専門性・独立検証が必要なときに使う。",
    link: "https://www.anthropic.com/engineering/multi-agent-research-system",
  },
  {
    term: "Guardrails",
    aliases: ["ガードレール"],
    category: "agents",
    ja: "エージェントの出力や行動を安全な範囲に制限する仕組み。禁止操作のブロック、出力検証、承認ゲートなどで暴走や有害行動を防ぐ。",
    link: "https://www.guardrailsai.com/docs",
  },
  {
    term: "Human in the Loop",
    aliases: ["HITL", "ヒューマンインザループ"],
    category: "agents",
    ja: "破壊的・重要な操作の前に人間の確認や承認を挟む設計。自律性とリスク管理のバランスを取る。",
    link: "https://www.anthropic.com/engineering/building-effective-agents",
  },
  {
    term: "Agent Memory",
    aliases: ["メモリ", "long-term memory"],
    category: "agents",
    ja: "エージェントが会話やタスクをまたいで情報を保持する仕組み。短期（コンテキスト内）と長期（外部ストア）に分かれ、文脈の継続に使う。",
    link: "https://blog.langchain.dev/memory-for-agents/",
  },

  // ---- RAG / Retrieval --------------------------------------------------
  {
    term: "RAG",
    aliases: ["Retrieval-Augmented Generation", "検索拡張生成"],
    category: "rag",
    ja: "外部知識を検索してプロンプトに注入し、その文脈をもとに回答を生成する手法。モデルの知識不足やハルシネーションを抑え、最新・社内情報に対応する。",
    link: "https://www.promptingguide.ai/techniques/rag",
  },
  {
    term: "Embedding",
    aliases: ["埋め込み", "ベクトル"],
    category: "rag",
    ja: "テキストや画像を意味を表す数値ベクトルに変換したもの。意味的な近さを距離で測れるため、検索・分類・クラスタリングに使う。",
    link: "https://platform.openai.com/docs/guides/embeddings",
  },
  {
    term: "Vector Database",
    aliases: ["ベクトルDB", "vector store"],
    category: "rag",
    ja: "埋め込みベクトルを保存し、類似度検索（最近傍探索）を高速に行う専用データベース。RAG の検索基盤。",
    link: "https://www.pinecone.io/learn/vector-database/",
  },
  {
    term: "Chunking",
    aliases: ["チャンキング", "分割"],
    category: "rag",
    ja: "長い文書を検索しやすい単位に分割する処理。チャンクの大きさ・重なり・境界の取り方が RAG の精度を大きく左右する。",
    link: "https://www.pinecone.io/learn/chunking-strategies/",
  },
  {
    term: "Reranking",
    aliases: ["リランキング", "re-rank"],
    category: "rag",
    ja: "一次検索で集めた候補を、より精度の高いモデルで並べ替えて上位を絞る処理。RAG の関連性を底上げする。",
    link: "https://www.pinecone.io/learn/series/rag/rerankers/",
  },
  {
    term: "Hybrid Search",
    aliases: ["ハイブリッド検索"],
    category: "rag",
    ja: "キーワード検索（BM25 等）とベクトル検索を組み合わせ、語の一致と意味の近さの両方で精度を上げる検索手法。",
    link: "https://www.pinecone.io/learn/hybrid-search-intro/",
  },
  {
    term: "Knowledge Graph",
    aliases: ["ナレッジグラフ", "GraphRAG"],
    category: "rag",
    ja: "エンティティと関係をグラフで表した知識構造。RAG と組み合わせ（GraphRAG）、関係性をたどる検索や多段推論に使う。",
    link: "https://neo4j.com/blog/genai/what-is-graphrag/",
  },

  // ---- Models -----------------------------------------------------------
  {
    term: "LLM",
    aliases: ["Large Language Model", "大規模言語モデル"],
    category: "models",
    ja: "大量のテキストで学習した、次のトークンを予測する大規模なニューラルネット。文章生成・要約・コード生成など汎用的な言語タスクをこなす。",
    link: "https://en.wikipedia.org/wiki/Large_language_model",
  },
  {
    term: "Token",
    aliases: ["トークン"],
    category: "models",
    ja: "モデルがテキストを扱う最小単位（単語の断片など）。入出力の長さやコストはトークン数で測られる。",
    link: "https://platform.openai.com/tokenizer",
  },
  {
    term: "Context Window",
    aliases: ["コンテキストウィンドウ", "context length"],
    category: "models",
    ja: "モデルが一度に処理できるトークンの最大量。プロンプト＋応答がこの上限に収まる必要があり、長文処理やメモリ設計の制約になる。",
    link: "https://www.anthropic.com/news/100k-context-windows",
  },
  {
    term: "Hallucination",
    aliases: ["ハルシネーション", "幻覚"],
    category: "models",
    ja: "モデルが事実でない内容をもっともらしく生成してしまう現象。RAG・引用・検証で抑える。",
    link: "https://www.ibm.com/think/topics/ai-hallucinations",
  },
  {
    term: "Multimodal",
    aliases: ["マルチモーダル"],
    category: "models",
    ja: "テキストだけでなく画像・音声・動画など複数の種類の入出力を扱えるモデル。スクショ理解や図表生成などに広がる。",
    link: "https://platform.openai.com/docs/guides/vision",
  },
  {
    term: "Reasoning Model",
    aliases: ["推論モデル", "o1", "thinking"],
    category: "models",
    ja: "回答前に内部で長い思考（推論トークン）を費やすよう訓練されたモデル。難しい数学・コーディング・計画タスクで精度が上がる。",
    note: "OpenAI o 系、Claude の extended thinking 等。推論時計算（test-time compute）のトレンド。",
    link: "https://platform.openai.com/docs/guides/reasoning",
    trending: true,
  },
  {
    term: "Mixture of Experts",
    aliases: ["MoE", "専門家混合"],
    category: "models",
    ja: "複数の小さな「専門家」サブネットを持ち、入力ごとに一部だけを動かすモデル構造。総パラメータは大きくても計算は軽くできる。",
    link: "https://huggingface.co/blog/moe",
  },
  {
    term: "Quantization",
    aliases: ["量子化"],
    category: "models",
    ja: "モデルの重みを低ビット（int8/int4 等）に圧縮し、メモリと計算を削減する技術。ローカル LLM やエッジ実行で重要。",
    link: "https://huggingface.co/docs/optimum/concept_guides/quantization",
  },
  {
    term: "Local LLM",
    aliases: ["ローカルLLM", "on-device"],
    category: "models",
    ja: "自分の PC やサーバー上で動かす LLM。プライバシー・コスト・オフライン動作に利点。Ollama や量子化モデルで普及。",
    link: "https://ollama.com/",
  },

  // ---- Training / Tuning ------------------------------------------------
  {
    term: "Fine-tuning",
    aliases: ["ファインチューニング", "SFT"],
    category: "training",
    ja: "事前学習済みモデルを、特定タスク・スタイルのデータで追加学習して適応させる手法。少量データで振る舞いを寄せる。",
    link: "https://platform.openai.com/docs/guides/fine-tuning",
  },
  {
    term: "RLHF",
    aliases: ["人間のフィードバックによる強化学習"],
    category: "training",
    ja: "人間の好みを反映した報酬モデルで強化学習し、モデルを「役立つ・無害」に整える手法。ChatGPT 等の整列（alignment）の中核。",
    link: "https://huggingface.co/blog/rlhf",
  },
  {
    term: "DPO",
    aliases: ["Direct Preference Optimization", "直接選好最適化"],
    category: "training",
    ja: "報酬モデルを別途作らず、好まれた／好まれない応答の対から直接モデルを最適化する手法。RLHF より簡潔。",
    link: "https://arxiv.org/abs/2305.18290",
  },
  {
    term: "LoRA",
    aliases: ["Low-Rank Adaptation", "PEFT"],
    category: "training",
    ja: "元の重みを凍結し、小さな低ランク行列だけを学習する軽量ファインチューニング。少ない計算・メモリで適応できる。",
    link: "https://huggingface.co/docs/peft/conceptual_guides/lora",
  },
  {
    term: "Distillation",
    aliases: ["蒸留", "knowledge distillation"],
    category: "training",
    ja: "大きな教師モデルの出力を使って小さな生徒モデルを訓練し、性能を保ちつつ軽量化する手法。",
    link: "https://huggingface.co/blog/Kseniase/kd",
  },
  {
    term: "Alignment",
    aliases: ["アライメント", "整列"],
    category: "training",
    ja: "モデルの振る舞いを人間の意図・価値観・安全性に合わせること。RLHF・憲法 AI・評価などで実現する。",
    link: "https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback",
  },

  // ---- Evaluation -------------------------------------------------------
  {
    term: "LLM-as-a-Judge",
    aliases: ["LLMによる採点"],
    category: "evaluation",
    ja: "別の LLM に出力を採点させて品質を自動評価する手法。人手評価をスケールさせるが、バイアスに注意が必要。",
    link: "https://huggingface.co/learn/cookbook/en/llm_judge",
  },
  {
    term: "Benchmark",
    aliases: ["ベンチマーク", "SWE-bench", "MMLU"],
    category: "evaluation",
    ja: "モデル性能を比較するための標準テスト集（MMLU, SWE-bench 等）。コーディング・推論・知識など領域ごとにある。",
    link: "https://www.swebench.com/",
  },
  {
    term: "Golden Dataset",
    aliases: ["ゴールデンデータセット", "eval set"],
    category: "evaluation",
    ja: "正解が確定した評価用データ。プロンプトやモデル変更の前後で品質を比較する基準になる。",
    link: "https://hamel.dev/blog/posts/evals/",
  },

  // ---- Practice / Culture -----------------------------------------------
  {
    term: "Rubber Duck Debugging",
    aliases: ["ラバーダック", "rubber ducking", "second opinion"],
    category: "culture",
    ja: "問題をアヒルのおもちゃ（や他者）に声に出して説明することで、自分で原因に気づくデバッグ手法。AI 時代は「別モデルに説明して第二の視点を得る」形に発展している。",
    note: "GitHub Copilot CLI の『model families for a second opinion』のように、複数モデルで相互レビューする使い方が広がっている。",
    link: "https://github.blog/ai-and-ml/github-copilot/github-copilot-cli-combines-model-families-for-a-second-opinion/",
    trending: true,
  },
  {
    term: "Vibe Coding",
    aliases: ["バイブコーディング"],
    category: "culture",
    ja: "細部を自分で書かず、AI に意図を伝えて生成・修正を繰り返しながら作る開発スタイル。素早い試作に向く一方、検証と理解の置き去りに注意。",
    link: "https://en.wikipedia.org/wiki/Vibe_coding",
    trending: true,
  },
  {
    term: "Agentic Workflow",
    aliases: ["エージェンティックワークフロー"],
    category: "culture",
    ja: "単発プロンプトでなく、計画・実行・検証・反復をエージェントに任せる作業の組み立て方。再利用可能な手順としてワークフロー化する。",
    link: "https://github.blog/ai-and-ml/github-copilot/",
  },
  {
    term: "AI-Native Development",
    aliases: ["AIネイティブ開発"],
    category: "culture",
    ja: "AI を後付けのツールでなく開発フローの中心に据える進め方。設計・実装・レビュー・運用の各段で AI を前提に組む。",
    link: "https://aws.amazon.com/blogs/machine-learning/",
  },
  {
    term: "Spec-Driven Development",
    aliases: ["仕様駆動開発"],
    category: "culture",
    ja: "自然言語の仕様を起点に、AI に実装・テストを生成させる開発手法。曖昧さを仕様側で減らし、生成物の検証可能性を高める。",
    link: "https://github.blog/ai-and-ml/",
  },
  {
    term: "Token Efficiency",
    aliases: ["トークン効率"],
    category: "culture",
    ja: "同じ成果をより少ないトークンで達成する工夫。コンテキストの圧縮・要約・選別で、コストと速度と精度を同時に改善する。",
    link: "https://github.blog/ai-and-ml/github-copilot/",
  },
];

export const GLOSSARY_TRENDING: readonly GlossaryTerm[] = GLOSSARY.filter((t) => t.trending);

export function glossaryByCategory(): Array<{ category: GlossaryCategory; items: GlossaryTerm[] }> {
  return GLOSSARY_CATEGORY_ORDER.map((category) => ({
    category,
    items: GLOSSARY.filter((t) => t.category === category),
  })).filter((g) => g.items.length > 0);
}
