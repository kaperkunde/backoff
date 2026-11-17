import { describe, expect, it } from "vitest"

import { Latency } from "./latency.js"
import { DEFAULT_LIMITS } from "./limits.js"
import { Slowdown, slowedLimits } from "./slowdown.js"
import { Counters } from "./stats.js"

describe("a tool's times", () => {
  const ok = (tool: string, ms: number) => ({
    tool,
    ms,
    ok: true,
    timedOut: false,
  })

  it("takes a run of answers far slower than the tool's usual as slowness", () => {
    const latency = new Latency()
    for (let i = 0; i < 10; i++) latency.record(ok("search", 400), "latency")

    expect(latency.usualMs("search")).toBe(400)
    expect(latency.record(ok("search", 80_000), "latency")).toBeNull()
    expect(latency.isSlow("search")).toBe(true)
    expect(latency.record(ok("search", 81_000), "latency")).toBeNull()
    expect(latency.record(ok("search", 85_000), "latency")).toBe(
      "its answers to search are taking much longer than usual (3 in a row, about 85 s each against 1 s)",
    )
  })

  it("never takes a slow tool for a slow place, and counts only time limits where asked", () => {
    const latency = new Latency()
    for (let i = 0; i < 10; i++) latency.record(ok("ls", 80), "latency")
    for (let i = 0; i < 3; i++) {
      expect(latency.record(ok("build", 60_000), "latency")).toBeNull()
    }

    const commands = new Latency()
    for (let i = 0; i < 10; i++) commands.record(ok("run", 80), "timeouts")
    for (let i = 0; i < 5; i++) {
      expect(commands.record(ok("run", 60_000), "timeouts")).toBeNull()
    }
  })

  it("takes calls past their time limit in a row, whatever the tool, as one", () => {
    const latency = new Latency()
    const late = (tool: string) => ({
      tool,
      ms: 45_000,
      ok: false,
      timedOut: true,
    })

    expect(latency.record(late("a"), "latency")).toBeNull()
    expect(latency.record(late("b"), "latency")).toBeNull()
    expect(latency.record(late("a"), "latency")).toBe(
      "3 calls in a row ran past their time limit",
    )
    // Sites count only their own signals.
    const site = new Latency()
    for (let i = 0; i < 5; i++)
      expect(site.record(late("p"), "none")).toBeNull()
  })

  it("learns a time limit from the answers, as TCP's retransmission timeout", () => {
    const latency = new Latency()
    expect(latency.learnedTimeoutMs("slow")).toBeNull()

    for (let i = 0; i < 20; i++) latency.record(ok("slow", 60_000), "latency")
    // Steady answers: the smoothed time, plus at least a second.
    const steady = latency.learnedTimeoutMs("slow")!
    expect(steady).toBeGreaterThanOrEqual(61_000)
    expect(steady).toBeLessThan(70_000)

    // Answers that vary are given room for the variation.
    const jumpy = new Latency()
    for (let i = 0; i < 20; i++) {
      jumpy.record(ok("jumpy", i % 2 ? 10_000 : 40_000), "latency")
    }
    expect(jumpy.learnedTimeoutMs("jumpy")!).toBeGreaterThan(60_000)
  })
})

describe("a slowdown", () => {
  const T = 1_000_000

  it("steps up with each signal, eases off with clean answers, and is forgotten", () => {
    const slowdown = new Slowdown()

    expect(slowdown.signal("throttled", T)).toBe(true)
    for (let i = 0; i < 10; i++)
      expect(slowdown.signal("throttled", T)).toBe(false)
    expect(slowdown.at(T)?.level).toBe(4)

    for (let level = 4; level > 0; level--) {
      for (let i = 0; i < 3; i++) {
        expect(slowdown.at(T)?.level).toBe(level)
        slowdown.clean()
      }
    }
    expect(slowdown.at(T)).toBeNull()

    slowdown.signal("throttled", T)
    expect(slowdown.at(T + 30 * 60_000)).toBeNull()
  })

  it("is one call at a time, further apart at each level, with a longer time limit", () => {
    const limits = { ...DEFAULT_LIMITS, timeoutMs: 45_000, minIntervalMs: 250 }

    expect(slowedLimits(limits, 1)).toEqual({
      ...limits,
      maxConcurrent: 1,
      minIntervalMs: 1_000,
      timeoutMs: 135_000,
    })
    expect(slowedLimits(limits, 2).minIntervalMs).toBe(2_000)
    expect(slowedLimits(limits, 9).minIntervalMs).toBe(8_000)
    expect(slowedLimits(limits, 4).timeoutMs).toBe(135_000)
    expect(
      slowedLimits({ ...limits, minIntervalMs: 30_000 }, 1).minIntervalMs,
    ).toBe(30_000)
    // Never past the longest, unless the place's own limit already is.
    expect(
      slowedLimits({ ...limits, timeoutMs: 20 * 60_000 }, 1).timeoutMs,
    ).toBe(30 * 60_000)
    expect(
      slowedLimits({ ...limits, timeoutMs: 40 * 60_000 }, 1).timeoutMs,
    ).toBe(40 * 60_000)
  })
})

describe("counters", () => {
  it("count a minute, an hour and a day, with percentiles and bytes", () => {
    let now = Date.parse("2026-11-17T12:00:30Z")
    const counters = new Counters(now, () => 0.5)

    for (const ms of [100, 200, 300, 400, 1_000]) {
      counters.record({ ok: true, ms, bytes: 1_000 }, now)
    }
    now += 30 * 60_000
    counters.record({ ok: false, ms: 50, signalled: true }, now)
    now += 2 * 60 * 60_000
    counters.record({ ok: true, ms: 70, bytes: 10 }, now)

    const windows = counters.windows(now)
    expect(windows.minute).toMatchObject({ calls: 1, errors: 0, bytes: 10 })
    expect(windows.hour).toMatchObject({ calls: 1 })
    expect(windows.day).toMatchObject({
      calls: 7,
      errors: 1,
      signals: 1,
      bytes: 5_010,
    })
    expect(windows.day.p50Ms).toBe(200)
    expect(counters.bytesToday(now)).toBe(5_010)
    expect(counters.bytesFreeIn(5_000, now)).toBeGreaterThan(20 * 60 * 60_000)
  })
})
