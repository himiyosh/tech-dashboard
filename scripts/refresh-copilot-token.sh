#!/usr/bin/env bash
# refresh-copilot-token.sh
#
# Keep the workers' COPILOT_PAT (a GitHub user-to-server `ghu_` token) valid by
# refreshing it before it expires, then pushing it to the Cloudflare Worker
# secrets. `ghu_` tokens are short-lived (editor Copilot OAuth app: access token
# ~6-8h, refreshable with a `ghr_` refresh token). When the secret expires the
# summarizer's Copilot exchange starts failing and summaries stop (see LL-105).
#
# Two subcommands:
#   bootstrap  One-time interactive GitHub device flow. Obtains a `ghu_` access
#              token + `ghr_` refresh token, verifies the access token against
#              the Copilot token-exchange API, stores the refresh token in the
#              macOS Keychain, and pushes COPILOT_PAT to both Worker secrets.
#   refresh    Non-interactive. Reads the refresh token from Keychain, exchanges
#              it for a fresh `ghu_`, VERIFIES it (must return HTTP 200) BEFORE
#              pushing, updates the stored refresh token, and pushes the new
#              COPILOT_PAT to both Worker secrets. Safe to run from launchd/cron.
#
# Usage:
#   ./scripts/refresh-copilot-token.sh bootstrap
#   ./scripts/refresh-copilot-token.sh refresh
#
# Safety:
#   - A new access token is NEVER pushed to a Worker secret unless it first
#     returns HTTP 200 from the Copilot token-exchange API. A failed refresh
#     leaves the existing (still-working) secret untouched and exits non-zero.
#   - Secrets are never printed. Only token suffixes (last 4 chars) are logged.
#   - The refresh token lives in the macOS Keychain, never in the repo.
#
# Requirements: bash, curl, jq, npx wrangler (logged in), macOS `security` CLI.
#
# Notes / assumptions to confirm before first run:
#   - COPILOT_CLIENT_ID defaults to the editor Copilot OAuth app client id used
#     by open-source Copilot clients for device-flow token acquisition. Override
#     via the env var if your `ghu_` came from a different app. If GitHub does
#     not return a `refresh_token` during bootstrap, this app does not support
#     refresh for your account; re-run `bootstrap` periodically instead, or use
#     a different Copilot-capable OAuth app.

set -euo pipefail

# ------------------------------------------------------------------ config
COPILOT_CLIENT_ID="${COPILOT_CLIENT_ID:-Iv1.b507a08c87ecfe98}"
KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-techdb-copilot-refresh-token}"
KEYCHAIN_ACCOUNT="${KEYCHAIN_ACCOUNT:-$USER}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIRS=("$REPO_ROOT/worker" "$REPO_ROOT/worker-summarizer")
SECRET_NAME="COPILOT_PAT"
LOG_FILE="${COPILOT_REFRESH_LOG:-$REPO_ROOT/.copilot-token-refresh.log}"

DEVICE_CODE_URL="https://github.com/login/device/code"
ACCESS_TOKEN_URL="https://github.com/login/oauth/access_token"
COPILOT_EXCHANGE_URL="https://api.github.com/copilot_internal/v2/token"

# ------------------------------------------------------------------ logging
# ASCII-only markers; UTF-8 log written explicitly. Never log secret values.
log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >> "$LOG_FILE"
}
die() { log "ERR: $*"; exit 1; }

suffix() { # last 4 chars of a secret, for non-revealing logging
  local v="$1"
  printf '...%s' "${v: -4}"
}

require() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }

# ------------------------------------------------------------------ keychain
store_refresh_token() { # $1 = refresh token (ghr_)
  security add-generic-password -U \
    -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w "$1" \
    >/dev/null 2>&1 || die "failed to store refresh token in Keychain"
}
read_refresh_token() {
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null || true
}

# ------------------------------------------------------------------ copilot verify
# Returns 0 and echoes nothing on HTTP 200; non-zero otherwise. Never prints token.
verify_copilot_access() { # $1 = ghu_ access token
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: token $1" \
    -H "User-Agent: GitHubCopilotChat/0.22.0" \
    -H "Editor-Version: vscode/1.95.0" \
    "$COPILOT_EXCHANGE_URL" || true)"
  [ "$code" = "200" ]
}

# ------------------------------------------------------------------ push secret
push_secret() { # $1 = ghu_ access token
  local dir
  for dir in "${WORKER_DIRS[@]}"; do
    [ -f "$dir/wrangler.toml" ] || { log "WARN: no wrangler.toml in $dir, skipping"; continue; }
    # printf without trailing newline: wrangler stores the value verbatim.
    if printf '%s' "$1" | ( cd "$dir" && npx --yes wrangler secret put "$SECRET_NAME" >/dev/null 2>&1 ); then
      log "OK: pushed $SECRET_NAME to worker in $(basename "$dir")"
    else
      die "failed to push $SECRET_NAME to worker in $(basename "$dir")"
    fi
  done
}

