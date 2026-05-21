# Source-Overall Aggressive Cleanup — Generated Artifact Policy

## Decision
Commit regenerated tracked build outputs when source changes affect them:
- `dist/`
- `bridge/*.cjs`
- `bridge/team.js`
- `bridge/mcp-server.cjs`
- `bridge/runtime-cli.cjs`
- any other build output that is already part of the tracked release surface

Do **not** commit transient runtime state, caches, or `.omc/` session artifacts.

## Why this policy
- The PRD explicitly requires final artifact policy to be decided before implementation.
- The test spec already treats build artifacts as part of final verification, including `bridge/*.cjs`, `bridge/team.js`, composed docs/shared outputs, runtime CLI, team server, and MCP bridge outputs.
- Several regression tests read the baked bridge artifacts directly, so the cleanup PR must prove the generated outputs stay in sync with source.

## Verification sequence to apply after edits
1. `npm test -- --run`
2. `npm run build`
3. `npm run lint`
4. `npm audit --omit=dev`
5. Artifact smoke:
   - `node bridge/cli.cjs --help`
   - `node bridge/cli.cjs --version`
   - `test -f bridge/cli.cjs && test -f bridge/runtime-cli.cjs && test -f bridge/team.js && test -f bridge/mcp-server.cjs`

## Static/security gate decision
Use `npm audit --omit=dev` as the non-mutating security gate after the final build/test/lint pass.

## Release-risk note
If any cleanup intentionally changes public CLI/API/hook/MCP/state-file behavior, pair the build artifact sync with contract-test updates and release/migration notes.
