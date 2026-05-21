# Source-Overall Aggressive Cleanup — First Safe Cleanup Batch Test-Lock Plan

## Batch 1 — Lane 2 probe: `src/tools/state-tools.ts`

### Goal
Classify the fallback/state-contract behavior first, because the PRD explicitly serializes this file-family before any later seam extraction.

### Lock tests before any source change
- `src/team/__tests__/state-paths.test.ts`
- `src/team/__tests__/phase1-foundation.test.ts`
- `src/team/__tests__/api-interop.cwd-resolution.test.ts`
- `src/team/__tests__/bridge-integration.test.ts`
- `src/__tests__/state-root-resolution.test.ts`

### What the lock must prove
- `team_state_root` precedence stays stable.
- Task/mailbox path normalization stays canonical.
- State-root resolution does not regress across config, manifest, env, and cwd-walk paths.
- Bridge / runtime callers continue to resolve team state paths from the same contract.

### First commands
- `npm test -- --run src/team/__tests__/state-paths.test.ts src/team/__tests__/phase1-foundation.test.ts src/team/__tests__/api-interop.cwd-resolution.test.ts src/team/__tests__/bridge-integration.test.ts src/__tests__/state-root-resolution.test.ts`
- `npm run lint`

## Batch 2 — Grounded runtime boundary cleanup: `src/tools/python-repl/*`

### Goal
Keep compatibility narrow while removing any accidental masking behavior.

### Lock tests before any source change
- `src/tools/python-repl/__tests__/python-sandbox.test.ts`
- `src/tools/python-repl/__tests__/tcp-fallback.test.ts`

### What the lock must prove
- Sandbox import/dunder blocking remains enforced.
- Unix socket and TCP fallback behavior stays explicit and observable.
- Path helpers still produce canonical `bridge.port` / socket paths.

## Batch 3 — Config/model cleanup: `src/config/loader.ts`, `src/config/models.ts`

### Goal
Tighten config precedence and provider inference without widening implicit defaults.

### Lock tests before any source change
- `src/config/__tests__/loader.test.ts`
- `src/config/__tests__/models.test.ts`
- `src/__tests__/config-dir.test.ts`
- `src/__tests__/session-start-cache-cleanup.test.ts`
- `src/__tests__/purge-stale-cache.test.ts`

### What the lock must prove
- Env precedence and provider detection remain deliberate.
- Any fallback removal becomes an explicit contract change, not an accidental regression.

## Final verification gate for the first batch
After batch changes land, run:
- `npm test -- --run`
- `npm run build`
- `npm run lint`
- `npm audit --omit=dev`
- `node bridge/cli.cjs --help`

## Stop condition
Do not start lane 3 orchestrator seam extraction until batch 1 has a completed test lock and a written classification note for `src/tools/state-tools.ts`.
