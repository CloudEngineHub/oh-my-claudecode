# oh-my-claudecode v5.7.19: Faster reconciliation and safer reinstalls

## Release Notes

This release makes interactive updates more reliable on slow-I/O hosts, repairs reinstalls when a hook library is a dangling symlink, and reduces unnecessary work during successful update reconciliation. Thanks to @kaneyxx for #4629 and the #4630 report, and to @iyoda for #4631.

### Bug Fixes

- **fix(update): wait up to 600 seconds for interactive update reconciliation while keeping silent auto-updates bounded to 60 seconds, and name the recovery command on timeout** (#4629, fixes #4628; @kaneyxx)
- **fix(installer): replace dangling `hooks/lib/stdin.mjs` symlinks before copying so reinstalls recover hook imports** (#4631, @iyoda)

### Performance Improvements

- **perf(update): sync the plugin payload once per target during reconciliation, cutting measured reconcile time by about 67%** (#4634, fixes #4630; reported by @kaneyxx)

### Other Changes

- **ci: authorize generated files for sync PR #4632 during the superseded v5.7.18 sync attempt** (#4633)
- **chore(sync): merge main's v5.7.18 release into dev** (#4635)
- **ci: authorize generated artifacts for sync PR #4635** (#4636)

### Stats

- **6 PRs merged** | **0 new features** | **2 bug fixes** | **1 performance improvement** | **0 security/hardening improvements** | **3 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.19
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.18...v5.7.19

## Contributors

Thank you to all contributors who made this release possible!

@kaneyxx @iyoda @Yeachan-Heo
