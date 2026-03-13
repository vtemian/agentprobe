# AgentProbe — Project Rules

## Code Style

- No classes for business logic — use factory functions + closures
- No nesting beyond 2 levels inside a function body
- Max function length: 25 lines of logic
- No magic numbers/strings — use named constants
- No `any` types, no type assertions (`as Type`) — use type guards
- No comments explaining *what* — only *why* when non-obvious
- Double quotes, semicolons, trailing commas (enforced by Biome)

## Engineering Principles

- DRY — extract shared patterns, no copy-paste
- YAGNI — no speculative features or unused abstractions
- Fail fast — validate inputs early, return/throw before the happy path
- Dependency injection — pass dependencies in, don't import singletons
- Errors are values — custom error types with context, no bare `catch {}`

## TypeScript-Specific

- Names are contracts — domain-meaningful, no `data`/`result`/`temp`
- Discriminated unions over class hierarchies
- Explicit return types on exported functions
- `readonly` on data structures that shouldn't mutate
- Imports via `@/` path aliases, no `../` relative imports

## Testing

- Test real behavior, not mocked behavior — if a mock is the only thing being verified, the test is wrong
- Mock data, not behavior — inject test data, don't spy on implementation details
- All error paths must have tests
- All public exports must have tests
- Test output must be pristine — capture and validate expected errors

## Tooling

- `npm run check` runs the full quality gate: `biome check . && eslint . && tsc --noEmit && vitest run`
- Pre-commit hook runs Biome format + ESLint on staged files via lint-staged
- CI runs full `npm run check` on every PR
