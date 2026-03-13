# Code Quality Gate: Design Document

## Goal

Establish an automated code quality pipeline that enforces architectural rules through deterministic tooling and CI, inspired by the approach used in our Python projects: natural language rules -> parallel audit -> parallel fix -> linter config -> enforcement.

## Rule Set

Three categories of rules, codifying existing conventions and adding stricter constraints.

### Code Style

- No classes for business logic (factory functions + closures only)
- No nesting beyond 2 levels inside a function body
- Max function length: 25 lines of logic
- No magic numbers/strings — named constants only
- No `any` types, no type assertions (`as Type`) — use type guards
- No comments explaining *what* — only *why* when non-obvious
- Double quotes, semicolons, trailing commas (already enforced by Biome)

### Engineering Principles

- DRY — extract shared patterns, no copy-paste
- YAGNI — no speculative features or unused abstractions
- Fail fast — validate inputs early, return/throw before the happy path
- Dependency injection — pass dependencies in, don't import singletons
- Errors are values — custom error types with context, no bare `catch {}`

### TypeScript-Specific

- Names are contracts — domain-meaningful, no `data`/`result`/`temp`
- Discriminated unions over class hierarchies
- Explicit return types on exported functions
- `readonly` on data structures that shouldn't mutate
- Imports via `@/` path aliases, no `../` relative imports (already in Biome)

### Rules That Can't Be Automated

These stay as CLAUDE.md rules enforced by AI assistants and code review:

- "No classes for business logic" — architectural judgment
- "Names are contracts" — semantic, no linter can judge naming quality
- "DRY" — duplicate detection has high false-positive rates
- "Mock data not behavior" — test design, needs human judgment

## Tooling Stack

Two layers, mirroring the Python project's ruff + wemake approach.

### Layer 1: Biome (fast, covers ~80%)

Already in place. Changes:
- Enable import organization (currently disabled)
- Add `noParameterAssign` rule
- Tighten any rules currently missing

### Layer 2: ESLint (stricter, catches what Biome can't)

New addition. Key plugins:

| Plugin | Rules |
|--------|-------|
| `@typescript-eslint` | `no-magic-numbers`, `explicit-function-return-type`, `no-unused-vars` (stricter), `naming-convention` |
| `eslint-plugin-sonarjs` | `cognitive-complexity` (threshold: 10), `no-duplicate-string`, `no-identical-functions` |
| `eslint-plugin-unicorn` | `no-nested-ternary`, `prefer-early-return` |

**Overlap strategy:** Biome handles formatting + fast lint. ESLint only runs rules Biome can't cover. Overlapping rules disabled in ESLint to avoid conflicts and keep runs fast.

### Rule-to-Tool Mapping

| Rule | Tool | Config |
|------|------|--------|
| Type annotations | `tsc --noEmit` (strict: true) | Already configured |
| Max complexity | `eslint-plugin-sonarjs` | `cognitive-complexity: 10` |
| No nesting | `eslint-plugin-sonarjs` | `cognitive-complexity` + `@typescript-eslint/max-depth` |
| Unused code | Biome `noUnusedVariables` | Already configured |
| No magic numbers | `@typescript-eslint/no-magic-numbers` | New |
| Fail fast (no bare catch) | Biome `noEmptyCatch` + `@typescript-eslint` | Tighten existing |
| Import order | Biome organizeImports | Enable (currently disabled) |
| Explicit return types | `@typescript-eslint/explicit-function-return-type` | Exported functions only |

## Enforcement

| Layer | When | What |
|-------|------|------|
| `npm run check` | Manual | `biome check . && eslint . && tsc --noEmit && vitest run` |
| Pre-commit (lint-staged) | On `git commit` | Biome format + ESLint on staged files only |
| GitHub Actions | On PR | Full `npm run check` |

Stack: `husky` for git hooks, `lint-staged` for scoping pre-commit to changed files.

## Audit Results

Full codebase audit run on 2026-03-13 against the rule set above.

### Summary

