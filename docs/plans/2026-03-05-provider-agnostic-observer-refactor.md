# Provider-Agnostic Observer Refactor Plan

## Goal

Refactor `@agent-io/observer` so consumers depend on a provider-agnostic core API, while provider-specific transcript discovery/parsing/normalization are isolated under `providers/*`.

## Outcomes

- `core` contains only generic contracts, runtime orchestration, lifecycle diffing, and canonical models.
- `providers/cursor` owns all Cursor filesystem and transcript assumptions.
- Root API keeps backward compatibility during migration.
- Future providers (`claude-code`, `codex`, `opencode`) can be added without changing core semantics.

## Principles

- No provider-specific paths, schemas, or heuristics in core.
- Minimize API breakage; provide compatibility wrappers and deprecation windows.
- Use small, reviewable phases with strict parity tests for Cursor behavior.

## Current State Summary

- Generic runtime exists (`runtime`, `lifecycle`) but provider assumptions are mixed in top-level modules.
- `createAgentSubscription` currently wires Cursor defaults directly.
- Core entrypoint still had structural coupling to non-core files before this refactor sequence.

## Phase Plan

### Phase 1 - Core contracts and type split (no behavior changes)

- [x] Add canonical model contracts under `src/core/model.ts`
- [x] Add provider contracts under `src/core/providers.ts`
- [x] Split generic runtime types into `src/core/types.ts`
- [x] Keep compatibility by re-exporting core runtime types from `src/types.ts`
- [x] Update `src/core/index.ts` to export local core modules
- [x] Add tests validating new core contract exports
- [ ] Document core contract usage in README (follow-up in Phase 3)

**Verification**
- [x] New contract test fails before implementation (RED)
- [x] New contract test passes after implementation (GREEN)
- [ ] Full parity verification against baseline behavior

### Phase 2 - Extract Cursor provider internals

- [x] Move `src/agents.ts` logic to `src/providers/cursor/subscription.ts`
- [x] Move `src/discovery.ts` to `src/providers/cursor/discovery.ts`
- [x] Move `src/transcripts.ts` to `src/providers/cursor/transcripts.ts`
- [ ] Move provider-specific constants/domain to `src/providers/cursor/*`
- [x] Keep compatibility re-exports from previous paths
- [x] Add parity tests for `createAgentSubscription`

**Verification**
- [ ] Cursor output parity for snapshot/update/error/state events
- [ ] `npm run check`
- [ ] `npm run build`

### Phase 3 - Introduce provider-agnostic core observer API

- [ ] Add `src/core/observer.ts` with provider-injected runtime composition
- [ ] Expose new API in root exports
- [ ] Keep Cursor default wrapper for legacy consumers
- [ ] Add examples for provider-agnostic usage
- [ ] Update README to lead with provider-agnostic API

**Verification**
- [ ] New API tests pass with injected Cursor provider
- [ ] Legacy API tests still pass
- [ ] `npm run check`
- [ ] `npm run build`

### Phase 4 - Deprecation and migration docs

- [ ] Mark Cursor-coupled root exports as deprecated via JSDoc
- [ ] Add `MIGRATION.md` with before/after usage
- [ ] Add timeline for removal in next major release

**Verification**
- [ ] Generated declaration files include deprecations
- [ ] `npm run check`
- [ ] `npm run build`

### Phase 5 - Provider scaffolds for Claude/Codex/OpenCode

- [ ] Add provider folders and contract-compliant stubs
- [ ] Add fixture-driven normalization tests per provider
- [ ] Define metadata passthrough strategy and limits

**Verification**
- [ ] All provider stubs compile and tests pass
- [ ] `npm run check`
- [ ] `npm run build`

### Phase 6 - Major release cleanup

- [ ] Remove deprecated root Cursor-coupled APIs
- [ ] Finalize root exports around core-first API
- [ ] Publish semver-major with migration notes

## Test Strategy

- Core tests:
  - runtime state transitions and refresh semantics
  - lifecycle mapping correctness
  - provider contract surface regression checks
- Cursor tests:
  - transcript discovery path resolution and dedupe
  - parser behavior for flat and conversation-only transcripts
  - status heuristic edge cases
- Compatibility tests:
  - old and new APIs produce equivalent event streams

## Risks and Mitigations

- **Risk:** behavior drift during file moves
  - **Mitigation:** parity tests before and after each move
- **Risk:** over-abstraction too early
  - **Mitigation:** keep minimal canonical model and provider metadata passthrough
- **Risk:** migration confusion
  - **Mitigation:** root docs and explicit deprecation timeline

## Definition of Done

- Core is provider-agnostic by code and by public API.
- Cursor is implemented as a provider module, not an implicit core dependency.
- Existing consumers have a documented, non-breaking migration path.
- CI/check/build remain green across all phases.
