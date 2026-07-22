import { describe, expect, it, vi } from "vitest";
import {
  assertDeploySnapshot,
  commandInvocation,
  runLegacyPagesDeploy,
} from "../web/scripts/deploy-pages-legacy.mjs";

const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);

function snapshot(overrides: Record<string, string> = {}) {
  return {
    branch: "main",
    status: "",
    head: SHA,
    remoteHead: SHA,
    commitMessage: "chore(data): current snapshot",
    ...overrides,
  };
}

describe("legacy Pages deploy CAS guard", () => {
  it.each([
    [snapshot({ branch: "feature" }), "requires branch main"],
    [snapshot({ status: " M data/index.json" }), "requires a clean worktree"],
    [snapshot({ remoteHead: NEXT_SHA }), "does not match origin/main"],
  ])("rejects an unsafe starting snapshot", (state, message) => {
    expect(() => assertDeploySnapshot(state, "before build")).toThrow(message);
  });

  it("pins the verified main SHA into the upload and rechecks after deploy", async () => {
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot());
    const runCommand = vi.fn();

    await runLegacyPagesDeploy({ readSnapshot, runCommand });

    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["run", "build"],
      expect.any(String),
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "npx",
      expect.arrayContaining([
        "pages",
        "deploy",
        `--commit-hash=${SHA}`,
        "--commit-message=chore(data): current snapshot",
        "--commit-dirty=false",
      ]),
      expect.any(String),
    );
  });

  it("aborts before upload when main advances during the build", async () => {
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({
        remoteHead: NEXT_SHA,
      }));
    const runCommand = vi.fn();

    await expect(
      runLegacyPagesDeploy({ readSnapshot, runCommand }),
    ).rejects.toThrow("origin/main advanced during legacy deploy");
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("fails visibly when main advances while files are uploading", async () => {
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({
        remoteHead: NEXT_SHA,
      }));
    const runCommand = vi.fn();

    await expect(
      runLegacyPagesDeploy({ readSnapshot, runCommand }),
    ).rejects.toThrow("origin/main advanced during legacy deploy");
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("uses cmd.exe with fixed safe tokens on Windows", () => {
    const invocation = commandInvocation(
      "npx",
      [
        "--yes",
        "wrangler@4.85.0",
        "pages",
        "deploy",
        "dist",
        "--commit-hash=abc123",
        "--commit-message=message with spaces & shell syntax",
      ],
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    );

    expect(invocation).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npx --yes wrangler@4.85.0 pages deploy dist --commit-hash=abc123",
      ],
      shell: false,
    });
  });

  it("rejects unsafe Windows command tokens instead of enabling a shell injection", () => {
    expect(() =>
      commandInvocation(
        "npx",
        ["pages", "deploy", "dist&whoami"],
        "win32",
        "cmd.exe",
      )
    ).toThrow("unsafe token");
  });
});
