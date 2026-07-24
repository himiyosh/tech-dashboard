import { defineConfig, devices } from "@playwright/test";

const configuredPort = Number.parseInt(process.env.PLAYWRIGHT_PREVIEW_PORT ?? "4322", 10);
const previewPort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort
  : 4322;
const previewUrl = `http://127.0.0.1:${previewPort}`;
const previewCommand =
  `npm --prefix web run preview -- --host 127.0.0.1 --port ${previewPort}`;

export function playwrightWebServerCommand(
  reuseBuild: boolean,
  command = previewCommand,
): string {
  return reuseBuild
    ? command
    : `npm --prefix web run build && ${command}`;
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
