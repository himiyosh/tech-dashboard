export interface ScrollLockAdapter<Snapshot> {
  capture(): Snapshot;
  apply(snapshot: Snapshot): void;
  restore(snapshot: Snapshot): void;
}

export interface ScrollLockController {
  readonly locked: boolean;
  lock(): boolean;
  unlock(): boolean;
}

interface InlineStyleValue {
  value: string;
  priority: string;
}

interface DocumentScrollLockSnapshot {
  scrollX: number;
  scrollY: number;
  scrollbarWidth: number;
  bodyPaddingRight: number;
  html: Record<string, InlineStyleValue>;
  body: Record<string, InlineStyleValue>;
}

const HTML_LOCKED_PROPERTIES = [
  "overflow",
  "overscroll-behavior",
  "scroll-behavior",
] as const;

const BODY_LOCKED_PROPERTIES = [
  "position",
  "top",
  "left",
  "right",
  "width",
  "overflow",
  "overscroll-behavior",
  "padding-right",
] as const;

function captureInlineStyles(
  element: HTMLElement,
  properties: readonly string[],
): Record<string, InlineStyleValue> {
  return Object.fromEntries(
    properties.map((property) => [
      property,
      {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      },
    ]),
  );
}

function restoreInlineStyles(
  element: HTMLElement,
  styles: Record<string, InlineStyleValue>,
): void {
  for (const [property, { value, priority }] of Object.entries(styles)) {
    if (value) element.style.setProperty(property, value, priority);
    else element.style.removeProperty(property);
  }
}

function setLockedStyle(
  element: HTMLElement,
  property: string,
  value: string,
): void {
  element.style.setProperty(property, value, "important");
}

export function createScrollLockController<Snapshot>(
  adapter: ScrollLockAdapter<Snapshot>,
): ScrollLockController {
  let snapshot: Snapshot | null = null;

  return {
    get locked() {
      return snapshot !== null;
    },
    lock() {
      if (snapshot !== null) return false;
      const next = adapter.capture();
      adapter.apply(next);
      snapshot = next;
      return true;
    },
    unlock() {
      if (snapshot === null) return false;
      adapter.restore(snapshot);
      snapshot = null;
      return true;
    },
  };
}

export function createDocumentScrollLock(
  targetWindow: Window = window,
  targetDocument: Document = document,
): ScrollLockController {
  const html = targetDocument.documentElement;
  const body = targetDocument.body;

  return createScrollLockController<DocumentScrollLockSnapshot>({
    capture() {
      const parsedPadding = Number.parseFloat(targetWindow.getComputedStyle(body).paddingRight);
      return {
        scrollX: targetWindow.scrollX,
        scrollY: targetWindow.scrollY,
        scrollbarWidth: Math.max(0, targetWindow.innerWidth - html.clientWidth),
        bodyPaddingRight: Number.isFinite(parsedPadding) ? parsedPadding : 0,
        html: captureInlineStyles(html, HTML_LOCKED_PROPERTIES),
        body: captureInlineStyles(body, BODY_LOCKED_PROPERTIES),
      };
    },
    apply(snapshot) {
      setLockedStyle(html, "scroll-behavior", "auto");
      setLockedStyle(html, "overflow", "hidden");
      setLockedStyle(html, "overscroll-behavior", "none");
      setLockedStyle(body, "position", "fixed");
      setLockedStyle(body, "top", `${-snapshot.scrollY}px`);
      setLockedStyle(body, "left", `${-snapshot.scrollX}px`);
      setLockedStyle(body, "right", "0");
      setLockedStyle(body, "width", "100%");
      setLockedStyle(body, "overflow", "hidden");
      setLockedStyle(body, "overscroll-behavior", "none");
      if (snapshot.scrollbarWidth > 0) {
        setLockedStyle(
          body,
          "padding-right",
          `${snapshot.bodyPaddingRight + snapshot.scrollbarWidth}px`,
        );
      }
    },
    restore(snapshot) {
      restoreInlineStyles(body, snapshot.body);
      restoreInlineStyles(html, {
        overflow: snapshot.html.overflow,
        "overscroll-behavior": snapshot.html["overscroll-behavior"],
      });
      targetWindow.scrollTo(snapshot.scrollX, snapshot.scrollY);
      restoreInlineStyles(html, {
        "scroll-behavior": snapshot.html["scroll-behavior"],
      });
    },
  });
}
