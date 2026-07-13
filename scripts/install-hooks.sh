#!/usr/bin/env bash
# git hooks をリポジトリ管理 (scripts/git-hooks/) に切り替える。
# クローン後に 1 度だけ実行: bash scripts/install-hooks.sh

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

git config core.hooksPath scripts/git-hooks
chmod +x scripts/git-hooks/*

echo "[install-hooks] core.hooksPath=scripts/git-hooks に設定しました"
echo "[install-hooks] 有効な hook: $(ls scripts/git-hooks | tr '\n' ' ')"
echo
echo "【pre-commit】"
echo "  main / master / develop への直接 commit を拒否します。"
echo "  ステージ済みファイルの secret scan を実行します。"
echo "  .ts/.tsx ファイルがステージされていると npm run typecheck を実行します。"
echo "  スキップ: SKIP_TYPECHECK=1 git commit"
echo
echo "【pre-push】"
echo "  main / master / develop への直接 push を拒否します。"
echo "  push 対象 commit range の secret scan を実行します。"
echo "  push 前に npm test (unit) を実行します。失敗時は push を中断します。"
echo "  テストスキップ: SKIP_TESTS=1 git push"
echo "  続けて npm run test:e2e (Playwright) を実行します。"
echo "  E2E スキップ: SKIP_E2E=1 git push"
echo "  main への push で worker/ に差分があれば、RUN_WORKER_DEPLOY=1 の場合だけ wrangler deploy も実行します。"
echo "  deploy opt-in: RUN_WORKER_DEPLOY=1 git push"
echo "  protected branch の例外は、当該セッションでユーザーが直接書き込みを明示承認した場合のみ:"
echo "  ALLOW_PROTECTED_BRANCH_WRITE=1 git commit / git push"
