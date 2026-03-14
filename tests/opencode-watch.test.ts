import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeWatch } from "@/providers/opencode/watch";

describe("opencode watch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onEvent when data version changes", () => {
    let version = 1;
    const onEvent = vi.fn();
    const onError = vi.fn();
    const watch = createOpenCodeWatch({
      pollIntervalMs: 1000,
      getDataVersion: () => version,
    });

    const handle = watch.subscribe("unused", onEvent, onError);

    vi.advanceTimersByTime(1000);
    expect(onEvent).not.toHaveBeenCalled();

    version = 2;
    vi.advanceTimersByTime(1000);
    expect(onEvent).toHaveBeenCalledOnce();

    handle.close();
  });

  it("does not fire onEvent when data version stays the same", () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const watch = createOpenCodeWatch({
      pollIntervalMs: 500,
      getDataVersion: () => 1,
    });

    const handle = watch.subscribe("unused", onEvent, onError);

    vi.advanceTimersByTime(5000);
    expect(onEvent).not.toHaveBeenCalled();

    handle.close();
  });

  it("calls onError when getDataVersion throws", () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    let shouldThrow = false;
    const watch = createOpenCodeWatch({
      pollIntervalMs: 500,
      getDataVersion: () => {
        if (shouldThrow) {
          throw new Error("db gone");
        }
        return 1;
      },
    });

    const handle = watch.subscribe("unused", onEvent, onError);

    shouldThrow = true;
    vi.advanceTimersByTime(500);
    expect(onError).toHaveBeenCalledOnce();
    const firstArg: unknown = onError.mock.calls[0][0];
    expect(firstArg instanceof Error ? firstArg.message : "").toBe("db gone");

    handle.close();
  });

  it("stops polling after close", () => {
    let callCount = 0;
    const watch = createOpenCodeWatch({
      pollIntervalMs: 100,
      getDataVersion: () => {
        callCount++;
        return 1;
      },
    });

    const handle = watch.subscribe("unused", vi.fn(), vi.fn());
    vi.advanceTimersByTime(300);
    const countBeforeClose = callCount;

    handle.close();
    vi.advanceTimersByTime(1000);
    expect(callCount).toBe(countBeforeClose);
  });
});
