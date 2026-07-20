# Changelog

## [0.3.0] - 2026-07-20

### Added

- xAI/Grok SuperGrok usage: shows SuperGrok monthly credits and the weekly usage pool, and detects Grok models correctly

## [0.2.0] - 2026-07-15

### Added

- Read Claude Code credentials from `~/.claude/.credentials.json`, adding auth support on Linux and Windows

## [0.1.0] - 2026-05-20

### Added

- Initial release: simplified fork of [@marckrenn/pi-sub-core](https://github.com/marckrenn/pi-sub-core)
- Fetches Anthropic subscription usage data and renders it in the Pi status bar
- Auto-detects LLM provider from model metadata
- Configurable refresh interval via `PI_USAGE_REFRESH_MINUTES` environment variable
