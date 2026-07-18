import { defineConfig, devices } from "@playwright/test";

const PREVIEW_COMMAND =
  "npm --prefix web run preview -- --host 127.0.0.1 --port 4322";

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
  retries: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4322",
    trace: "on-first-retry",
  },
  webServer: {
    command: playwrightWebServerCommand(
      process.env.PLAYWRIGHT_REUSE_BUILD === "1",
    ),
    url: "http://127.0.0.1:4322",
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
