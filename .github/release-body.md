# oh-my-claudecode v5.7.21: Clearer state output and restored team missions

## Release Notes

This release bounds `state_clear` diagnostics, removes invalid agent frontmatter that caused startup warnings, and restores team mission discovery when no session snapshot exists. Thanks to @iyoda for the fixes; #4654 was reported by @conarti and #4657 by @fvegiard.

### Bug Fixes

- **fix(state): limit `state_clear` missing-state path output to the requested session, or cap checked paths with an `and N more` count** (#4654, fixes #4651; reported by @conarti)
- **fix(agents): drop the unrecognized top-level `level` frontmatter key to prevent Claude Code startup warnings** (#4657, fixes #4656; reported by @fvegiard)
- **fix(hud/cli): show team missions when no session mission snapshot exists and expire completed missions in that team-only view** (#4661, #4662; @iyoda)

### Other Changes

- **chore(sync): merge main's v5.7.20 release into dev** (#4658)
- **ci: authorize and refresh generated artifacts for main-to-dev sync PR #4658** (#4659, #4660, #4663)

### Stats

- **8 PRs merged** | **0 new features** | **4 bug fixes** | **0 performance improvements** | **4 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.21
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.20...v5.7.21

## Contributors

Thank you to all contributors who made this release possible!

@iyoda @conarti @fvegiard @Yeachan-Heo
