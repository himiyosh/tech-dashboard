#!/usr/bin/env bash
# setup-copilot-auth.sh
#
# Copilot Chat API を叩くためのトークン (COPILOT_PAT) を取得し、
#   1. リポジトリ直下の .env.local に書き出す
#   2. GitHub Actions Secret に登録する (任意)
#   3. Cloudflare Pages 環境変数に登録する (任意)
# を対話的に実行する。
#
# 使い方:
#   ./scripts/setup-copilot-auth.sh          # 対話的にすべて実行
#   ./scripts/setup-copilot-auth.sh --rotate # 既存トークンを更新
#
# 前提:
#   - Copilot Enterprise / Business / Individual のいずれかが有効な GitHub アカウント
#   - gh CLI (推奨) または手動で classic PAT を発行できる環境
#   - [Cloudflare 連携する場合のみ] wrangler がインストール済み & `wrangler login` 済み

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"
TOKEN_KEY="COPILOT_PAT"

say()  { printf "\033[36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[33m!!!\033[0m %s\n" "$*" >&2; }
err()  { printf "\033[31mERR\033[0m %s\n" "$*" >&2; }
ok()   { printf "\033[32mOK \033[0m %s\n" "$*"; }

# ------------------------------------------------------------------
# 1. トークン取得
# ------------------------------------------------------------------
get_token() {
  echo
  say "トークン取得方法を選んでください:"
  echo "   [1] gh CLI から抽出 (gh auth login 済みが前提 / 最も簡単)"
  echo "   [2] classic PAT を手入力 (Web で発行済み)"
  echo "   [3] 既存の .env.local から読み込み (内容確認のみ)"
  read -rp "選択 [1/2/3]: " choice

  case "$choice" in
    1)
      if ! command -v gh >/dev/null 2>&1; then
        err "gh CLI が見つかりません。 https://cli.github.com/ からインストールしてください"
        echo "   macOS: brew install gh"
        return 1
      fi
      if ! gh auth status >/dev/null 2>&1; then
        say "gh にログインしていないようです。ブラウザ認証を開始します..."
        gh auth login --hostname github.com --git-protocol https --web --scopes read:user
      fi
      TOKEN="$(gh auth token 2>/dev/null || true)"
      if [[ -z "${TOKEN:-}" ]]; then
        err "gh auth token の取得に失敗しました"
        return 1
      fi
      ok "gh からトークンを取得しました (末尾4文字: ...${TOKEN: -4})"
      ;;
    2)
      echo
      say "classic PAT を発行するには:"
      echo "   1. https://github.com/settings/tokens にアクセス"
      echo "   2. 'Generate new token (classic)' をクリック"
      echo "   3. Scope は read:user のみで OK"
      echo "   4. 有効期限は 90 日など任意"
      echo
      read -rsp "PAT を貼り付け (画面には表示されません): " TOKEN
      echo
      if [[ ! "$TOKEN" =~ ^gh[ps]_[A-Za-z0-9]{20,} ]]; then
        warn "フォーマットが classic PAT (ghp_... / ghs_...) と一致しないようですが続行します"
      fi
      ok "PAT を受け取りました (末尾4文字: ...${TOKEN: -4})"
      ;;
    3)
      if [[ ! -f "$ENV_FILE" ]]; then
        err ".env.local が見つかりません: $ENV_FILE"
        return 1
      fi
      TOKEN="$(grep -E "^${TOKEN_KEY}=" "$ENV_FILE" | head -1 | sed "s/^${TOKEN_KEY}=//" | tr -d '"' || true)"
      if [[ -z "$TOKEN" ]]; then
        err ".env.local に $TOKEN_KEY が見つかりません"
        return 1
      fi
      ok "既存トークンを読み込みました (末尾4文字: ...${TOKEN: -4})"
      ;;
    *)
      err "不明な選択: $choice"
      return 1
      ;;
  esac
  export TOKEN
}

