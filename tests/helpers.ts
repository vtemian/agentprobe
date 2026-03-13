/** Shared test helpers — async timing utilities used across test files. */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 20,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await delay(pollMs);
  }
}

export async function waitForCount(
  items: unknown[],
  count: number,
  timeoutMs: number,
  pollMs = 50,
): Promise<void> {
  const start = Date.now();
  while (items.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Expected ${count} item(s), got ${items.length} after ${timeoutMs}ms`);
    }
    await delay(pollMs);
  }
}
