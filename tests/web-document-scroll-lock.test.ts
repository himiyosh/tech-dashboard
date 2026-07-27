import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  createScrollLockController,
  type ScrollLockAdapter,
} from "../web/src/lib/document-scroll-lock.ts";

describe("createScrollLockController", () => {
  it("captures and applies once, then restores the exact captured snapshot", () => {
    const snapshot = { scrollX: 4, scrollY: 820, bodyStyle: "color: red" };
    const adapter: ScrollLockAdapter<typeof snapshot> = {
      capture: vi.fn(() => snapshot),
      apply: vi.fn(),
      restore: vi.fn(),
    };
    const lock = createScrollLockController(adapter);

    expect(lock.locked).toBe(false);
    expect(lock.lock()).toBe(true);
    expect(lock.lock()).toBe(false);
    expect(lock.locked).toBe(true);
    expect(adapter.capture).toHaveBeenCalledTimes(1);
    expect(adapter.apply).toHaveBeenCalledTimes(1);
    expect(adapter.apply).toHaveBeenCalledWith(snapshot);

    expect(lock.unlock()).toBe(true);
    expect(lock.unlock()).toBe(false);
    expect(lock.locked).toBe(false);
    expect(adapter.restore).toHaveBeenCalledTimes(1);
    expect(adapter.restore).toHaveBeenCalledWith(snapshot);
  });

  it("keeps the lock active when restoration fails so cleanup can be retried", () => {
    const snapshot = { scrollX: 0, scrollY: 320 };
    const adapter: ScrollLockAdapter<typeof snapshot> = {
      capture: () => snapshot,
      apply: vi.fn(),
      restore: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("restore failed");
        })
        .mockImplementationOnce(() => undefined),
    };
    const lock = createScrollLockController(adapter);

    lock.lock();
    expect(() => lock.unlock()).toThrow("restore failed");
    expect(lock.locked).toBe(true);
    expect(lock.unlock()).toBe(true);
    expect(lock.locked).toBe(false);
  });
});

describe("Portal menu scroll-lock wiring", () => {
  it("uses one controller across native dialog open and close paths", () => {
    const portal = readFileSync(
      new URL("../web/src/layouts/Portal.astro", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(
      new URL("../web/src/styles/portal.css", import.meta.url),
      "utf8",
    );

    expect(portal).toContain('import { createDocumentScrollLock } from "../lib/document-scroll-lock.ts";');
    expect(portal).toContain("const menuScrollLock = createDocumentScrollLock();");
    expect(portal).toContain("menuScrollLock.lock();");
    expect(portal).toContain("menuScrollLock.unlock();");
    expect(styles).toMatch(/\.site-menu-list\s*\{[\s\S]*overscroll-behavior:\s*contain;/);
  });
});
