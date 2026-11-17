import PQueue from "p-queue"

import { Cooldown, type Cooling } from "./cooldown.js"
import {
  LATENCY_DEFAULTS,
  Latency,
  type LatencyOptions,
  type SlowDetection,
} from "./latency.js"
import type { Limits } from "./limits.js"
import { signalOf, tidyReason, type Signal } from "./signals.js"
import {
  SLOWDOWN_DEFAULTS,
  Slowdown,
  type Slowing,
  type SlowdownOptions,
} from "./slowdown.js"
import { Counters, type WindowCounts } from "./stats.js"
import { deferred, sleep, unref, waitSignal } from "./timers.js"

/**
 * One place a process calls (a server, an API, a site): its limits, the
 * calls running and waiting, its cool-down and slowdown, and its counters.
 *
 * A call, in order:
 * 1. Cooling down (the place refused a call): refused at once, with when to
 *    try again. A probe call is let through once the cool-down ends.
 * 2. Its bytes for the day spent: refused the same way.
 * 3. A rate limit with nothing left until a reset: waits for it, within
 *    the call's own wait.
 * 4. Calls a minute (p-queue's sliding window), its spacing, and calls at
 *    once (p-queue's concurrency): waits its turn, within its own wait, else
 *    refused as busy. The waiting queue is bounded (`maxWaiting`).
 * 5. Runs within its time limit; past it the caller hears `timeout`, while
 *    the call keeps its turn until it really ends (at most `lingerMs` more),
 *    so a place that hangs is not sent more at once.
 * 6. Read for signals (the place's own, and slowness), counted.
 *
 * While the place goes slower (it asked, or turned slow) its limits are the
 * slowed ones: one at a time, further apart, longer time limits.
 */

export type Outcome<T> = { value: T } | { error: unknown }

export type PlaceOptions = {
  /** Its name in the reasons the place gives. */
  label: string
  limits: Limits
  /** What counts as it turning slow; "latency" by default. */
  detect?: SlowDetection
  /**
   * Learn each tool's time limit from its answers (RFC 6298), within these
   * bounds; the limits' own time limit is used until enough answers came.
   * Leave out to always use the limits' own.
   */
  learnTimeout?: { floorMs?: number; ceilingMs: number }
  /** Calls that may wait at once; past it a call is refused as full. */
  maxWaiting?: number
  /** How long a call may wait for its turn when it says nothing. */
  maxWaitMs?: number
  /** How long past its time limit a call keeps its turn. */
  lingerMs?: number
  slowdown?: Partial<SlowdownOptions>
  latency?: Partial<LatencyOptions>
}

export type RunContext = {
  /** Aborts when the caller's signal does. */
  signal: AbortSignal
  /** This call's time limit, as the limiter will wait for it. */
  timeoutMs: number
}

export type RunOptions<T> = {
  /** The tool or kind of call: usual times and learned limits are per tool. */
  tool?: string
  signal?: AbortSignal
  /** How long this call may wait for its turn (its caller's deadline). */
  waitMs?: number
  priority?: number
  /** The place's signal for an outcome; by default one marked with withSignal. */
  classify?: (outcome: Outcome<T>) => Signal | null
  /** Whether a value is a success (an answer can carry an error); true by default. */
  isOk?: (value: T) => boolean
  /** The bytes a value brings, for the day's budget and the counters. */
  bytes?: (value: T) => number
}

/** What a call's end started at its place, for its answer to say. */
export type Effect =
  | { kind: "cooling"; cooling: Cooling }
  | { kind: "slowing"; slowing: Slowing; limits: Limits }

export type RefusedWhy =
  "cooling" | "probing" | "bytes" | "held" | "busy" | "full"

export type RunResult<T> =
  | { kind: "ok"; value: T; ms: number; effect: Effect | null }
  | { kind: "error"; error: unknown; ms: number; effect: Effect | null }
  | {
      kind: "refused"
      why: RefusedWhy
      reason: string
      retryAfterMs: number
    }
  | { kind: "timeout"; timeoutMs: number }

