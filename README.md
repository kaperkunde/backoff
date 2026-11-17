# @kaperkunde/backoff

Limits for the calls a process makes to other places (servers, APIs, sites),
one set per place, and what to do when a place says it is being called too
fast. It composes two well-supported libraries and adds the parts they leave
out:

| Part                                                                | From                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Calls at once, waiting a turn within a deadline, priorities         | [p-queue](https://github.com/sindresorhus/p-queue)                     |
| Calls a minute over a sliding window                                | p-queue (`strict`)                                                     |
| Cool-down after a refusal, a single probe call after it             | [cockatiel](https://github.com/connor4312/cockatiel)'s circuit breaker |
| Reading a place's signals (429, Retry-After, rate-limit headers, …) | here                                                                   |
| Going slower when a place asks to be called more gently             | here (additive increase, multiplicative decrease)                      |
| Time limits learned from a tool's answers                           | here (RFC 6298, as TCP's retransmission timeout)                       |
| Spacing, holds until a rate limit resets, bytes a day, counters     | here                                                                   |

```bash
pnpm add @kaperkunde/backoff
```

## The three signals

A place says how fast it wants to be called in three ways, and they are
handled very differently:

- **`refuse`**: it turned a call away (HTTP 429, a 503 with Retry-After, an
  IMAP NO or BYE about rate). The place **cools down**: calls are refused at
  once, for as long as it asked (else `backoffBaseMs`, doubling while the
  probe after it is refused again, to `backoffMaxMs`), then one call probes
  it.
- **`slow`**: it answered, but asked to be called more gently (an IMAP answer
  marked `[THROTTLED]`), or its answers turned far slower than usual. The
  place **goes slower**: its calls still go, one at a time, further apart and
  with a longer time limit, and it eases back as answers come back clean. A
  slow answer is better than none, and refusing calls to a place that still
  answers can make it unusable for a day.
- **`hold`**: its rate limit has nothing left until a reset. The next calls
  **wait** for the reset; nothing cools down.

## Use

```ts
import { Backoff, httpSignal, withSignal } from "@kaperkunde/backoff"

const backoff = new Backoff()

async function callApi(path: string) {
  const place = backoff.place("api.example.com", {
    label: "Example API",
    limits: {
      maxConcurrent: 4,
      minIntervalMs: 0,
      callsPerMinute: 120,
      timeoutMs: 30_000,
      bytesPerDay: null,
      backoffBaseMs: 30_000,
      backoffMaxMs: 15 * 60_000,
    },
    // Raise a tool's time limit to what its answers show it needs.
    learnTimeout: { ceilingMs: 5 * 60_000 },
  })

  const result = await place.run(
    async ({ signal }) => {
      const response = await fetch(`https://api.example.com${path}`, { signal })
      return withSignal(response, httpSignal(response.status, response.headers))
    },
    { tool: path, waitMs: 10_000 },
  )

  switch (result.kind) {
    case "ok":
      // result.effect says when this answer started a cool-down or slowdown.
      return result.value
    case "error":
      throw result.error
    case "refused":
      // Nothing was sent: result.why, result.reason, result.retryAfterMs.
      throw new Error(
        `Try again in ${result.retryAfterMs} ms: ${result.reason}`,
      )
    case "timeout":
      throw new Error(`No answer within ${result.timeoutMs} ms`)
  }
}
```

A call's own signal comes from `classify` when given, else from one marked on
its value or error with `withSignal` (found through `cause` too).
`place.observe()` counts a call made some other way and reads its signal;
`place.view()` gives the counters (calls, errors, signals, bytes, p50 and p95
over a minute, an hour and a day) and the state; `place.reset()` ends a
cool-down and a slowdown at once.

## Working here

```bash
pnpm install
pnpm lint && pnpm format:check && pnpm build && pnpm typecheck && pnpm test
pnpm changeset        # in every pull request that changes the package
```

Releases are automatic: merging to `main` opens or updates a "Version
packages" pull request; merging that publishes to npm through npm's trusted
publishing, with provenance.

MIT, © Kaperkunde.
