/**
 * What a place (a server, an API, a site) says about how fast it is called,
 * read off its answers so the limiter can act on it without knowing the
 * protocol. Three kinds, and they are treated very differently:
 *
 * - `refuse`: it turned a call away as too many or too fast (HTTP 429, a 503
 *   with Retry-After, an IMAP NO or BYE about rate, a JMAP limit error). The
 *   place cools down: calls are refused at once until it is likely to take
 *   them again, then a single call probes it.
 * - `slow`: it answered, but asked to be called more gently (an IMAP answer
 *   marked [THROTTLED]), or it is answering far slower than usual. Calls
 *   still go, one at a time, further apart and with more time each, easing
 *   back as answers come back clean. Never a refusal: a slow answer beats
 *   none.
 * - `hold`: its rate limit has nothing left until a reset
 *   (`RateLimit-Remaining: 0`). The next calls wait for the reset; nothing
 *   cools down, since the limit may be one bucket of many.
 */
export type Signal =
  | { kind: "refuse"; reason: string; retryAfterMs?: number }
  | { kind: "slow"; reason: string }
  | { kind: "hold"; reason: string; retryAfterMs: number }

/** The longest wait a place's own hint is followed for. */
export const MAX_HINT_MS = 24 * 60 * 60 * 1000

const MAX_REASON = 200

/** A reason as the limiter keeps it: one line, short, without a full stop. */
export function tidyReason(reason: string): string {
  return reason
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_REASON)
    .replace(/[.\s]+$/, "")
}

/** A Retry-After value: delay seconds or an HTTP date. Milliseconds, or undefined. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const text = value?.trim()

  if (!text) {
    return undefined
  }

  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.min(Math.round(Number(text) * 1000), MAX_HINT_MS)
  }

  const at = Date.parse(text)

  return Number.isNaN(at)
    ? undefined
    : Math.min(Math.max(0, at - now), MAX_HINT_MS)
}

/**
 * A rate limit's reset: seconds from now (RateLimit-Reset, and most
 * X-RateLimit-Reset), or a Unix time in seconds (some APIs'
 * X-RateLimit-Reset), told apart by size.
 */
export function parseReset(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value || !/^\s*\d+(\.\d+)?\s*$/.test(value)) {
    return undefined
  }

  const number = Number(value)
  const ms =
    number > 1_000_000_000
      ? Math.max(0, Math.round(number * 1000 - now))
      : Math.round(number * 1000)

  return Math.min(ms, MAX_HINT_MS)
}

/** Anything with a `get` for header names, such as fetch's Headers. */
export type HeaderSource = { get(name: string): string | null }

/**
 * HTTP's own signals for one answer, or null:
 *
 * - 429 always refuses; a 503 refuses only when it says when to come back
 *   (one without Retry-After is a server that is down, not one asking for
 *   time). How long: Retry-After, else the rate limit's reset.
 * - An answer that went through but says its rate limit has nothing left
 *   (`RateLimit-Remaining: 0` or the X- form, with a reset) holds the next
 *   calls until the reset.
 *
 * `who` names the place in the reason.
 */
export function httpSignal(
  status: number,
  headers: HeaderSource,
  who = "It",
  now: number = Date.now(),
): Signal | null {
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"), now)
  const reset =
    parseReset(headers.get("ratelimit-reset"), now) ??
    parseReset(headers.get("x-ratelimit-reset"), now)

  if (status === 429 || (status === 503 && retryAfterMs !== undefined)) {
    const wait = retryAfterMs ?? reset

    return {
      kind: "refuse",
      reason: `${who} answered HTTP ${status}: it asks to be called less often`,
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    }
  }

  if (status === 503) {
    return null
  }

  const remaining =
    headers.get("ratelimit-remaining") ?? headers.get("x-ratelimit-remaining")

  if (remaining === null || !/^\s*0+\s*$/.test(remaining)) {
    return null
  }

  return reset === undefined || reset <= 0
    ? null
    : {
        kind: "hold",
        reason: "its rate limit has no calls left until it resets",
        retryAfterMs: reset,
      }
}

const SIGNAL = Symbol.for("kaperkunde.backoff.signal")

/**
 * Marks an error or an answer with the place's signal, off its own keys (a
 * symbol), so it travels to the limiter beside the value and is never sent
 * on with it.
 */
export function withSignal<T extends object>(
  value: T,
  signal: Signal | null,
): T {
  if (signal) {
    Object.defineProperty(value, SIGNAL, {
      value: { ...signal, reason: tidyReason(signal.reason) },
      enumerable: false,
      configurable: true,
      writable: true,
    })
  }

  return value
}

/** The signal an error (or one of its causes) or an answer carries, or null. */
export function signalOf(value: unknown): Signal | null {
  for (
    let at: unknown = value, depth = 0;
    at && typeof at === "object" && depth < 5;
    depth++
  ) {
    const found = (at as { [SIGNAL]?: Signal })[SIGNAL]

    if (found && typeof found === "object" && "kind" in found) {
      return found
    }

    at = (at as { cause?: unknown }).cause
  }

  return null
}
