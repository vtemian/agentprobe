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

function tagInputsWithProvider(
  inputs: readonly DiscoveryInput[],
  providerId: string,
): DiscoveryInput[] {
  return inputs.map((input) => ({
    ...input,
    metadata: { ...input.metadata, providerId },
  }));
}

async function discoverAll(
  providers: TranscriptProvider[],
  workspacePaths: string[],
): Promise<DiscoveryResult> {
  const inputs: DiscoveryInput[] = [];
  const watchPaths: string[] = [];
  const warnings: string[] = [];

  for (const provider of providers) {
    try {
      const result = await provider.discover(workspacePaths);
      inputs.push(...tagInputsWithProvider(result.inputs, provider.id));
      watchPaths.push(...result.watchPaths);
      warnings.push(...result.warnings);
    } catch (error) {
      warnings.push(`[${provider.id}] ${toError(error).message}`);
    }
  }

  return {
    inputs: inputs,
    watchPaths: [...new Set(watchPaths)],
    warnings: warnings.length > 0 ? [...new Set(warnings)] : [],
  };
}

async function connectAll(providers: TranscriptProvider[]): Promise<void> {
  for (const provider of providers) {
    try {
      await provider.connect?.();
    } catch {
      // best-effort: continue connecting remaining providers
    }
  }
}

async function disconnectAll(providers: TranscriptProvider[]): Promise<void> {
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

function extractProviderInputs(inputs: DiscoveryInput[]): Map<string, DiscoveryInput[]> {
  return groupByKey(inputs, (input) => {
    const id = input.metadata?.providerId;
    return typeof id === "string" ? id : "";
  });
}

async function readAll(
  providers: TranscriptProvider[],
  inputs: DiscoveryInput[],
  now: number = Date.now(),
): Promise<TranscriptReadResult> {
  const inputsByProvider = extractProviderInputs(inputs);
  const records: TranscriptReadResult["records"] = [];
  const warnings: string[] = [];
  let anyConnected = false;
  const labels: string[] = [];

  for (const provider of providers) {
    const providerInputs = inputsByProvider.get(provider.id) ?? [];
    if (providerInputs.length === 0) {
      continue;
    }
    const partial = await readFromProvider(provider, providerInputs, now);
    records.push(...partial.records);
    warnings.push(...partial.warnings);
    anyConnected = anyConnected || partial.connected;
    if (partial.sourceLabel) {
      labels.push(partial.sourceLabel);
    }
  }

  return {
    records: records,
    health: {
      connected: anyConnected,
      sourceLabel: labels.join("+"),
      warnings: warnings,
    },
  };
}

interface ProviderReadPartial {
  records: TranscriptReadResult["records"];
  warnings: string[];
  connected: boolean;
  sourceLabel: string;
}

async function readFromProvider(
  provider: TranscriptProvider,
  inputs: DiscoveryInput[],
  now: number,
): Promise<ProviderReadPartial> {
  try {
    const result = await provider.read(inputs, now);
    return {
      records: result.records,
      warnings: result.health.warnings,
      connected: result.health.connected,
      sourceLabel: result.health.sourceLabel,
    };
  } catch (error) {
    return {
      records: [],
      warnings: [`[${provider.id}] ${toError(error).message}`],
      connected: false,
      sourceLabel: "",
    };
  }
}

async function normalizeAll(
  providers: TranscriptProvider[],
  readResult: TranscriptReadResult,
  now: number,
): Promise<CanonicalSnapshot> {
  const recordsByProvider = groupByKey(readResult.records, (record) => record.provider);

  const agents: CanonicalAgentSnapshot[] = [];
  const warnings: string[] = [];
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
    agents.push(...normalized.agents);
    warnings.push(...normalized.health.warnings);
    anyConnected = anyConnected || normalized.health.connected;
  }

  return {
    agents: agents,
    health: {
      connected: anyConnected,
      sourceLabel: readResult.health.sourceLabel,
      warnings: warnings.length > 0 ? [...new Set(warnings)] : [],
    },
  };
}

function buildCompositeWatch(watchProviders: TranscriptProvider[]): TranscriptProvider["watch"] {
  if (watchProviders.length === 0) {
    return undefined;
  }

  return {
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
  };
}

export function createCompositeProvider(providers: TranscriptProvider[]): TranscriptProvider {
  const watchProviders = providers.filter((p) => p.watch);

  return {
    id: providers.map((p) => p.id).join("+"),
    discover: (workspacePaths) => discoverAll(providers, workspacePaths),
    connect: () => connectAll(providers),
    disconnect: () => disconnectAll(providers),
    read: (inputs, now) => readAll(providers, inputs, now),
    normalize: (readResult, now) => normalizeAll(providers, readResult, now),
    watch: buildCompositeWatch(watchProviders),
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
