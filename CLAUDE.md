# Working in this repo

`@kaperkunde/backoff`, published to npm. Read README.md first.

## Rules

- **Compose, don't reinvent.** Calls at once, waiting a turn and calls a
  minute are p-queue's; the cool-down is cockatiel's circuit breaker. Only
  what neither does lives here (signals, slowdown, learned time limits,
  spacing, holds, byte budgets, counters). Before adding a mechanism, check
  whether a well-supported library already does it.
- **Nothing app-specific.** No hosts, vendors or product names; an app's
  rules come in as options and `classify`. Reasons are plain words an app may
  show; the app words its own messages from `why` and `retryAfterMs`.
- **A slow answer is never a refusal.** Only a `refuse` signal cools a place
  down; `slow` and slowness only slow it down. Keep it that way.
- **Bounded.** Every queue has a bound and every wait a deadline; timers are
  unref'd; places are dropped when idle past `maxPlaces`. State is in memory.
- **Expected failures are returned, not thrown**: `run` answers `refused` and
  `timeout`; it throws only when the caller's own signal aborts.
- **Every change carries a changeset** (`pnpm changeset`); a breaking change
  is a major with a migration note.
- Tests sit next to the code and use Vitest's fake timers.

## Before pushing

```bash
pnpm lint && pnpm format:check && pnpm build && pnpm typecheck && pnpm test
```
