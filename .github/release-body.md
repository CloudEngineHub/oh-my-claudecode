# oh-my-claudecode v4.14.1: goal workflow polish, launch reliability, diagnostics hardening

## Release Notes

Patch release with **19 user-facing fixes / hardening changes** across goal workflows, team launch, diagnostics, HUD, MCP/profile handling, and Claude Code v2.1.x compatibility.

### Highlights

- **Goal workflow polish** (#3004, #3005, #3006) — document the Claude `/goal` adapter boundary, clarify workflow UX expectations, and map goal artifacts to OMC storage roots so durable goal state is easier to reason about across sessions.
- **Team launch reliability** — keep Claude prompt delivery working from TUI idle state, handle Claude Code v2.1.x banner / Enter-swallow stalls, and preserve OSC 52 clipboard behavior in OMC tmux sessions.
- **Tooling and integration hardening** — preserve MCP registry headers and launch-profile MCP availability, keep upgrade CI deterministic before publish, and surface LSP install hints from aggregated diagnostics.

### Bug Fixes & Hardening

- Map goal artifacts to OMC storage roots (#3006).
- Clarify goal workflow UX boundaries (#3005).
- Document Claude `/goal` adapter boundary (#3004).
- Preserve MCP registry headers (#3054).
- Fix gyoshu bridge exec sandbox.
- Preserve AskUserQuestion mobile reply round-trip.
- Fix AskUserQuestion verbosity override.
- Surface LSP install hints from `runLspAggregatedDiagnostics` (#3040, #3049).
- Enable Vue LSP catalog discovery (#3035).
- Clear local worktree state on cancel fallback (#3033).
- Show Claude model metadata in OMC HUD (#3022).
- Guard deep-interview plugin invocation (#3031).
- Expose deep-interview threshold source before scoring (#3029).
- Guard plugin manifest hook autoloading.
- Deliver Claude prompts from TUI idle state.
- Handle Claude Code v2.1.x banner and Enter-swallow stalls.
- Keep OSC 52 clipboard working in OMC tmux sessions.
- Preserve MCP availability in OMC launch profiles.
- Keep upgrade CI deterministic before npm publish.

### Stats

- **19 post-4.14.0 changes** | **patch release** | **goal, team, diagnostics, HUD, and integration hardening**

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.14.1
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.14.0...v4.14.1

## Contributors

Thank you to all contributors who made this release possible!

@Yeachan-Heo @Taeknology @snowlaxc
