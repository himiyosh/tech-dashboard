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
echo "次回 main への git push 時に worker/ 差分があれば自動で wrangler deploy します。"
echo "スキップしたい場合: SKIP_WORKER_DEPLOY=1 git push"
