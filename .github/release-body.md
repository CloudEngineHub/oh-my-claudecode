# oh-my-claudecode v5.3.0: Remote Approvals, Shipyard Navigation, and Windows Reliability

## Release Notes

Release with **5 new features**, **3 bug fixes** across **8 merged PRs**.

### Highlights

- **perf: batch Windows cache occupancy identity checks** (#3973)
- **feat(skills): add loft — shipyard shape-before-steel discipline (opt-in, model-invoked)** (#3970)
- **feat(skills): add ask-navigator — shipyard navigator for foggy efforts (opt-in)** (#3969)
- **perf(hud): scope git path memoization per render** (#3961)
- **feat(graph): remote approval gates + workspace checkpoints/rollback** (#3960)

### New Features

- **perf: batch Windows cache occupancy identity checks** (#3973)
- **feat(skills): add loft — shipyard shape-before-steel discipline (opt-in, model-invoked)** (#3970)
- **feat(skills): add ask-navigator — shipyard navigator for foggy efforts (opt-in)** (#3969)
- **perf(hud): scope git path memoization per render** (#3961)
- **feat(graph): remote approval gates + workspace checkpoints/rollback** (#3960)

### Bug Fixes

- **fix: preserve Windows occupancy tick precision** (#3974)
- **fix(hooks): preserve stderr after early protocol stdout close** (#3964)
- **fix(hooks): omit unsupported PostToolUse suppressOutput** (#3958)

### Stats

- **8 PRs merged** | **5 new features** | **3 bug fixes** | **0 security/hardening improvements** | **0 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.3.0
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.2.0...v5.3.0

**Release tracking and owner authorization:** #3975

## Contributors

Thank you to all contributors who made this release possible!

@cuijieshan3-collab @pangpang778 @Yeachan-Heo
