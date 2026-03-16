# AgentProbe: Project Rules

## Cursor Integration

- Cursor-native rules are defined in `.cursor/rules/*.mdc`
- Keep this file aligned with those rules; `.mdc` files are the authoritative source for scoped guidance

## Writing

- Never use em dashes. Use colons for definitions, commas or parentheses for asides, and restructure sentences that rely on em dashes.

## Code Style

- No classes for business logic. Use factory functions (`createX`) with closed-over state
- No nesting beyond 2 levels inside a function body. Prefer early returns and small helpers
- Max function length: 40 lines (skipBlankLines, skipComments)
- No magic numbers/strings. Use named constants. Place shared tunables in `constants.ts`
- No `any` types, no type assertions (`as Type`). Use Zod schemas or type guards to narrow
- Use `unknown` at system boundaries and normalize with Zod or `toError(...)` before handling
- No comments explaining *what*, only *why* when non-obvious
- Double quotes, semicolons, trailing commas (enforced by Biome)

## Architecture

- Keep `src/core` provider-agnostic; never import from `src/providers` into core modules
- Implement integrations in `src/providers/*` by adapting data into core contracts
- Use named exports only; do not add default exports in `src`
- Re-export public APIs through barrel files (`index.ts`)

## TypeScript

- Names are contracts: domain-meaningful, no `data`/`result`/`temp`
- Prefer single-word names. Drop redundant prefixes (`allWarnings` → `warnings`, `currentFiles` → `files`, `cachedDiscovery` → `discovery`). Context (scope, parameter position, containing object) should carry the qualifier, not the name
- No type names in identifiers (no Hungarian notation): avoid suffixes like `Map`, `Array`, `List`, `String`, `Object`, `Set`, `Dict`, `Number`, `Boolean`, `Fn`, `Func`, `Callback`. Name by what it holds in the domain, not its data structure
- Prefer `interface` for contracts and `type` for unions/aliases
- Discriminated unions over class hierarchies
- Use `as const` constant maps for statuses/events and derive union types from them
- Use `import type` for type-only imports
- Explicit return types on exported functions
- `readonly` on data structures that shouldn't mutate

## Module Structure

- Order files as: imports -> exported types/constants -> internal constants/schemas -> main factory -> private helpers
- Keep comments sparse and only for non-obvious behavior

## Imports and Paths

- Use `@/*` aliases for cross-folder project imports
- Use `./` relative imports within the same folder
- No parent-relative imports (`../`) where `@/*` is appropriate

## Engineering Principles

- DRY: extract shared patterns, no copy-paste
- YAGNI: no speculative features or unused abstractions
- Fail fast: validate inputs early, return/throw before the happy path
- Dependency injection: pass dependencies in, don't import singletons
- Errors are values: custom error types with context, no bare `catch {}`

## Provider Pipeline

- Follow `discover -> read -> normalize` contract shape exactly
- `discover` must return `{ inputs, watchPaths, warnings }`
- `read` must return raw records + health, not canonicalized payloads
- `normalize` must produce canonical `{ agents, health }`
- Treat parse failures as non-fatal: accumulate warnings and continue

## Event and Runtime Safety

- Never let listener exceptions break loops; wrap fan-out callbacks in `try/catch`
- Make cleanup best-effort (`disconnect/close/unsubscribe` should not mask primary failures)
- Keep status names consistent: `running | idle | completed | error`

## Testing

- Test real behavior, not mocked behavior. If a mock is the only thing being verified, the test is wrong
- Mock data, not behavior. Inject test data, don't spy on implementation details
- All error paths must have tests
- All public exports must have tests
- Test output must be pristine. Capture and validate expected errors
- Place tests in `tests/*.test.ts` with behavior-focused `it(...)` names
- Use `/tmp` unique paths for filesystem tests and always cleanup in `afterEach`
- Prefer condition polling helpers (`waitUntil` style) over fixed sleeps

## Tooling

- `npm run check` runs the full quality gate: `biome check . && eslint . && tsc --noEmit && vitest run`
- Pre-commit hook runs Biome format + ESLint on staged files via lint-staged
- CI runs full `npm run check` on every PR
- Run `npm run check` after substantive changes. If build/runtime-sensitive code changed, also run `npm run build`
