import { describe, expect, it } from "vitest";
import {
  isWatchRuntimeError,
  toError,
  WATCH_RUNTIME_ERROR_CODES,
  WatchRuntimeError,
} from "@/core/errors";

describe("toError", () => {
  it("returns the same instance when given an Error", () => {
    const original = new Error("already an error");
    expect(toError(original)).toBe(original);
  });

  it("wraps a string into an Error", () => {
    const result = toError("something broke");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("something broke");
  });

  it("JSON-stringifies a plain object", () => {
    const result = toError({ code: 42 });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('{"code":42}');
  });

  it("falls back to String() for non-serializable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = toError(circular);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("[object Object]");
  });

  it("handles null and undefined", () => {
    expect(toError(null).message).toBe("null");
    const undefinedError = toError(undefined);
    expect(undefinedError).toBeInstanceOf(Error);
  });

  it("handles numeric values", () => {
    expect(toError(404).message).toBe("404");
  });
});

describe("WatchRuntimeError", () => {
  it("sets name, code, and message", () => {
    const error = new WatchRuntimeError(WATCH_RUNTIME_ERROR_CODES.notRunning, "not running");
    expect(error.name).toBe("WatchRuntimeError");
    expect(error.code).toBe("NOT_RUNNING");
    expect(error.message).toBe("not running");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("isWatchRuntimeError", () => {
  it("returns true for WatchRuntimeError instances", () => {
    const error = new WatchRuntimeError(WATCH_RUNTIME_ERROR_CODES.notRunning, "test");
    expect(isWatchRuntimeError(error)).toBe(true);
  });

  it("returns false for plain Error instances", () => {
    expect(isWatchRuntimeError(new Error("plain"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isWatchRuntimeError("string")).toBe(false);
    expect(isWatchRuntimeError(null)).toBe(false);
    expect(isWatchRuntimeError(undefined)).toBe(false);
  });
});