# ------------------------------------------------------------------
# 2. トークン検証 (Copilot Chat API に通るか軽くチェック)
# ------------------------------------------------------------------
verify_token() {
  say "Copilot トークン交換 API でトークンを検証中..."
  local resp status
  resp="$(curl -sS -o /tmp/copilot-check.json -w "%{http_code}" \
    -H "Authorization: token $TOKEN" \
    -H "User-Agent: GitHubCopilotChat/0.22.0" \
    -H "Editor-Version: vscode/1.95.0" \
    https://api.github.com/copilot_internal/v2/token || true)"
  status="$resp"
  if [[ "$status" == "200" ]]; then
    ok "検証成功 (Copilot Enterprise/Business/Individual 権限を確認)"
    rm -f /tmp/copilot-check.json
    return 0
  fi
  err "検証失敗: HTTP $status"
  if [[ -f /tmp/copilot-check.json ]]; then
    sed -e 's/^/    /' /tmp/copilot-check.json >&2 || true
    rm -f /tmp/copilot-check.json
  fi
  warn "Copilot が有効なアカウントの PAT か、スコープが正しいか確認してください"
  return 1
}

# ------------------------------------------------------------------
# 3. .env.local への書き込み
# ------------------------------------------------------------------
write_env_local() {
  say ".env.local に書き込み中..."
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # 既存の COPILOT_PAT 行を除去してから追記
  if grep -q "^${TOKEN_KEY}=" "$ENV_FILE" 2>/dev/null; then
    local tmp
    tmp="$(mktemp)"
    grep -v "^${TOKEN_KEY}=" "$ENV_FILE" > "$tmp" || true
    mv "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  printf "%s=%s\n" "$TOKEN_KEY" "$TOKEN" >> "$ENV_FILE"
  ok "書き込み完了: $ENV_FILE (mode 600)"

  # .gitignore に含まれているか軽く確認
  if ! grep -qE "^\.env(\.local)?$" "$REPO_ROOT/.gitignore" 2>/dev/null; then
    warn ".gitignore に .env / .env.local が無い可能性があります。確認してください"
  fi
}

# ------------------------------------------------------------------
# 4. GitHub Actions Secret 登録 (任意)
# ------------------------------------------------------------------
register_gh_secret() {
  echo
  read -rp "GitHub Actions Secret として $TOKEN_KEY を登録しますか? [y/N]: " yn
  [[ "$yn" =~ ^[Yy]$ ]] || { say "スキップ"; return 0; }

  if ! command -v gh >/dev/null 2>&1; then
    err "gh CLI が必要です"
    return 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    err "gh にログインしていません。 gh auth login を先に実行してください"
    return 1
  fi

  local repo
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  if [[ -z "$repo" ]]; then
    err "カレントディレクトリが GitHub リポジトリとして認識されません"
    return 1
  fi

  say "repo: $repo に secret を登録中..."
  printf "%s" "$TOKEN" | gh secret set "$TOKEN_KEY" --repo "$repo" --body -
  ok "GitHub Secret 登録完了"
}

# ------------------------------------------------------------------
# 5. Cloudflare Pages 環境変数登録 (任意)
# ------------------------------------------------------------------
register_cf_pages() {
  echo
  warn "注意: この tech-dashboard は静的ビルドのため Cloudflare Pages では COPILOT_PAT を使いません。"
  warn "      将来 Pages Functions で要約 API を呼ぶ場合のみ必要です。"
  read -rp "それでも Cloudflare Pages に登録しますか? [y/N]: " yn
  [[ "$yn" =~ ^[Yy]$ ]] || { say "スキップ"; return 0; }

  if ! command -v wrangler >/dev/null 2>&1; then
    err "wrangler が必要です (npm i -g wrangler)"
    return 1
  fi

  read -rp "Cloudflare Pages プロジェクト名: " proj
  [[ -z "$proj" ]] && { err "プロジェクト名が空です"; return 1; }

  read -rp "対象環境 (production / preview) [production]: " envname
  envname="${envname:-production}"

  say "wrangler pages secret put $TOKEN_KEY --project-name=$proj (env: $envname)"
  printf "%s" "$TOKEN" | wrangler pages secret put "$TOKEN_KEY" \
    --project-name="$proj" \
    --env="$envname"
  ok "Cloudflare Pages 登録完了"
}

# ------------------------------------------------------------------
# main
# ------------------------------------------------------------------
main() {
  say "Copilot PAT セットアップ開始"
  get_token
  verify_token || {
    warn "検証に失敗しましたが、このまま .env.local に保存しますか? [y/N]"
    read -r yn
    [[ "$yn" =~ ^[Yy]$ ]] || { err "中断しました"; exit 1; }
  }
  write_env_local
  register_gh_secret
  register_cf_pages

  echo
  ok "すべて完了。動作確認:"
  echo "   cd $REPO_ROOT"
  echo "   set -a; source .env.local; set +a"
  echo "   SUMMARIZE_MAX_NEW=50 npm run collect"
}

main "$@"
