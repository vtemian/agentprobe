import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSubscriptions } from "@/core/runtime/subscriptions";

function createTestOptions(overrides: Record<string, unknown> = {}) {
  return {
    debounceMs: 50,
    onFileChanged: vi.fn(),
    isStartedWithToken: vi.fn(() => true),
    canSubscribeWithToken: vi.fn(() => true),
    emitError: vi.fn(),
    ...overrides,
  };
}

function createCallbackHolder() {
  const holder: { fire: () => void } = { fire: () => {} };
  return {
    capture: (fn: () => void) => {
      holder.fire = fn;
    },
    fire: () => holder.fire(),
  };
}

function createErrorCallbackHolder() {
  const holder: { fire: (error: Error) => void } = { fire: () => {} };
  return {
    capture: (fn: (error: Error) => void) => {
      holder.fire = fn;
    },
    fire: (error: Error) => holder.fire(error),
  };
}

describe("createRuntimeSubscriptions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("path normalization", () => {
    it("trims whitespace and deduplicates watch paths", () => {
      const subscribedPaths: string[] = [];
      const options = createTestOptions({
        watchPaths: ["  /a  ", "/b", " /a", "/b ", ""],
        subscribeToChanges: (watchPath: string) => {
          subscribedPaths.push(watchPath);
          return { close: vi.fn() };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);

      expect(subscribedPaths).toEqual(["/a", "/b"]);
    });

    it("falls back to getWatchPaths when watchPaths is empty", () => {
      const subscribedPaths: string[] = [];
      const options = createTestOptions({
        watchPaths: [],
        getWatchPaths: () => ["/from-getter"],
        subscribeToChanges: (watchPath: string) => {
          subscribedPaths.push(watchPath);
          return { close: vi.fn() };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);

      expect(subscribedPaths).toEqual(["/from-getter"]);
    });

    it("skips initialization when subscribeToChanges is not provided", () => {
      const emittedErrors: Error[] = [];
      const options = createTestOptions({
        watchPaths: ["/a"],
        subscribeToChanges: undefined,
        emitError: (error: Error) => {
          emittedErrors.push(error);
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);

      expect(emittedErrors).toHaveLength(0);
    });
  });

  describe("debouncing", () => {
    it("debounces rapid watch events into a single onFileChanged call", () => {
      let fileChangedCount = 0;
      const event = createCallbackHolder();
      const options = createTestOptions({
        watchPaths: ["/a"],
        onFileChanged: () => {
          fileChangedCount++;
        },
        subscribeToChanges: (_path: string, onEvent: () => void) => {
          event.capture(onEvent);
          return { close: vi.fn() };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);

      event.fire();
      event.fire();
      event.fire();

      expect(fileChangedCount).toBe(0);
      vi.advanceTimersByTime(50);
      expect(fileChangedCount).toBe(1);
    });

    it("clearDebounceTimer prevents pending refresh from firing", () => {
      let fileChangedCount = 0;
      const event = createCallbackHolder();
      const options = createTestOptions({
        watchPaths: ["/a"],
        onFileChanged: () => {
          fileChangedCount++;
        },
        subscribeToChanges: (_path: string, onEvent: () => void) => {
          event.capture(onEvent);
          return { close: vi.fn() };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);

      event.fire();
      subs.clearDebounceTimer();
      vi.advanceTimersByTime(100);

      expect(fileChangedCount).toBe(0);
    });

    it("ignores events when token is no longer current", () => {
      let fileChangedCount = 0;
      const event = createCallbackHolder();
      const isStartedWithToken = vi.fn(() => true);
      const options = createTestOptions({
        watchPaths: ["/a"],
        isStartedWithToken,
        onFileChanged: () => {
          fileChangedCount++;
        },
        subscribeToChanges: (_path: string, onEvent: () => void) => {
          event.capture(onEvent);
          return { close: vi.fn() };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);

      isStartedWithToken.mockReturnValue(false);
      event.fire();
      vi.advanceTimersByTime(100);

      expect(fileChangedCount).toBe(0);
    });
  });

  describe("closeSubscriptions", () => {
    it("closes all subscription handles", () => {
      const closeFns = [vi.fn(), vi.fn()];
      let callIndex = 0;
      const options = createTestOptions({
        watchPaths: ["/a", "/b"],
        subscribeToChanges: (_path: string, _onEvent: () => void) => {
          const close = closeFns[callIndex] ?? vi.fn();
          callIndex++;
          return { close };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);
      subs.closeSubscriptions();

      for (const close of closeFns) {
        expect(close).toHaveBeenCalled();
      }
    });

    it("pending debounce does not fire after clearDebounceTimer + close", () => {
      let fileChangedCount = 0;
      const event = createCallbackHolder();
      const options = createTestOptions({
        watchPaths: ["/a"],
        onFileChanged: () => {
          fileChangedCount++;
        },
        subscribeToChanges: (_path: string, onEvent: () => void) => {
          event.capture(onEvent);
          return { close: vi.fn() };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);

      event.fire();
      subs.clearDebounceTimer();
      subs.closeSubscriptions();

      vi.advanceTimersByTime(1000);
      expect(fileChangedCount).toBe(0);
    });

    it("emits error when a subscription close throws", () => {
      const emittedErrors: Error[] = [];
      const options = createTestOptions({
        watchPaths: ["/a"],
        emitError: (error: Error) => {
          emittedErrors.push(error);
        },
        subscribeToChanges: () => ({
          close: () => {
            throw new Error("close failed");
          },
        }),
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);
      subs.closeSubscriptions();

      expect(emittedErrors).toHaveLength(1);
      expect(emittedErrors[0]?.message).toBe("close failed");
    });
  });

  describe("resubscribe on error", () => {
    it("emits the error and resubscribes immediately", () => {
      const errorCb = createErrorCallbackHolder();
      let subscribeCount = 0;
      const emittedErrors: Error[] = [];
      const options = createTestOptions({
        watchPaths: ["/a"],
        emitError: (error: Error) => {
          emittedErrors.push(error);
        },
        subscribeToChanges: (
          _path: string,
          _onEvent: () => void,
          onError: (error: Error) => void,
        ) => {
          subscribeCount++;
          errorCb.capture(onError);
          return { close: vi.fn() };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);
      expect(subscribeCount).toBe(1);

      errorCb.fire(new Error("watch broken"));
      expect(emittedErrors).toHaveLength(1);
      expect(emittedErrors[0]?.message).toBe("watch broken");

      expect(subscribeCount).toBe(2);
    });

    it("schedules resubscribe with backoff when subscribe throws", () => {
      let attempt = 0;
      const emittedErrors: Error[] = [];
      const options = createTestOptions({
        watchPaths: ["/a"],
        emitError: (error: Error) => {
          emittedErrors.push(error);
        },
        subscribeToChanges: () => {
          attempt++;
          if (attempt <= 2) {
            throw new Error(`fail #${attempt}`);
          }
          return { close: vi.fn() };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);

      expect(attempt).toBe(1);
      expect(emittedErrors).toHaveLength(1);

      vi.advanceTimersByTime(500);
      expect(attempt).toBe(2);
      expect(emittedErrors).toHaveLength(2);

      vi.advanceTimersByTime(1000);
      expect(attempt).toBe(3);
      expect(emittedErrors).toHaveLength(2);
    });

    it("clearResubscribeTimers cancels pending resubscriptions", () => {
      let attempt = 0;
      const options = createTestOptions({
        watchPaths: ["/a"],
        subscribeToChanges: () => {
          attempt++;
          throw new Error("always fail");
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);
      expect(attempt).toBe(1);

      subs.clearResubscribeTimers();
      vi.advanceTimersByTime(10_000);
      expect(attempt).toBe(1);
    });
  });

  describe("dispose", () => {
    it("clears all timers and closes all subscriptions", () => {
      let fileChangedCount = 0;
      const event = createCallbackHolder();
      const closeFn = vi.fn();
      const options = createTestOptions({
        watchPaths: ["/a"],
        onFileChanged: () => {
          fileChangedCount++;
        },
        subscribeToChanges: (_path: string, onEvent: () => void) => {
          event.capture(onEvent);
          return { close: closeFn };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);

      event.fire();
      subs.dispose();

      vi.advanceTimersByTime(10_000);
      expect(fileChangedCount).toBe(0);
      expect(closeFn).toHaveBeenCalled();
    });
  });
});
