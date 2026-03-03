import type { LifecycleSnapshot, WatchLifecycleEvent } from "./types";

export function createLifecycleMapper<TAgent, TStatus extends string>(
  snapshot: LifecycleSnapshot<TAgent, TStatus>,
): {
  map(currentAgents: TAgent[], at?: number): WatchLifecycleEvent<TStatus>[];
  reset(): void;
} {
  let previousStatusById = new Map<string, TStatus>();

  function map(currentAgents: TAgent[], at: number = Date.now()): WatchLifecycleEvent<TStatus>[] {
    const events: WatchLifecycleEvent<TStatus>[] = [];
    const nextStatusById = new Map<string, TStatus>();

    for (const agent of currentAgents) {
      const agentId = snapshot.getId(agent);
      const nextStatus = snapshot.getStatus(agent);
      const previousStatus = previousStatusById.get(agentId);

      nextStatusById.set(agentId, nextStatus);

      if (previousStatus === undefined) {
        events.push({
          kind: "joined",
          agentId,
          at,
          fromStatus: null,
          toStatus: nextStatus,
        });
        continue;
      }

      if (previousStatus !== nextStatus) {
        events.push({
          kind: "statusChanged",
          agentId,
          at,
          fromStatus: previousStatus,
          toStatus: nextStatus,
        });
        continue;
      }

      events.push({
        kind: "heartbeat",
        agentId,
        at,
        fromStatus: previousStatus,
        toStatus: nextStatus,
      });
    }

    for (const [agentId, previousStatus] of previousStatusById.entries()) {
      if (!nextStatusById.has(agentId)) {
        events.push({
          kind: "left",
          agentId,
          at,
          fromStatus: previousStatus,
          toStatus: null,
        });
      }
    }

    previousStatusById = nextStatusById;
    return events;
  }

  function reset(): void {
    previousStatusById.clear();
  }

  return {
    map,
    reset,
  };
}
