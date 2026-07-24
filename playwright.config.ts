import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PREVIEW_PORT_MIN = 12_000;
const PREVIEW_PORT_SPAN = 20_000;

export function playwrightPreviewPort(
  cwd = process.cwd(),
  explicitPort = process.env.PLAYWRIGHT_PORT,
): number {
  if (explicitPort !== undefined) {
    const port = Number(explicitPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
      throw new Error(`Invalid PLAYWRIGHT_PORT: ${explicitPort}`);
    }
    return port;
  }
  const hash = createHash("sha256").update(resolve(cwd)).digest().readUInt16BE(0);
  return PREVIEW_PORT_MIN + (hash % PREVIEW_PORT_SPAN);
}

export function playwrightWebServerCommand(
  reuseBuild: boolean,
  previewPort = playwrightPreviewPort(),
): string {
  const previewCommand =
    `npm --prefix web run preview -- --host 127.0.0.1 --port ${previewPort}`;
  return reuseBuild
    ? previewCommand
    : `npm --prefix web run build && ${previewCommand}`;
}

const previewPort = playwrightPreviewPort();
const previewUrl = `http://127.0.0.1:${previewPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  retries: 1,
  reporter: "list",
  use: {
    baseURL: previewUrl,
    trace: "on-first-retry",
  },
  webServer: {
    command: playwrightWebServerCommand(
      process.env.PLAYWRIGHT_REUSE_BUILD === "1",
    ),
    url: previewUrl,
    reuseExistingServer: false,
    timeout: 300_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
