# pi-usage

Pi extension that fetches subscription usage for Anthropic, Copilot, Gemini, Antigravity, Codex, Kiro, z.ai, and xAI/Grok.

## Behavior

Usage resolves when Pi starts a session, selects a model, or completes a turn. The extension has no recurring refresh timer.

All Pi processes owned by the same OS account on one machine share provider state, regardless of project or `PI_CODING_AGENT_DIR`. State uses the OS user cache directory:

- Linux: `${XDG_CACHE_HOME:-$HOME/.cache}/pi-usage`
- macOS: `$HOME/Library/Caches/pi-usage`
- Windows: `%LOCALAPPDATA%\\pi-usage`

Each provider has an independent freshness window, lease, last-good snapshot, and retry deadline. The initial freshness window remains 60 seconds.

For every resolution:

1. Fresh cached usage returns without an endpoint call.
2. Stale usage triggers one endpoint call when retry policy permits it.
3. Concurrent local callers wait and receive the lease owner's result.
4. `Retry-After` becomes an absolute deadline shared by every local Pi process.
5. A failed refresh preserves last-good usage and marks it stale.
6. A provider without last-good data returns unavailable.

Cached data inside the freshness window is fresh. Stale means refresh was due but could not complete.

Coordination is per OS account and machine. Different machines do not share state.

## Events

| Event | Payload | Description |
|---|---|---|
| `usage-core:ready` | `{ state: UsageCoreState }` | Initial resolved state for the selected provider |
| `usage-core:update-current` | `{ state: UsageCoreState }` | Result of each lifecycle-triggered resolution |

`UsageCoreState` retains the existing `provider` and `usage` fields and adds:

- `availability`: `available` or `unavailable`;
- `freshness`: `fresh` or `stale` when usage is available;
- `source`: `cache` or `endpoint`;
- `fetchedAt` and `observedAt` timestamps;
- optional `retryAt`, `staleReason`, and `error` fields.

Consumers should keep stale usage visible unless their interface requires otherwise. An unavailable result has no usable snapshot.

## Endpoint protection

A provider endpoint call requires that provider's filesystem lease. A caller that cannot acquire the lease waits for the owner; timeout never grants permission to fetch without ownership.

Provider failures preserve the last successful snapshot. HTTP `Retry-After` supports seconds and HTTP-date forms. Failures without a valid header use the provider's fallback backoff.

## Install

```bash
pi install npm:@juanibiapina/pi-usage
```

## Programmatic usage

Node.js consumers running TypeScript through a compatible loader can read one
provider on demand through the supported reader subpath:

```ts
import { getUsage } from "@juanibiapina/pi-usage/reader";

const usage = await getUsage("anthropic");
```

`getUsage` returns a `UsageResolution`. It uses the same credential lookup,
provider implementation, freshness window, retry deadline, filesystem lease,
and last-good snapshot as the pi extension.

## Development

```bash
npm install
npm test
npm run check
```
