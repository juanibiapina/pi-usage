# pi-usage

Pi extension that fetches subscription usage for all supported providers (Anthropic, Copilot, Gemini, Antigravity, Codex, Kiro, z.ai, xAI/Grok).

Simplified fork of the excellent [@marckrenn/pi-sub-core](https://github.com/marckrenn/pi-sub). Keeps all providers, applies two bug fixes, drops features we don't need.

## Bug fixes

### Bedrock false positive detection

pi-sub-core's `detectProviderFromModel` falls back to matching model tokens (e.g. `"claude"`) when provider tokens don't match. This causes AWS Bedrock models (which run Claude but are billed separately) to be misidentified as Anthropic subscription usage. pi-usage only falls back to model tokens when no explicit provider is set.

### Aggressive refresh causing 429 flicker

pi-sub-core uses `force: true` on `turn_end` and `tool_result`, bypassing the cache TTL and hammering the usage APIs. Under load (multiple pi instances), this triggers 429s that cause the usage display to flicker. pi-usage always respects the cache TTL. See [marckrenn/pi-sub#58](https://github.com/marckrenn/pi-sub/issues/58).

## Simplifications vs pi-sub-core

- No status page fetching
- No settings UI or settings persistence
- No tool registration
- No `update-all` event (only `update-current`)
- No provider cycle command
- Self-contained types — no dependency on `@marckrenn/pi-sub-shared`

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `usage-core:ready` | `{ state: UsageCoreState }` | Emitted once on session start |
| `usage-core:update-current` | `{ state: UsageCoreState }` | Emitted on usage changes |

`UsageCoreState` has an optional `provider` name and optional `usage` snapshot with rate windows. When `provider` is undefined, no known subscription provider was detected for the current model.

## Install

```
pi install npm:@juanibiapina/pi-usage
```
