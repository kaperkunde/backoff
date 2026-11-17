import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Backoff } from "./backoff.js"
import { DEFAULT_LIMITS, type Limits } from "./limits.js"
import { Place, type RunResult } from "./place.js"
import { withSignal } from "./signals.js"

const NOW = Date.parse("2026-11-17T12:00:00Z")

function place(limits: Partial<Limits> = {}, extra = {}): Place {
  return new Place("k", {
    label: "Mail",
    limits: { ...DEFAULT_LIMITS, timeoutMs: 10_000, ...limits },
    ...extra,
  })
}

/** A call that answers `value` after `ms`. */
function after<T>(ms: number, value: T): () => Promise<T> {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/** A call that stays open until its `finish` is called. */
function open<T>(value: T) {
  let finish!: () => void
  const promise = new Promise<T>((resolve) => {
    finish = () => resolve(value)
  })
  return { call: () => promise, finish: () => finish() }
}

/** Runs a call, moving the fake clock until it settles. */
async function runOn<T>(
  where: Place,
  call: Parameters<Place["run"]>[0],
  options?: Parameters<Place["run"]>[1],
): Promise<RunResult<T>> {
  let settled = false
  const result = where
    .run(call as () => Promise<T>, options as never)
    .finally(() => {
      settled = true
    })
  for (let i = 0; i < 10_000 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(100)
  }
  return result as Promise<RunResult<T>>
}

const throttled = () =>
  withSignal({ text: "found" }, { kind: "slow", reason: "marked [THROTTLED]" })

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a call", () => {
  it("runs, is counted and answered as it came", async () => {
    const mail = place()
    const result = mail.run(after(200, "found"), { bytes: () => 50 })
    await vi.advanceTimersByTimeAsync(200)

    expect(await result).toEqual({
      kind: "ok",
      value: "found",
      ms: 200,
      effect: null,
    })
    expect(mail.view().minute).toMatchObject({ calls: 1, errors: 0, bytes: 50 })
  })

  it("keeps its error, counted as one", async () => {
    const mail = place()
    const error = new Error("no such mailbox")
    const result = await runOn(mail, async () => {
      throw error
    })

    expect(result).toMatchObject({ kind: "error", error })
    expect(mail.view().minute).toMatchObject({ calls: 1, errors: 1 })
  })

  it("answers timeout past its limit, and keeps its turn until it ends", async () => {
    const mail = place({ maxConcurrent: 1, timeoutMs: 1_000 })
    const slow = open("late")
    const first = mail.run(slow.call)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(await first).toEqual({ kind: "timeout", timeoutMs: 1_000 })
    expect(mail.view().running).toBe(1)

    // The next one waits for the turn the first still holds.
    let ran = false
    const second = mail.run(async () => {
      ran = true
      return "next"
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(ran).toBe(false)

    slow.finish()
    await vi.advanceTimersByTimeAsync(10)
    expect(await second).toMatchObject({ kind: "ok", value: "next" })
  })

  it("gives the turn back after the linger even when the call never ends", async () => {
    const mail = place(
      { maxConcurrent: 1, timeoutMs: 1_000 },
      { lingerMs: 5_000 },
    )
    void mail.run(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mail.view().running).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mail.view().running).toBe(0)
  })
})