export type PlaceView = {
  running: number
  waiting: number
  cooling: Cooling | null
  slowing: Slowing | null
  /** Calls wait until then for a rate limit's reset; 0 when none. */
  holdUntil: number
  /** The limits in force now (slowed when it goes slower). */
  limits: Limits
  /** Since when this process counts for it. */
  since: number
  minute: WindowCounts
  hour: WindowCounts
  day: WindowCounts
}

const DEFAULT_MAX_WAITING = 1_000
const DEFAULT_MAX_WAIT_MS = 30_000
const DEFAULT_LINGER_MS = 60_000

function rateQueue(callsPerMinute: number | null): PQueue | null {
  return callsPerMinute === null
    ? null
    : new PQueue({
        interval: 60_000,
        intervalCap: callsPerMinute,
        strict: true,
      })
}

export class Place {
  readonly key: string
  #options: PlaceOptions
  #limits: Limits
  #slots: PQueue
  #rate: PQueue | null
  #nextStart = 0
  #holdUntil = 0
  #waiting = 0
  #running = 0
  #cooldown: Cooldown
  #slowdown: Slowdown
  #latency: Latency
  #counters: Counters

  constructor(key: string, options: PlaceOptions) {
    this.key = key
    this.#options = options
    this.#limits = options.limits
    this.#slots = new PQueue({ concurrency: options.limits.maxConcurrent })
    this.#rate = rateQueue(options.limits.callsPerMinute)
    this.#cooldown = new Cooldown(() => this.#limits)
    this.#slowdown = new Slowdown({ ...SLOWDOWN_DEFAULTS, ...options.slowdown })
    this.#latency = new Latency({ ...LATENCY_DEFAULTS, ...options.latency })
    this.#counters = new Counters(Date.now())
  }

  get label(): string {
    return this.#options.label
  }

  /** New limits (or a new label); calls already waiting keep their place. */
  configure(options: Partial<PlaceOptions>): void {
    const next = { ...this.#options, ...options }

    if (
      options.limits &&
      options.limits.callsPerMinute !== this.#limits.callsPerMinute
    ) {
      this.#rate = rateQueue(options.limits.callsPerMinute)
    }

    this.#options = next
    this.#limits = next.limits
  }

  /** The limits in force for a tool now: learned, then slowed. */
  limits(tool = "", now = Date.now()): Limits {
    const base = this.#limits
    const learn = this.#options.learnTimeout
    const learned = learn ? this.#latency.learnedTimeoutMs(tool) : null
    const timeoutMs =
      learn && learned !== null
        ? Math.min(
            learn.ceilingMs,
            Math.max(learn.floorMs ?? base.timeoutMs, learned),
          )
        : base.timeoutMs

    return this.#slowdown.limits({ ...base, timeoutMs }, now)
  }

  /** The limits in force when nothing slows the place down. */
  get baseLimits(): Limits {
    return this.#limits
  }

  cooling(now = Date.now()): Cooling | null {
    return this.#cooldown.at(now)
  }

  slowing(now = Date.now()): Slowing | null {
    return this.#slowdown.at(now)
  }

  usualMs(tool = ""): number {
    return Math.max(1_000, this.#latency.usualMs(tool) ?? 1_000)
  }

  /** Whether the registry may forget it: nothing running, waiting or held. */
  idle(now = Date.now()): boolean {
    return (
      this.#running === 0 &&
      this.#waiting === 0 &&
      this.#cooldown.at(now) === null &&
      this.#slowdown.at(now) === null &&
      this.#holdUntil <= now
    )
  }

  /** Back to normal now: no cool-down, slowdown, hold or runs of slow answers. */
  reset(): void {
    this.#cooldown.reset()
    this.#slowdown.reset()
    this.#holdUntil = 0
    this.#latency.resetRuns()
  }

  view(now = Date.now()): PlaceView {
    return {
      running: this.#running,
      waiting: this.#waiting,
      cooling: this.#cooldown.at(now),
      slowing: this.#slowdown.at(now),
      holdUntil: this.#holdUntil > now ? this.#holdUntil : 0,
      limits: this.limits("", now),
      since: this.#counters.since,
      ...this.#counters.windows(now),
    }
  }

  /** Bytes answered over the last day. */
  bytesToday(now = Date.now()): number {
    return this.#counters.bytesToday(now)
  }

  /**
   * Counts a call made some other way (a page a browser opened, a fetch
   * with its own timing) and reads its signal, without a turn: a refusal
   * cools the place down, a hold holds it, a "go slower" slows it.
   */
  async observe(end: {
    ok: boolean
    ms: number
    bytes?: number
    signal?: Signal | null
    tool?: string
  }): Promise<Effect | null> {
    const now = Date.now()
    const derived = this.#latency.record(
      { tool: end.tool ?? "", ms: end.ms, ok: end.ok, timedOut: false },
      this.#options.detect ?? "latency",
    )
    this.#counters.record(
      {
        ok: end.ok,
        ms: end.ms,
        ...(end.bytes === undefined ? {} : { bytes: end.bytes }),
        signalled:
          Boolean(end.signal && end.signal.kind !== "hold") || derived !== null,
      },
      now,
    )

    if (end.signal?.kind === "refuse") {
      const cooling = await this.#cooldown.refuse(end.signal)
      this.#slowdown.signal(tidyReason(end.signal.reason), now)
      return cooling ? { kind: "cooling", cooling } : null
    }

    return this.#settle(end.signal ?? null, derived, end.ok, now)
  }

