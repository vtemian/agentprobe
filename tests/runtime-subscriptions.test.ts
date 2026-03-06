import { createRuntimeSubscriptions } from "@/core/runtime/subscriptions";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

function createTestOptions(overrides: Record<string, unknown> = {}) {
  return {
    debounceMs: 50,
    queueRefresh: vi.fn(),
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
      const options = createTestOptions({
        watchPaths: ["/a"],
        subscribeToChanges: undefined,
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);

      expect(options.emitError).not.toHaveBeenCalled();
    });
  });

  describe("debouncing", () => {
    it("debounces rapid watch events into a single queueRefresh call", () => {
      const event = createCallbackHolder();
      const options = createTestOptions({
        watchPaths: ["/a"],
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

      expect(options.queueRefresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(options.queueRefresh).toHaveBeenCalledOnce();
    });

    it("clearDebounceTimer prevents pending refresh from firing", () => {
      const event = createCallbackHolder();
      const options = createTestOptions({
        watchPaths: ["/a"],
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

      expect(options.queueRefresh).not.toHaveBeenCalled();
    });

    it("ignores events when token is no longer current", () => {
      const event = createCallbackHolder();
      const isStartedWithToken = vi.fn(() => true);
      const options = createTestOptions({
        watchPaths: ["/a"],
        isStartedWithToken,
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

      expect(options.queueRefresh).not.toHaveBeenCalled();
    });
  });

  describe("closeSubscriptions", () => {
    it("closes all active subscriptions", () => {
      const closeFns = [vi.fn(), vi.fn()];
      let callIndex = 0;
      const options = createTestOptions({
        watchPaths: ["/a", "/b"],
        subscribeToChanges: () => {
          const close = closeFns[callIndex] ?? vi.fn();
          callIndex++;
          return { close };
        },
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);
      subs.closeSubscriptions();

      for (const close of closeFns) {
        expect(close).toHaveBeenCalledOnce();
      }
    });

    it("emits error when a subscription close throws", () => {
      const options = createTestOptions({
        watchPaths: ["/a"],
        subscribeToChanges: () => ({
          close: () => {
            throw new Error("close failed");
          },
        }),
      });

      const subs = createRuntimeSubscriptions(options);
      subs.initializeSubscriptions(1);
      subs.closeSubscriptions();

      expect(options.emitError).toHaveBeenCalledOnce();
    });
  });

  describe("resubscribe on error", () => {
    it("emits the error and schedules resubscription", () => {
      const errorCb = createErrorCallbackHolder();
      let subscribeCount = 0;
      const options = createTestOptions({
        watchPaths: ["/a"],
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
      expect(options.emitError).toHaveBeenCalledOnce();

      expect(subscribeCount).toBe(2);
    });

    it("schedules resubscribe with backoff when subscribe throws", () => {
      let attempt = 0;
      const options = createTestOptions({
        watchPaths: ["/a"],
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
      expect(options.emitError).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(500);
      expect(attempt).toBe(2);
      expect(options.emitError).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1000);
      expect(attempt).toBe(3);
      expect(options.emitError).toHaveBeenCalledTimes(2);
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
});
