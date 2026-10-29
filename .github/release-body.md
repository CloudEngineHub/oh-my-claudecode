# oh-my-claudecode v5.7.20: Mission board sessions and reliable run closeouts

## Release Notes

This release makes persisted missions visible in the mission board, improves run-ledger start and resumed-run closeout tracking, and clarifies Windows release-boundary and state-migration failures. Thanks to @Jack11111eee for #4649 (first contribution), @LukeTheoJohnson for #4645 and #4646, @iyoda for #4641 and #4647, and @Yeachan-Heo for #4642 and #4650.

### New Features

- **feat(hud/cli): show persisted missions across the newest sessions by default and add `-s/--session` for an explicit session** (#4649, fixes #4648; @Jack11111eee, first contribution)

### Bug Fixes

- **fix(runs-ledger): record start edges for session-scoped runs and report unattended runs ended without a notepad closeout** (#4646; @LukeTheoJohnson)
- **fix(runs-ledger): bound a resumed run's closeout by its latest unmatched start edge, so a pre-resume notepad write no longer counts** (#4650; @Yeachan-Heo)
- **fix(release): run release-boundary checks when invoked through a Windows path** (#4645; @LukeTheoJohnson)
- **fix(state): report the specific Git metadata refusal before a generic failed-probe refusal in `state_migrate_non_git`** (#4642; @Yeachan-Heo)

### Other Changes

- **test(team): make the activation-gate and critic-verdict tests independent of the host environment** (#4641; @iyoda)
- **test(npm-package): allow the clean-tarball install test up to 120 seconds** (#4647; @iyoda)
- **chore(sync): merge main's v5.7.19 release into dev** (#4639)
- **ci: authorize generated artifacts for main-to-dev sync PR #4639** (#4640)

### Stats

- **9 PRs merged** | **1 new feature** | **4 bug fixes** | **0 security/hardening improvements** | **4 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.20
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.19...v5.7.20

## Contributors

Thank you to all contributors who made this release possible!

@Jack11111eee @LukeTheoJohnson @iyoda @Yeachan-Heo
