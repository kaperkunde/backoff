---
"@kaperkunde/backoff": minor
---

First release: per-place limits for outgoing calls (calls at once, spacing, calls a minute over a sliding window, time limits, bytes a day), a cool-down on a refusal with one probe call after it (cockatiel's circuit breaker), a slowdown when a place asks to be called more gently or turns slow, holds until a rate limit resets, time limits learned from a tool's answers (RFC 6298), HTTP's signals (429, 503 with Retry-After, rate-limit headers), and counters over a minute, an hour and a day.
