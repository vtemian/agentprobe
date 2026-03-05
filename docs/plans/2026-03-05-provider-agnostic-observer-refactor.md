# Provider-Agnostic Observer Refactor Plan

## Goal

Refactor `@agent-io/core` so consumers depend on a provider-agnostic core API, while provider-specific transcript discovery/parsing/normalization are isolated under `providers/*`.

## Outcomes

- `core` contains only generic contracts, runtime orchestration, lifecycle diffing, and canonical models.
- `providers/cursor` owns all Cursor filesystem and transcript assumptions.
- Root API exposes only the current development shape (no legacy compatibility requirements).
- Future providers (`claude-code`, `codex`, `opencode`) can be added without changing core semantics.

## Principles

- No provider-specific paths, schemas, or heuristics in core.
- Prioritize clean architecture over compatibility wrappers while project is pre-release.
- Use small, reviewable phases with strict parity tests for Cursor behavior.

## Current State Summary

- Generic runtime exists (`runtime`, `lifecycle`) but provider assumptions are mixed in top-level modules.
- The preferred public API is `createObserver` with injected providers.
- Core entrypoint still had structural coupling to non-core files before this refactor sequence.

## Phase Plan

### Phase 1 - Core contracts and type split (no behavior changes)

- [x] Add canonical model contracts under `src/core/model.ts`
- [x] Add provider contracts under `src/core/providers.ts`
- [x] Split generic runtime types into `src/core/types.ts`
- [x] Keep temporary bridge by re-exporting core runtime types from `src/types.ts`
- [x] Update `src/core/index.ts` to export local core modules
- [x] Add tests validating new core contract exports
- [x] Document core contract usage in README (follow-up in Phase 3)

**Verification**
- [x] New contract test fails before implementation (RED)
- [x] New contract test passes after implementation (GREEN)
- [ ] Full parity verification against baseline behavior

### Phase 2 - Extract Cursor provider internals

- [x] Move `src/agents.ts` logic to `src/providers/cursor/subscription.ts`
- [x] Move `src/discovery.ts` to `src/providers/cursor/discovery.ts`
- [x] Move `src/transcripts.ts` to `src/providers/cursor/transcripts.ts`
- [x] Move provider-specific constants/domain to `src/providers/cursor/*`
- [x] Validate root-vs-provider parity for exported Cursor APIs
- [x] Add parity tests for Cursor provider behavior

**Verification**
- [ ] Cursor output parity for snapshot/update/error/state events
- [x] `npm run check`
- [x] `npm run build`

### Phase 3 - Introduce provider-agnostic core observer API

- [x] Add `src/core/observer.ts` with provider-injected runtime composition
- [x] Expose new API in root exports
- [x] Add examples for provider-agnostic usage
- [x] Update README to lead with provider-agnostic API

**Verification**
- [x] New API tests pass with injected Cursor provider
- [x] `npm run check`
- [x] `npm run build`

### Phase 4 - Provider scaffolds for Claude/Codex/OpenCode

- [ ] Add provider folders and contract-compliant stubs
- [ ] Add fixture-driven normalization tests per provider
- [ ] Define metadata passthrough strategy and limits

**Verification**
- [ ] All provider stubs compile and tests pass
- [ ] `npm run check`
- [ ] `npm run build`

## Test Strategy

- Core tests:
  - runtime state transitions and refresh semantics
  - lifecycle mapping correctness
  - provider contract surface regression checks
- Cursor tests:
  - transcript discovery path resolution and dedupe
  - parser behavior for flat and conversation-only transcripts
  - status heuristic edge cases
- Cursor provider parity tests:
  - provider-injected observer yields stable Cursor event streams

## Risks and Mitigations

- **Risk:** behavior drift during file moves
  - **Mitigation:** parity tests before and after each move
- **Risk:** over-abstraction too early
  - **Mitigation:** keep minimal canonical model and provider metadata passthrough
- **Risk:** premature API churn
  - **Mitigation:** keep docs current and avoid adding deprecated surfaces before first stable release

## Definition of Done

- Core is provider-agnostic by code and by public API.
- Cursor is implemented as a provider module, not an implicit core dependency.
- CI/check/build remain green across all phases.
