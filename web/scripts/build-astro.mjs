import { spawn } from "node:child_process";

const HEARTBEAT_MS = 30_000;
const startedAt = Date.now();
const command = process.platform === "win32" ? "astro.cmd" : "astro";

console.log("BUILD: Astro static generation started");

const child = spawn(command, ["build", "--silent"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

const heartbeat = setInterval(() => {
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`BUILD: Astro static generation in progress (${elapsedSeconds}s)`);
}, HEARTBEAT_MS);

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`Astro build terminated by ${signal}`));
      return;
    }
    resolve(code ?? 1);
  });
}).finally(() => {
  clearInterval(heartbeat);
});

if (exitCode !== 0) {
  throw new Error(`Astro build failed with exit code ${exitCode}`);
}

const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
console.log(`BUILD: Astro static generation completed (${elapsedSeconds}s)`);
