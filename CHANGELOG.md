# oh-my-claudecode v4.14.3: hook/update hotfixes

## Release Notes

Hotfix release with **5 merged fixes** since v4.14.2.

### Highlights

- Restores native Windows SessionEnd hook launch behavior (#3115)
- Keeps hook shutdown paths portable and quiet across shell/Windows paths (#3110)
- Fixes update-check cache path consistency under the Claude config directory (#3112)

### Bug Fixes

- **Fix Windows SessionEnd hook command portability** (#3115)
- **Fix update-check cache path consistency** (#3112)
- **Fix native Claude Code version detection on Windows** (#3111)
- **Fix hook shutdown and shell portability regressions** (#3110)
- **Add HUD update notification visibility toggle** (#3113)

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.14.3
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.14.2...v4.14.3

## Contributors

Thank you to all contributors who made this release possible!

@Yeachan-Heo