describe("waiting its turn", () => {
  it("waits for a turn within its own wait, else is refused as busy", async () => {
    const mail = place({ maxConcurrent: 1 })
    const busy = open("first")
    void mail.run(busy.call)

    const patient = mail.run(async () => "second", { waitMs: 5_000 })
    const hasty = mail.run(async () => "third", { waitMs: 100 })
    await vi.advanceTimersByTimeAsync(100)

    expect(await hasty).toMatchObject({ kind: "refused", why: "busy" })
    expect(mail.view().waiting).toBe(1)

    busy.finish()
    await vi.advanceTimersByTimeAsync(1)
    expect(await patient).toMatchObject({ kind: "ok", value: "second" })
  })

  it("spaces its calls out, and refuses one that cannot wait for its turn", async () => {
    const mail = place({ minIntervalMs: 1_000 })
    const starts: number[] = []
    const call = async () => {
      starts.push(Date.now() - NOW)
      return "ok"
    }

    const runs = [mail.run(call), mail.run(call), mail.run(call)]
    await vi.advanceTimersByTimeAsync(3_000)
    await Promise.all(runs)
    expect(starts).toEqual([0, 1_000, 2_000])

    void mail.run(call)
    expect(await runOn(mail, call, { waitMs: 10 })).toMatchObject({
      kind: "refused",
      why: "busy",
    })
  })

  it("keeps to calls a minute over a sliding window", async () => {
    const mail = place({ callsPerMinute: 2 })
    const starts: number[] = []
    const call = async () => {
      starts.push(Date.now() - NOW)
      return "ok"
    }

    const runs = [1, 2, 3].map(() => mail.run(call, { waitMs: 120_000 }))
    await vi.advanceTimersByTimeAsync(61_000)
    await Promise.all(runs)
    expect(starts.slice(0, 2)).toEqual([0, 0])
    expect(starts[2]).toBeGreaterThanOrEqual(60_000)

    // The minute since 60 s holds one start; one more fits, then none.
    expect(await runOn(mail, call, { waitMs: 1_000 })).toMatchObject({
      kind: "ok",
    })
    expect(await runOn(mail, call, { waitMs: 1_000 })).toMatchObject({
      kind: "refused",
      why: "busy",
    })
  })

  it("refuses at once past the waiting bound", async () => {
    const mail = place({ maxConcurrent: 1 }, { maxWaiting: 1 })
    const busy = open("first")
    void mail.run(busy.call)
    void mail.run(async () => "second")

    expect(await runOn(mail, async () => "third")).toMatchObject({
      kind: "refused",
      why: "full",
    })
  })

  it("leaves the queue when its caller gives up", async () => {
    const mail = place({ maxConcurrent: 1 })
    void mail.run(open("first").call)
    const controller = new AbortController()
    const waiting = mail.run(async () => "never", {
      signal: controller.signal,
    })
    controller.abort(new Error("gone"))

    await expect(waiting).rejects.toThrow("gone")
    expect(mail.view().waiting).toBe(0)
  })
})

