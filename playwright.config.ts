import { defineConfig, devices } from "@playwright/test";

export function resolvePlaywrightPort(value = process.env.PLAYWRIGHT_PORT): number {
  const port = Number(value ?? "4322");
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`Invalid PLAYWRIGHT_PORT: ${value}`);
  }
  return port;
}
const previewPort = resolvePlaywrightPort();
const previewUrl = `http://127.0.0.1:${previewPort}`;
const PREVIEW_COMMAND =
  `npm --prefix web run preview -- --host 127.0.0.1 --port ${previewPort}`;

export function playwrightWebServerCommand(reuseBuild: boolean): string {
  return reuseBuild
    ? PREVIEW_COMMAND
    : `npm --prefix web run build && ${PREVIEW_COMMAND}`;
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
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
    reuseExistingServer: true,
    timeout: 300_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
