import { describe, expect, it } from "vitest"

import {
  httpSignal,
  parseReset,
  parseRetryAfter,
  signalOf,
  tidyReason,
  withSignal,
} from "./signals.js"

const NOW = Date.parse("2026-11-17T12:00:00Z")
const headers = (values: Record<string, string>) => new Headers(values)

describe("Retry-After and rate-limit resets", () => {
  it("reads seconds and HTTP dates, and nothing else", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000)
    expect(parseRetryAfter("1.5", NOW)).toBe(1_500)
    expect(parseRetryAfter("Tue, 17 Nov 2026 12:01:00 GMT", NOW)).toBe(60_000)
    expect(parseRetryAfter("Tue, 17 Nov 2026 11:00:00 GMT", NOW)).toBe(0)
    expect(parseRetryAfter("soon", NOW)).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
    // No longer than a day, whatever a place asks.
    expect(parseRetryAfter("9999999", NOW)).toBe(24 * 60 * 60 * 1000)
  })

  it("tells a reset in seconds from a Unix time", () => {
    expect(parseReset("30", NOW)).toBe(30_000)
    expect(parseReset(String(NOW / 1000 + 45), NOW)).toBe(45_000)
    expect(parseReset("x", NOW)).toBeUndefined()
  })
})

describe("HTTP's signals", () => {
  it("refuses on a 429, with its Retry-After or the rate limit's reset", () => {
    expect(
      httpSignal(429, headers({ "retry-after": "60" }), "Things", NOW),
    ).toEqual({
      kind: "refuse",
      reason: "Things answered HTTP 429: it asks to be called less often",
      retryAfterMs: 60_000,
    })
    expect(
      httpSignal(429, headers({ "ratelimit-reset": "5" }), "It", NOW),
    ).toMatchObject({ kind: "refuse", retryAfterMs: 5_000 })
    expect(httpSignal(429, headers({}), "It", NOW)).not.toHaveProperty(
      "retryAfterMs",
    )
  })

  it("refuses on a 503 only when it says when to come back", () => {
    expect(httpSignal(503, headers({}), "It", NOW)).toBeNull()
    expect(
      httpSignal(503, headers({ "retry-after": "10" }), "It", NOW),
    ).toMatchObject({ kind: "refuse", retryAfterMs: 10_000 })
  })

  it("holds the next calls when a rate limit that went through has nothing left", () => {
    expect(
      httpSignal(
        200,
        headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "20" }),
        "It",
        NOW,
      ),
    ).toEqual({
      kind: "hold",
      reason: "its rate limit has no calls left until it resets",
      retryAfterMs: 20_000,
    })
    expect(
      httpSignal(200, headers({ "ratelimit-remaining": "3" }), "It", NOW),
    ).toBeNull()
    // Nothing left but no reset: nothing to wait for.
    expect(
      httpSignal(200, headers({ "ratelimit-remaining": "0" }), "It", NOW),
    ).toBeNull()
  })
})

describe("a signal carried beside a value", () => {
  it("rides off the value's own keys, and is found through causes", () => {
    const answer = withSignal(
      { text: "ok" },
      { kind: "slow", reason: "  Marked [THROTTLED].  " },
    )

    expect(Object.keys(answer)).toEqual(["text"])
    expect(JSON.stringify(answer)).toBe('{"text":"ok"}')
    expect(signalOf(answer)).toEqual({
      kind: "slow",
      reason: "Marked [THROTTLED]",
    })

    const inner = withSignal(new Error("429"), {
      kind: "refuse",
      reason: "too many",
    })
    const outer = new Error("call failed", { cause: inner })
    expect(signalOf(outer)).toMatchObject({ kind: "refuse" })
    expect(signalOf(new Error("plain"))).toBeNull()
    expect(signalOf(null)).toBeNull()
  })

  it("keeps a reason to one short line", () => {
    expect(tidyReason("a\n  b.  ")).toBe("a b")
    expect(tidyReason("x".repeat(500))).toHaveLength(200)
  })
})