# ------------------------------------------------------------------ bootstrap
cmd_bootstrap() {
  require curl; require jq; require security; require npx
  log "bootstrap: starting GitHub device flow (client_id=$COPILOT_CLIENT_ID)"

  local dc_json device_code user_code verify_uri interval
  dc_json="$(curl -sS -X POST "$DEVICE_CODE_URL" \
    -H 'Accept: application/json' \
    -d "client_id=$COPILOT_CLIENT_ID" -d 'scope=read:user' || true)"
  device_code="$(printf '%s' "$dc_json" | jq -r '.device_code // empty')"
  user_code="$(printf '%s' "$dc_json" | jq -r '.user_code // empty')"
  verify_uri="$(printf '%s' "$dc_json" | jq -r '.verification_uri // empty')"
  interval="$(printf '%s' "$dc_json" | jq -r '.interval // 5')"
  [ -n "$device_code" ] || die "device code request failed: $(printf '%s' "$dc_json" | head -c 200)"

  printf '\n  Open %s and enter code: %s\n\n' "$verify_uri" "$user_code"
  log "bootstrap: waiting for you to authorize in the browser..."

  local at_json access refresh err
  while true; do
    sleep "$interval"
    at_json="$(curl -sS -X POST "$ACCESS_TOKEN_URL" \
      -H 'Accept: application/json' \
      -d "client_id=$COPILOT_CLIENT_ID" \
      -d "device_code=$device_code" \
      -d 'grant_type=urn:ietf:params:oauth:grant-type:device_code' || true)"
    err="$(printf '%s' "$at_json" | jq -r '.error // empty')"
    access="$(printf '%s' "$at_json" | jq -r '.access_token // empty')"
    if [ -n "$access" ]; then break; fi
    case "$err" in
      authorization_pending) continue ;;
      slow_down) interval=$((interval + 5)); continue ;;
      "") die "unexpected token response: $(printf '%s' "$at_json" | head -c 200)" ;;
      *) die "device flow error: $err" ;;
    esac
  done

  refresh="$(printf '%s' "$at_json" | jq -r '.refresh_token // empty')"
  log "bootstrap: received access token $(suffix "$access")"

  verify_copilot_access "$access" || die "access token did NOT pass Copilot exchange (account lacks Copilot, or wrong app)"
  log "OK: access token verified against Copilot exchange"

  if [ -n "$refresh" ]; then
    store_refresh_token "$refresh"
    log "OK: refresh token stored in Keychain (service=$KEYCHAIN_SERVICE)"
  else
    log "WARN: GitHub did not return a refresh_token for this app. Auto-refresh"
    log "WARN: will not work; re-run 'bootstrap' periodically, or use a"
    log "WARN: Copilot-capable OAuth app that issues refresh tokens."
  fi

  push_secret "$access"
  log "bootstrap: done"
}

# ------------------------------------------------------------------ refresh
cmd_refresh() {
  require curl; require jq; require security; require npx
  local refresh
  refresh="$(read_refresh_token)"
  [ -n "$refresh" ] || die "no refresh token in Keychain. Run 'bootstrap' first."

  log "refresh: exchanging refresh token for a new access token"
  local resp access new_refresh err
  resp="$(curl -sS -X POST "$ACCESS_TOKEN_URL" \
    -H 'Accept: application/json' \
    -d "client_id=$COPILOT_CLIENT_ID" \
    -d 'grant_type=refresh_token' \
    -d "refresh_token=$refresh" || true)"
  err="$(printf '%s' "$resp" | jq -r '.error // empty')"
  access="$(printf '%s' "$resp" | jq -r '.access_token // empty')"
  [ -z "$err" ] || die "refresh failed: $err (refresh token may be expired; re-run bootstrap)"
  [ -n "$access" ] || die "refresh returned no access_token: $(printf '%s' "$resp" | head -c 200)"

  # Verify BEFORE pushing so a bad token never replaces a working secret.
  verify_copilot_access "$access" || die "new access token failed Copilot exchange; keeping existing secret"
  log "OK: new access token $(suffix "$access") verified"

  new_refresh="$(printf '%s' "$resp" | jq -r '.refresh_token // empty')"
  if [ -n "$new_refresh" ]; then
    store_refresh_token "$new_refresh"
    log "OK: rotated refresh token in Keychain"
  fi

  push_secret "$access"
  log "refresh: done (secret reflects immediately; no Worker redeploy needed)"
}

# ------------------------------------------------------------------ main
main() {
  case "${1:-}" in
    bootstrap) cmd_bootstrap ;;
    refresh)   cmd_refresh ;;
    *) printf 'usage: %s {bootstrap|refresh}\n' "$0" >&2; exit 2 ;;
  esac
}
main "$@"
