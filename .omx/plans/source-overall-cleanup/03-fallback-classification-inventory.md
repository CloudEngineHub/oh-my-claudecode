# Source-Overall Aggressive Cleanup — Fallback Classification Inventory

Classification legend:
- **Masking fallback slop** — swallows errors, silently widens behavior, or hides a contract boundary.
- **Grounded compatibility / fail-safe fallback** — narrow runtime boundary fallback with a clear external constraint and test coverage.
- **Ambiguous** — needs lane-level probe before any deletion.

## Grounded compatibility / fail-safe fallback

| Target | Evidence / anchors | Classification |
| --- | --- | --- |
| `src/tools/python-repl/bridge-manager.ts` | `src/tools/python-repl/__tests__/python-sandbox.test.ts`, `src/tools/python-repl/__tests__/tcp-fallback.test.ts` | Unix socket with TCP localhost fallback is an external-platform boundary, not masking slop |
| `src/tools/python-repl/paths.ts` | `src/tools/python-repl/__tests__/tcp-fallback.test.ts` | `bridge.port` path derivation is a platform boundary helper |
| `src/tools/python-repl/socket-client.ts` | `src/tools/python-repl/__tests__/tcp-fallback.test.ts` | TCP prefix fallback is explicit protocol compatibility |
| `src/tools/python-repl/tool.ts` | `src/tools/python-repl/__tests__/python-sandbox.test.ts` | Persistent Python execution boundary with sandbox enforcement |
| `src/features/rate-limit-wait/*` | `src/__tests__/rate-limit-wait/tmux-detector.test.ts`, `src/__tests__/rate-limit-wait/pane-fresh-capture.test.ts`, `src/__tests__/rate-limit-wait/integration.test.ts` | Runtime/tmux compatibility behavior |
| `src/tools/diagnostics/*` | `src/__tests__/ast-tools-path-restriction.test.ts`, `src/__tests__/lsp-servers.test.ts` | Toolchain fallback at a grounded diagnostics boundary |
| `src/tools/lsp/*` | `src/__tests__/lsp-servers-vue-catalog.test.ts`, `src/__tests__/lsp-servers.test.ts` | External LSP integration boundary |
| `src/openclaw/*` | PRD target area; external gateway behavior called out in the test spec as a known grounded domain | Non-blocking gateway compatibility boundary |

## Masking fallback slop

| Target | Evidence / anchors | Why it is suspicious |
| --- | --- | --- |
| `src/features/auto-update.ts` | `src/__tests__/auto-update.test.ts`, `src/__tests__/run-cjs-graceful-fallback.test.ts`, `src/__tests__/session-start-cache-cleanup.test.ts`, `src/__tests__/purge-stale-cache.test.ts` | Stale-root / self-update paths can hide failures if the fallback is too broad |
| `src/config/loader.ts` | `src/config/__tests__/loader.test.ts`, `src/__tests__/config-dir.test.ts` | Implicit defaults and env precedence can become silent masking if overgeneralized |
| `src/config/models.ts` | `src/config/__tests__/models.test.ts` | Provider/model inference is contract-sensitive; accidental fallback broadening must be avoided |
| `src/features/delegation-routing/*` | `src/__tests__/delegation-enforcement-levels.test.ts`, `src/__tests__/delegation-enforcer.test.ts`, `src/__tests__/delegation-enforcer-integration.test.ts` | Routing fallbacks may silently change execution authority |
| `src/features/state-manager/*` | `src/__tests__/shared-state-locking.test.ts`, `src/__tests__/shared-memory.test.ts` | State fallback paths can hide locking or root-resolution regressions |

## Ambiguous / requires Lane 2 probe

| Target | Why it stays ambiguous |
| --- | --- |
| `src/tools/state-tools.ts` | Explicitly assigned to Lane 2 first in the PRD; classification must happen before any seam extraction |
| `src/hooks/bridge.ts` | Some fallback behavior is intentional bridge compatibility, but the orchestrator also contains masking-like branches |
| `src/hooks/persistent-mode/index.ts` | Stop-hook compatibility is important, but some branches may still be removable slop |
| `src/team/runtime-v2.ts` | Convergence / teardown paths mix fail-safe handling with orchestration control flow |
| `src/installer/index.ts` | Installer compatibility rules need lane-level proof before deletion |
| `src/cli/index.ts`, `src/cli/team.ts` | CLI compatibility and public surface constraints require contract-first handling |

## Deletion rule for the cleanup pass
- Delete only when the fallback is classified as masking slop or when a grounded compatibility path has a narrower replacement with explicit regression tests.
- Preserve grounded runtime compatibility shims until the final lane can prove both the primary and fallback behaviors.