describe("a refusal", () => {
  const refusal = (retryAfterMs?: number) => () =>
    Promise.reject(
      withSignal(new Error("HTTP 429"), {
        kind: "refuse",
        reason: "it answered HTTP 429",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }),
    )

  it("cools the place down for as long as it asked, refusing calls at once", async () => {
    const mail = place()
    const first = await runOn(mail, refusal(90_000))

    expect(first).toMatchObject({
      kind: "error",
      effect: {
        kind: "cooling",
        cooling: {
          reason: "it answered HTTP 429",
          since: NOW,
          until: NOW + 90_000,
        },
      },
    })

    let ran = false
    const refused = await runOn(mail, async () => {
      ran = true
      return "no"
    })
    expect(ran).toBe(false)
    expect(refused).toMatchObject({
      kind: "refused",
      why: "cooling",
      reason: "it answered HTTP 429",
    })
    expect((refused as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(
      89_000,
    )
    expect(mail.view().day).toMatchObject({ calls: 1, errors: 1, signals: 1 })
  })

  it("probes with one call once it ends, and doubles while the probe is refused", async () => {
    const mail = place({ backoffBaseMs: 10_000, backoffMaxMs: 25_000 })
    const lengths: number[] = []

    for (let round = 0; round < 3; round++) {
      const result = (await runOn(mail, refusal())) as Extract<
        RunResult<unknown>,
        { kind: "error" }
      >
      const cooling = mail.cooling()!
      lengths.push(cooling.until - cooling.since)
      expect(result.effect?.kind).toBe("cooling")
      await vi.advanceTimersByTimeAsync(cooling.until - Date.now())
    }
    expect(lengths).toEqual([10_000, 20_000, 25_000])

    // A probe that is not refused closes it; the next refusal starts over.
    expect(await runOn(mail, async () => "back")).toMatchObject({ kind: "ok" })
    await runOn(mail, refusal())
    const fresh = mail.cooling()!
    expect(fresh.until - fresh.since).toBe(10_000)
  })

  it("lets one probe through and turns the others away while it runs", async () => {
    const mail = place({ backoffBaseMs: 1_000 })
    await runOn(mail, refusal())
    await vi.advanceTimersByTimeAsync(1_000)

    const probe = open("probe")
    const first = mail.run(probe.call)
    await vi.advanceTimersByTimeAsync(1)
    expect(await runOn(mail, async () => "other")).toMatchObject({
      kind: "refused",
      why: "probing",
    })
    probe.finish()
    expect(await first).toMatchObject({ kind: "ok", value: "probe" })
  })

  it("goes slower after the cool-down, and the owner can end both", async () => {
    const mail = place({ backoffBaseMs: 1_000 })
    await runOn(mail, refusal())
    expect(mail.slowing()?.reason).toBe("it answered HTTP 429")

    mail.reset()
    expect(mail.cooling()).toBeNull()
    expect(mail.slowing()).toBeNull()
    expect(await runOn(mail, async () => "now")).toMatchObject({ kind: "ok" })
  })

  it("cools down on a refusal that comes after its caller stopped waiting", async () => {
    const mail = place({ timeoutMs: 1_000 })
    let refuse!: () => void
    const result = mail.run(
      () =>
        new Promise((_, reject) => {
          refuse = () =>
            reject(
              withSignal(new Error("BYE"), {
                kind: "refuse",
                reason: "too many logins",
              }),
            )
        }),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await result).toMatchObject({ kind: "timeout" })
    expect(mail.cooling()).toBeNull()

    refuse()
    await vi.advanceTimersByTimeAsync(1)
    expect(mail.cooling()?.reason).toBe("too many logins")
  })
})

describe("a place that asks to be called more gently", () => {
  it("keeps the answer, says so once, and sends the next calls one at a time with longer limits", async () => {
    const mail = place({ maxConcurrent: 4, timeoutMs: 2_000 })
    const first = await runOn(mail, async () => throttled())

    expect(first).toMatchObject({
      kind: "ok",
      value: { text: "found" },
      effect: {
        kind: "slowing",
        slowing: { level: 1, reason: "marked [THROTTLED]" },
        limits: { maxConcurrent: 1, minIntervalMs: 1_000, timeoutMs: 6_000 },
      },
    })
    expect(mail.cooling()).toBeNull()

    let given = 0
    const next = mail.run(async ({ timeoutMs }) => {
      given = timeoutMs
      return throttled()
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await next).toMatchObject({ kind: "ok", effect: null })
    expect(given).toBe(6_000)
    expect(mail.limits().minIntervalMs).toBe(2_000)
  })

  it("never cools down however many marked answers come, and eases off when they stop", async () => {
    const mail = place()

    for (let i = 0; i < 12; i++) {
      const result = mail.run(async () => throttled())
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await result).toMatchObject({ kind: "ok" })
    }
    expect(mail.cooling()).toBeNull()
    expect(mail.slowing()?.level).toBe(4)

    for (let i = 0; i < 12; i++) {
      const result = mail.run(async () => "clean")
      await vi.advanceTimersByTimeAsync(10_000)
      await result
    }
    expect(mail.slowing()).toBeNull()
    expect(mail.limits().maxConcurrent).toBe(DEFAULT_LIMITS.maxConcurrent)
  })

  it("slows down, not cools, for a marked answer past the time limit", async () => {
    const mail = place({ timeoutMs: 1_000 })
    const slow = open(throttled())
    const result = mail.run(slow.call)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await result).toMatchObject({ kind: "timeout" })

    slow.finish()
    await vi.advanceTimersByTimeAsync(1)
    expect(mail.slowing()?.reason).toBe("marked [THROTTLED]")
    expect(mail.cooling()).toBeNull()
  })

  it("slows down for a run of answers far slower than usual", async () => {
    const mail = place({ timeoutMs: 600_000 })
    for (let i = 0; i < 6; i++) {
      const r = mail.run(after(400, "ok"), { tool: "search" })
      await vi.advanceTimersByTimeAsync(400)
      await r
    }
    const effects = []
    for (let i = 0; i < 3; i++) {
      const r = mail.run(after(60_000, "ok"), { tool: "search" })
      await vi.advanceTimersByTimeAsync(60_000)
      effects.push(((await r) as { effect: unknown }).effect)
    }
    expect(effects[2]).toMatchObject({ kind: "slowing" })
    expect(mail.cooling()).toBeNull()
  })
})

describe("other limits", () => {
  it("holds the next calls until a spent rate limit resets, cooling nothing", async () => {
    const mail = place()
    await runOn(mail, async () =>
      withSignal(
        {},
        { kind: "hold", reason: "no calls left", retryAfterMs: 20_000 },
      ),
    )
    expect(mail.view().holdUntil).toBe(NOW + 20_000)
    expect(mail.cooling()).toBeNull()

    expect(await runOn(mail, async () => "x", { waitMs: 1_000 })).toMatchObject(
      {
        kind: "refused",
        why: "held",
      },
    )
    const waited = mail.run(async () => "y", { waitMs: 30_000 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await waited).toMatchObject({ kind: "ok", value: "y" })
  })

  it("refuses past a day's bytes until the oldest leave the day", async () => {
    const mail = place({ bytesPerDay: 1_000 })
    await runOn(mail, async () => "big", { bytes: () => 1_500 })

    expect(await runOn(mail, async () => "more")).toMatchObject({
      kind: "refused",
      why: "bytes",
    })
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 60_000)
    expect(await runOn(mail, async () => "more")).toMatchObject({ kind: "ok" })
  })

  it("learns a longer time limit for a tool that is always slow, within its bounds", async () => {
    const api = place(
      { timeoutMs: 30_000 },
      { learnTimeout: { ceilingMs: 120_000 } },
    )
    expect(api.limits("report").timeoutMs).toBe(30_000)

    for (let i = 0; i < 10; i++) {
      const r = api.run(after(28_000, "ok"), { tool: "report" })
      await vi.advanceTimersByTimeAsync(28_000)
      await r
    }
    const learned = api.limits("report").timeoutMs
    expect(learned).toBeGreaterThan(29_000)
    expect(learned).toBeLessThanOrEqual(120_000)
    // Another tool keeps the limits' own.
    expect(api.limits("ping").timeoutMs).toBe(30_000)
  })

  it("counts and reads a call made some other way", async () => {
    const site = place()
    expect(await site.observe({ ok: true, ms: 300, bytes: 10 })).toBeNull()
    const effect = await site.observe({
      ok: false,
      ms: 50,
      signal: { kind: "refuse", reason: "HTTP 429", retryAfterMs: 5_000 },
    })
    expect(effect).toMatchObject({
      kind: "cooling",
      cooling: { until: NOW + 5_000 },
    })
    expect(site.view().minute).toMatchObject({
      calls: 2,
      signals: 1,
      bytes: 10,
    })
  })
})

describe("the places", () => {
  it("are bounded, dropping an idle one first and never one that is cooling down", async () => {
    const backoff = new Backoff({ maxPlaces: 2 })
    const options = { label: "x", limits: DEFAULT_LIMITS }
    const a = backoff.place("a", options)
    await runOn(a, () =>
      Promise.reject(
        withSignal(new Error("429"), { kind: "refuse", reason: "busy" }),
      ),
    )
    backoff.place("b", options)
    backoff.place("c", options)

    expect(backoff.size).toBe(2)
    expect(backoff.peek("a")).toBe(a)
    expect(backoff.peek("b")).toBeUndefined()
  })

  it("updates a place's limits when asked for it again", () => {
    const backoff = new Backoff()
    const first = backoff.place("a", { label: "A", limits: DEFAULT_LIMITS })
    const again = backoff.place("a", {
      label: "A2",
      limits: { ...DEFAULT_LIMITS, maxConcurrent: 1 },
    })

    expect(again).toBe(first)
    expect(again.label).toBe("A2")
    expect(again.limits().maxConcurrent).toBe(1)
  })
})