  /** Runs one call to the place, within its limits. */
  async run<T>(
    call: (context: RunContext) => Promise<T>,
    options: RunOptions<T> = {},
  ): Promise<RunResult<T>> {
    const tool = options.tool ?? ""
    const now = Date.now()
    const cooling = this.#cooldown.at(now)

    if (cooling) {
      return this.#refused("cooling", cooling.reason, cooling.until - now)
    }

    if (this.#cooldown.probing) {
      return this.#refused(
        "probing",
        "a call is checking whether it takes calls again",
        this.usualMs(tool),
      )
    }

    const limits = this.limits(tool, now)

    if (limits.bytesPerDay !== null) {
      const bytes = this.#counters.bytesToday(now)

      if (bytes >= limits.bytesPerDay) {
        return this.#refused(
          "bytes",
          `it has answered ${bytes} bytes today, its limit for a day`,
          this.#counters.bytesFreeIn(limits.bytesPerDay, now),
        )
      }
    }

    if (this.#waiting >= (this.#options.maxWaiting ?? DEFAULT_MAX_WAITING)) {
      return this.#refused(
        "full",
        "too many calls are already waiting for it",
        this.usualMs(tool),
      )
    }

    const waitMs = Math.max(
      0,
      options.waitMs ?? this.#options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    )
    const waitEnd = now + waitMs
    this.#waiting++
    let waiting = true
    const stopWaiting = () => {
      if (waiting) {
        waiting = false
        this.#waiting--
      }
    }

    try {
      // A rate limit with nothing left: its reset, within this call's wait.
      if (this.#holdUntil > now) {
        if (this.#holdUntil > waitEnd) {
          return this.#refused(
            "held",
            "its rate limit has no calls left until it resets",
            this.#holdUntil - now,
          )
        }
        await sleep(this.#holdUntil - now, options.signal)
      }

      // Calls a minute: a start in p-queue's sliding window.
      const rate = this.#rate
      if (rate) {
        const turn = waitSignal(waitEnd - Date.now(), options.signal)
        try {
          await rate.add(() => undefined, { signal: turn.signal })
        } catch (error) {
          if (!turn.timedOut()) throw error
          return this.#refused(
            "busy",
            `it takes ${limits.callsPerMinute} calls a minute, and this call could not wait for the next`,
            Math.max(1_000, 60_000 / Math.max(1, limits.callsPerMinute ?? 1)),
          )
        } finally {
          turn.done()
        }
      }

      // Spacing: a start time reserved at least minIntervalMs after the last.
      const at = Math.max(Date.now(), this.#nextStart)
      if (at > waitEnd) {
        return this.#refused(
          "busy",
          "its calls are spaced out, and this call could not wait for its turn",
          at - Date.now(),
        )
      }
      this.#nextStart = at + limits.minIntervalMs
      await sleep(at - Date.now(), options.signal)

      return await this.#take(call, options, tool, limits, waitEnd, stopWaiting)
    } finally {
      stopWaiting()
    }
  }

  /** Waits for a turn at once (p-queue), then runs the call in it. */
  async #take<T>(
    call: (context: RunContext) => Promise<T>,
    options: RunOptions<T>,
    tool: string,
    limits: Limits,
    waitEnd: number,
    stopWaiting: () => void,
  ): Promise<RunResult<T>> {
    const answer = deferred<RunResult<T>>()
    const turn = waitSignal(waitEnd - Date.now(), options.signal)
    this.#slots.concurrency = limits.maxConcurrent

    const task = this.#slots.add(
      async () => {
        // Started: the wait's signal must not free the turn from here on.
        turn.done()
        stopWaiting()
        const cooling = this.#cooldown.at(Date.now())

        if (cooling) {
          answer.resolve(
            this.#refused(
              "cooling",
              cooling.reason,
              cooling.until - Date.now(),
            ),
          )
          return
        }

        // One call probes a place after its cool-down; the others are
        // turned away rather than held waiting for its verdict.
        if (this.#cooldown.probing) {
          answer.resolve(
            this.#refused(
              "probing",
              "a call is checking whether it takes calls again",
              this.usualMs(tool),
            ),
          )
          return
        }

        await this.#execute(call, options, tool, limits, answer)
      },
      { signal: turn.signal, priority: options.priority ?? 0 },
    )

    task.catch((error: unknown) => {
      turn.done()

      if (turn.timedOut()) {
        answer.resolve(
          this.#refused(
            "busy",
            `it is already answering ${limits.maxConcurrent} call${limits.maxConcurrent === 1 ? "" : "s"}, as many as it takes at once, for longer than this call could wait`,
            this.usualMs(tool),
          ),
        )
      } else {
        answer.reject(error)
      }
    })

    return answer.promise
  }

  /** Runs a call holding a turn: timed, read for signals, counted. */
  async #execute<T>(
    call: (context: RunContext) => Promise<T>,
    options: RunOptions<T>,
    tool: string,
    limits: Limits,
    answer: ReturnType<typeof deferred<RunResult<T>>>,
  ): Promise<void> {
    const started = Date.now()
    const detect = this.#options.detect ?? "latency"
    const classify =
      options.classify ??
      ((outcome: Outcome<T>) =>
        signalOf("value" in outcome ? outcome.value : outcome.error))
    const context: RunContext = {
      signal: options.signal ?? new AbortController().signal,
      timeoutMs: limits.timeoutMs,
    }
    this.#running++

    let lingerTimer: ReturnType<typeof setTimeout> | undefined
    const lingered = deferred<void>()
    const timer = setTimeout(() => {
      // Past its time limit: the caller hears now, the turn stays taken.
      const derived = this.#latency.record(
        { tool, ms: limits.timeoutMs, ok: false, timedOut: true },
        detect,
      )
      this.#counters.record(
        { ok: false, ms: limits.timeoutMs, signalled: derived !== null },
        Date.now(),
      )
      if (derived) this.#slowdown.signal(derived, Date.now())
      answer.resolve({ kind: "timeout", timeoutMs: limits.timeoutMs })
      lingerTimer = setTimeout(
        () => lingered.resolve(),
        this.#options.lingerMs ?? DEFAULT_LINGER_MS,
      )
      unref(lingerTimer)
    }, limits.timeoutMs)
    unref(timer)

    const ended = this.#cooldown
      .run(async () => {
        let outcome: Outcome<T>
        try {
          outcome = { value: await call(context) }
        } catch (error) {
          outcome = { error }
        }
        const signal = classify(outcome)
        return { outcome: { outcome, signal }, signal }
      })
      .then((ran) => {
        clearTimeout(timer)
        const late = answer.settled()
        const now = Date.now()

        if (ran.kind === "blocked") {
          // Opened, or a probe went first, while this one waited: nothing ran.
          const cooling = this.#cooldown.at(now)
          answer.resolve(
            this.#refused(
              cooling ? "cooling" : "probing",
              cooling?.reason ??
                "a call is checking whether it takes calls again",
              cooling ? cooling.until - now : this.usualMs(tool),
            ),
          )
          return
        }

        const { outcome, signal } = ran.outcome
        const ms = now - started
        const ok =
          "value" in outcome ? (options.isOk?.(outcome.value) ?? true) : false
        const bytes =
          "value" in outcome && options.bytes ? options.bytes(outcome.value) : 0
        let effect: Effect | null = null

        if (late) {
          if (signal && signal.kind !== "hold") this.#counters.recordSignal(now)
        } else {
          const derived = this.#latency.record(
            { tool, ms, ok, timedOut: false },
            detect,
          )
          this.#counters.record(
            {
              ok,
              ms,
              bytes,
              signalled:
                Boolean(signal && signal.kind !== "hold") || derived !== null,
            },
            now,
          )

          if (ran.kind !== "refused") {
            // A slow answer short of a run neither slows nor eases it.
            effect = this.#settle(
              signal,
              derived,
              ok && !this.#latency.isSlow(tool),
              now,
            )
          }
        }

        if (ran.kind === "refused") {
          this.#slowdown.signal(tidyReason(ran.cooling.reason), now)
          effect = { kind: "cooling", cooling: ran.cooling }
        } else if (late && signal) {
          this.#settle(signal, null, ok, now)
        }

        answer.resolve(
          "value" in outcome
            ? { kind: "ok", value: outcome.value, ms, effect }
            : { kind: "error", error: outcome.error, ms, effect },
        )
      })
      .catch((error: unknown) => {
        clearTimeout(timer)
        answer.reject(error)
      })

    try {
      await Promise.race([ended, lingered.promise])
    } finally {
      clearTimeout(lingerTimer)
      this.#running--
    }
  }

  /** A call's signal other than a refusal, and slowness: hold, slow down, or ease. */
  #settle(
    signal: Signal | null,
    derived: string | null,
    ok: boolean,
    now: number,
  ): Effect | null {
    if (signal?.kind === "hold") {
      const wait = Math.min(signal.retryAfterMs, this.#limits.backoffMaxMs)
      this.#holdUntil = Math.max(this.#holdUntil, now + wait)
      return null
    }

    const reason =
      signal?.kind === "slow" || signal?.kind === "refuse"
        ? tidyReason(signal.reason)
        : derived

    if (reason) {
      return this.#slowdown.signal(reason, now)
        ? {
            kind: "slowing",
            slowing: this.#slowdown.at(now)!,
            limits: this.limits("", now),
          }
        : null
    }

    if (ok) {
      this.#slowdown.clean()
    }

    return null
  }

  #refused(
    why: RefusedWhy,
    reason: string,
    retryAfterMs: number,
  ): Extract<RunResult<never>, { kind: "refused" }> {
    return {
      kind: "refused",
      why,
      reason,
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
    }
  }
}
