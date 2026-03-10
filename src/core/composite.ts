import type {
  CanonicalSnapshot,
  DiscoveryInput,
  DiscoveryResult,
  TranscriptProvider,
  TranscriptReadResult,
} from "./providers";
import type { CanonicalAgentSnapshot } from "./model";

export function createCompositeProvider(providers: TranscriptProvider[]): TranscriptProvider {
  async function discover(workspacePaths: string[]): Promise<DiscoveryResult> {
    const allInputs: DiscoveryInput[] = [];
    const allWatchPaths: string[] = [];
    const allWarnings: string[] = [];

    for (const provider of providers) {
      const result = await provider.discover(workspacePaths);
      // Tag each input with its provider ID for routing during read
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
    for (const provider of providers) {
      await provider.disconnect?.();
    }
  }

  async function read(
    inputs: DiscoveryInput[],
    now: number = Date.now(),
  ): Promise<TranscriptReadResult> {
    // Group inputs by provider ID
    const inputsByProvider = new Map<string, DiscoveryInput[]>();
    for (const input of inputs) {
      const providerId = (input.metadata?.providerId as string) ?? "";
      const group = inputsByProvider.get(providerId) ?? [];
      group.push(input);
      inputsByProvider.set(providerId, group);
    }

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
    // Group records by provider
    const recordsByProvider = new Map<string, TranscriptReadResult["records"]>();
    for (const record of readResult.records) {
      const group = recordsByProvider.get(record.provider) ?? [];
      group.push(record);
      recordsByProvider.set(record.provider, group);
    }

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

  // Build composite watch from all providers that have watch
  const watchProviders = providers.filter((p) => p.watch);
  const compositeWatch =
    watchProviders.length > 0
      ? {
          debounceMs: Math.min(...watchProviders.map((p) => p.watch?.debounceMs ?? 150)),
          subscribe(
            watchPath: string,
            onEvent: () => void,
            onError: (error: Error) => void,
          ): { close(): void } {
            // Subscribe to the first provider whose watch can handle this path
            // All providers get the same watch paths, so delegate to each
            const subs: { close(): void }[] = [];
            for (const provider of watchProviders) {
              try {
                const sub = provider.watch?.subscribe(watchPath, onEvent, onError);
                if (sub) {
                  subs.push(sub);
                }
              } catch {
                // Provider might not handle this path
              }
            }
            return {
              close() {
                for (const sub of subs) {
                  sub.close();
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
