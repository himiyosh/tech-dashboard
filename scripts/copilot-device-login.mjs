// Copilot device-flow login (LL-109 gap filler).
//
// `gh auth token` returns a gho_ OAuth-App token that CANNOT exchange for a
// Copilot token (/copilot_internal/v2/token returns 404; see LL-106/108). The
// only credential that works is a ghu_ user-to-server token minted against the
// editor Copilot GitHub App via the OAuth Device Flow. `setup-copilot-auth.sh`
// does not do device flow, so this script fills that gap.
//
// It prints ONLY the user_code + verification URL (these are meant to be shown),
// polls until you authorize in the browser, then writes COPILOT_PAT=<ghu_...> to
// .env.local (mode 600). The token VALUE is never printed (R-003/LL-011).
//
// Usage:
//   npx tsx scripts/copilot-device-login.mjs
//   node scripts/copilot-device-login.mjs
// Then:
//   npm run summaries:backfill   # reads COPILOT_PAT from .env.local

import fs from "node:fs";
import path from "node:path";

// Public, well-known client_id of the editor Copilot GitHub App (not a secret).
const CLIENT_ID = process.env.COPILOT_CLIENT_ID ?? "Iv1.b507a08c87ecfe98";
const SCOPE = "read:user";
const ENV_FILE = path.resolve(process.cwd(), ".env.local");

const HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "GitHubCopilotChat/0.22.0",
  "editor-version": "vscode/1.95.0",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function requestDeviceCode() {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!res.ok) {
    throw new Error(`device/code HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const d = await res.json();
  if (!d.device_code || !d.user_code) {
    throw new Error(`device/code unexpected response: ${JSON.stringify(d).slice(0, 200)}`);
  }
  return d; // { device_code, user_code, verification_uri, expires_in, interval }
}

async function pollForToken(deviceCode, intervalSec, expiresInSec) {
  let interval = Math.max(5, intervalSec || 5);
  const deadline = Date.now() + (expiresInSec || 900) * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("device code expired before authorization");
    await sleep(interval * 1000);
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const d = await res.json().catch(() => ({}));
    if (d.access_token) return d.access_token;
    switch (d.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        interval += 5;
        break;
      case "expired_token":
        throw new Error("device code expired; re-run the script");
      case "access_denied":
        throw new Error("authorization was denied in the browser");
      default:
        if (d.error) throw new Error(`oauth error: ${d.error} ${d.error_description ?? ""}`);
    }
    process.stdout.write(".");
  }
}

async function verifyCopilot(pat) {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${pat}`,
      "user-agent": HEADERS["user-agent"],
      "editor-version": HEADERS["editor-version"],
    },
  });
  return res.ok;
}

function writeEnvLocal(pat) {
  let lines = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => !/^COPILOT_PAT=/.test(l));
  }
  lines = lines.filter((l) => l.trim() !== "");
  lines.push(`COPILOT_PAT=${pat}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
}

async function main() {
  console.log("Copilot device-flow login (mints a ghu_ token usable with the Copilot API)\n");
  const dc = await requestDeviceCode();
  const url = dc.verification_uri || "https://github.com/login/device";
  console.log("  1. Open this URL in your browser:");
  console.log(`       ${url}`);
  console.log("  2. Enter this one-time code:");
  console.log(`\n       ${dc.user_code}\n`);
  console.log(`  (code expires in ~${Math.round((dc.expires_in || 900) / 60)} min; waiting for authorization`);
  process.stdout.write("   ");

  const pat = await pollForToken(dc.device_code, dc.interval, dc.expires_in);
  console.log("\n\nOK: authorized.");

  process.stdout.write("Verifying Copilot access... ");
  const ok = await verifyCopilot(pat);
  if (!ok) {
    console.error(
      "FAILED: the token did not exchange for a Copilot token. " +
        "Is GitHub Copilot enabled on this account? Not writing .env.local.",
    );
    process.exit(1);
  }
  console.log("OK (Copilot enabled).");

  writeEnvLocal(pat);
  console.log(`\nOK: wrote COPILOT_PAT to ${ENV_FILE} (mode 600). The token value was not printed.`);
  console.log("Next: npm run summaries:backfill");
}

main().catch((err) => {
  console.error(`\nERR: ${err.message || err}`);
  process.exit(1);
});
