import type { Limits } from "./limits.js"

/**
 * Going slower at a place's request (an answer it marked throttled) or as
 * its answers turn slow: an additive-increase/multiplicative-decrease
 * controller in the shape of the limits. Each signal steps the level up, to
 * `maxLevel`; `easeAfter` clean answers in a row step it down, and with no
 * signal for `memoryMs` it is over. At level n the place's calls go one at a
 * time, at least `spacingMs · 2^(n-1)` apart (to `maxSpacingMs`, never under
 * its own spacing), and each is waited for `timeoutFactor` times as long (one
 * factor at every level, so a connection pooled for the longer limit is not
 * opened again at each step).
 */
export type SlowdownOptions = {
  spacingMs: number
  maxSpacingMs: number
  timeoutFactor: number
  /** The longest time limit the factor may give. */
  maxTimeoutMs: number
  maxLevel: number
  easeAfter: number
  memoryMs: number
}

export const SLOWDOWN_DEFAULTS: SlowdownOptions = {
  spacingMs: 1_000,
  maxSpacingMs: 8_000,
  timeoutFactor: 3,
  maxTimeoutMs: 30 * 60_000,
  maxLevel: 4,
  easeAfter: 3,
  memoryMs: 30 * 60_000,
}

export type Slowing = {
  /** 1 to maxLevel. */
  level: number
  reason: string
  since: number
}

/** A place's limits while it goes slower at `level` (1 and up). */
export function slowedLimits(
  limits: Limits,
  level: number,
  options: SlowdownOptions = SLOWDOWN_DEFAULTS,
): Limits {
  const spacing = Math.min(
    options.maxSpacingMs,
    options.spacingMs * 2 ** Math.max(0, level - 1),
  )

  return {
    ...limits,
    maxConcurrent: 1,
    minIntervalMs: Math.max(limits.minIntervalMs, spacing),
    timeoutMs: Math.min(
      Math.max(options.maxTimeoutMs, limits.timeoutMs),
      Math.max(limits.timeoutMs, limits.timeoutMs * options.timeoutFactor),
    ),
  }
}

export class Slowdown {
  #state: (Slowing & { last: number; clean: number }) | null = null

  constructor(private readonly options: SlowdownOptions = SLOWDOWN_DEFAULTS) {}

  /** The slowdown now, or null; one past its memory is over. */
  at(now: number): Slowing | null {
    const state = this.#state

    if (!state) return null

    if (now - state.last >= this.options.memoryMs) {
      this.#state = null
      return null
    }

    return { level: state.level, reason: state.reason, since: state.since }
  }

  /** Steps it up (or starts it). Answers whether it just started. */
  signal(reason: string, now: number): boolean {
    const current = this.at(now) ? this.#state : null

    if (current) {
      current.level = Math.min(this.options.maxLevel, current.level + 1)
      current.reason = reason
      current.last = now
      current.clean = 0
      return false
    }

    this.#state = { level: 1, reason, since: now, last: now, clean: 0 }
    return true
  }

  /** A clean answer: `easeAfter` in a row step it down. */
  clean(): void {
    const current = this.#state

    if (!current) return

    current.clean++

    if (current.clean >= this.options.easeAfter) {
      current.level--
      current.clean = 0

      if (current.level <= 0) {
        this.#state = null
      }
    }
  }

  /** Back to normal now (an operator's choice). */
  reset(): void {
    this.#state = null
  }

  limits(limits: Limits, now: number): Limits {
    const slowing = this.at(now)
    return slowing ? slowedLimits(limits, slowing.level, this.options) : limits
  }
}
