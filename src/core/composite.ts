import { toError } from "./errors";
import type { CanonicalAgentSnapshot } from "./model";
import type {
  CanonicalSnapshot,
  DiscoveryInput,
  DiscoveryResult,
  TranscriptProvider,
  TranscriptReadResult,
} from "./providers";

const DEFAULT_WATCH_DEBOUNCE_MS = 150;

function groupByKey<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key) ?? [];
    group.push(item);
    map.set(key, group);
  }
  return map;
}

export function createCompositeProvider(providers: TranscriptProvider[]): TranscriptProvider {
  async function discover(workspacePaths: string[]): Promise<DiscoveryResult> {
    const allInputs: DiscoveryInput[] = [];
    const allWatchPaths: string[] = [];
    const allWarnings: string[] = [];

    for (const provider of providers) {
      const result = await provider.discover(workspacePaths);
      for (const input of result.inputs) {
        allInputs.push({
          ...input,
          metadata: { ...input.metadata, providerId: provider.id },
        });
      }
      allWatchPaths.push(...result.watchPaths);
      allWarnings.push(...result.warnings);
    }

    return {
      inputs: allInputs,
      watchPaths: [...new Set(allWatchPaths)],
      warnings: allWarnings.length > 0 ? [...new Set(allWarnings)] : [],
    };
  }

  async function connect(): Promise<void> {
    for (const provider of providers) {
      await provider.connect?.();
    }
  }

  async function disconnect(): Promise<void> {
    let firstError: unknown;
    for (const provider of providers) {
      try {
        await provider.disconnect?.();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) {
      throw toError(firstError);
    }
  }

  async function read(
    inputs: DiscoveryInput[],
    now: number = Date.now(),
  ): Promise<TranscriptReadResult> {
    const inputsByProvider = groupByKey(inputs, (input) => {
      const id = input.metadata?.providerId;
      return typeof id === "string" ? id : "";
    });

    const allRecords: TranscriptReadResult["records"] = [];
    const allWarnings: string[] = [];
    let anyConnected = false;
    const sourceLabels: string[] = [];

    for (const provider of providers) {
      const providerInputs = inputsByProvider.get(provider.id) ?? [];
      if (providerInputs.length === 0) {
        continue;
      }

      const result = await provider.read(providerInputs, now);
      allRecords.push(...result.records);
      allWarnings.push(...result.health.warnings);
      if (result.health.connected) {
        anyConnected = true;
      }
      sourceLabels.push(result.health.sourceLabel);
    }

    return {
      records: allRecords,
      health: {
        connected: anyConnected,
        sourceLabel: sourceLabels.join("+"),
        warnings: allWarnings,
      },
    };
  }

  async function normalize(
    readResult: TranscriptReadResult,
    now: number,
  ): Promise<CanonicalSnapshot> {
    const recordsByProvider = groupByKey(readResult.records, (record) => record.provider);

    const allAgents: CanonicalAgentSnapshot[] = [];
    const allWarnings: string[] = [];
    let anyConnected = false;

    for (const provider of providers) {
      const providerRecords = recordsByProvider.get(provider.id) ?? [];
      if (providerRecords.length === 0) {
        continue;
      }

      const providerReadResult: TranscriptReadResult = {
        records: providerRecords,
        health: readResult.health,
      };

      const normalized = await provider.normalize(providerReadResult, now);
      allAgents.push(...normalized.agents);
      allWarnings.push(...normalized.health.warnings);
      if (normalized.health.connected) {
        anyConnected = true;
      }
    }

    return {
      agents: allAgents,
      health: {
        connected: anyConnected,
        sourceLabel: readResult.health.sourceLabel,
        warnings: allWarnings.length > 0 ? [...new Set(allWarnings)] : [],
      },
    };
  }

  const watchProviders = providers.filter((p) => p.watch);
  const compositeWatch =
    watchProviders.length > 0
      ? {
          debounceMs: Math.min(
            ...watchProviders.map((p) => p.watch?.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS),
          ),
          subscribe(
            watchPath: string,
            onEvent: () => void,
            onError: (error: Error) => void,
          ): { close(): void } {
            const subs = subscribeAll(watchProviders, watchPath, onEvent, onError);
            return {
              close() {
                for (const sub of subs) {
                  try {
                    sub.close();
                  } catch {
                    // best-effort cleanup
                  }
                }
              },
            };
          },
        }
      : undefined;

  return {
    id: providers.map((p) => p.id).join("+"),
    discover,
    connect,
    disconnect,
    read,
    normalize,
    watch: compositeWatch,
  };
}

function subscribeAll(
  watchProviders: TranscriptProvider[],
  watchPath: string,
  onEvent: () => void,
  onError: (error: Error) => void,
): { close(): void }[] {
  return watchProviders.flatMap((provider) => {
    try {
      const sub = provider.watch?.subscribe(watchPath, onEvent, onError);
      return sub ? [sub] : [];
    } catch (error) {
      try {
        onError(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // onError must not break remaining subscriptions
      }
      return [];
    }
  });
}