| Category | High | Medium | Low | Total |
|----------|------|--------|-----|-------|
| Complexity & nesting | 4 | 4 | 3 | 11 |
| Naming & types | 0 | 4 | 3 | 7 |
| DRY & architecture | 0 | 4 | 4 | 8 |
| Test quality | 3 | 10 | 2 | 15 |
| **Total** | **7** | **22** | **12** | **41** |

### High Severity Violations

**Complexity & Nesting (4):**

1. `src/providers/cursor/transcripts.ts` — `readSnapshot` (lines 125-238): 113 lines, 4+ nesting levels, multiple responsibilities intertwined
2. `src/providers/cursor/transcripts.ts` — `deriveConversationStatus` (lines 486-529): 5 nesting levels, collapsible conditionals
3. `src/core/runtime/index.ts` — `createWatchRuntime` (lines 30-383): 353-line function with multiple state machines in one closure
4. `src/core/observer.ts` — `createObserver` (lines 43-163): 120 lines, 4+ nesting levels in subscription handler

**Test Quality (3):**

1. `tests/runtime-subscriptions.test.ts` — multiple tests only verify mock/spy behavior, not real subscription logic
2. `tests/runtime-event-bus.test.ts` — all tests verify mocked handler calls, not actual event bus implementation
3. `tests/runtime-shared.test.ts` — tests verify spy behavior on mocked objects, not actual utility functions

### Hot Files (priority order)

1. `src/providers/cursor/transcripts.ts` — complexity, nesting, magic numbers
2. `src/core/runtime/index.ts` — 353-line function, duplicated error-handling patterns
3. `src/core/observer.ts` — nesting, duplicated emit pattern
4. `tests/runtime-subscriptions.test.ts` — tests mock behavior
5. `tests/runtime-event-bus.test.ts` — tests mock behavior
6. `tests/runtime-shared.test.ts` — tests mock behavior

### Medium Severity Highlights

- Duplicated `emit()` patterns across `observer.ts` and `runtime/index.ts`
- Triplicated `isStarted()` guard + try-catch pattern in `runtime/index.ts` event handlers
- Vague parameter names (`a`, `b`, `i`) in `provider.ts:arraysEqual`
- Magic numbers in transcripts (`.slice(0, 6)`) and tests (timestamps, delays)
- Bare catch blocks without rationale in `discovery.ts` and `subscriptions.ts`
- Missing error path tests for `createObserver`, `CursorTranscriptProvider.normalize`, and transcript reading
- Untested public function: `createLifecycleMapper.reset()`
- Untested public constant: `WATCH_RUNTIME_STATES`

## Execution Phases

### Phase 1 — Define rules in project CLAUDE.md

Write the rule set above into a project-level `CLAUDE.md`. This becomes the source of truth for AI assistants and code review.

### Phase 2 — Fix violations file-by-file

Parallel fixes per file, no cross-file changes in the first wave:
- Break up oversized functions (`readSnapshot`, `createWatchRuntime`, `createObserver`)
- Flatten nested conditionals (`deriveConversationStatus`)
- Extract magic numbers to named constants
- Rename vague parameters
- Add rationale to bare catch blocks
- Cross-file changes sequentially after: extract shared `emit()` pattern, consolidate `isStarted()` guards

### Phase 3 — Refactor tests

Rewrite 3 test files that test mock behavior:
- `runtime-subscriptions.test.ts` — test real subscription behavior
- `runtime-event-bus.test.ts` — test real event dispatch
- `runtime-shared.test.ts` — test real utility functions

Add missing coverage:
- Error paths for `createObserver`, `normalize`, transcript reading
- `createLifecycleMapper.reset()`
- `WATCH_RUNTIME_STATES` constant

### Phase 4 — Configure linters

1. Tighten Biome config (enable import organization, add rules)
2. Add ESLint with `@typescript-eslint`, `sonarjs`, `unicorn` plugins
3. Configure only rules Biome can't cover
4. Run against cleaned codebase to establish green baseline
5. Update `npm run check` to include ESLint

### Phase 5 — Add enforcement hooks

1. Install `husky` + `lint-staged`
2. Configure pre-commit hook (Biome format + ESLint on staged files)
3. Add GitHub Actions workflow for PR checks
4. Verify end-to-end: commit triggers hook, PR triggers CI
