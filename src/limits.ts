/**
 * A place's limits: how many calls at once, how far apart, how many a
 * minute, how long one may take, how many bytes a day may come back, and how
 * long it cools down after it refuses a call.
 */
export type Limits = {
  /** Calls running at once; more wait their turn, within their own time. */
  maxConcurrent: number
  /** The least time between one call's start and the next one's. */
  minIntervalMs: number
  /** At most this many calls start in any minute (a sliding window); null: no cap. */
  callsPerMinute: number | null
  /** How long a call is waited for before its caller hears `timeout`. */
  timeoutMs: number
  /** At most this many bytes of answers in a day; null: no cap. */
  bytesPerDay: number | null
  /** The first cool-down after a refusal that does not say how long. */
  backoffBaseMs: number
  /** The longest cool-down, also for a place's own Retry-After. */
  backoffMaxMs: number
}

export const DEFAULT_LIMITS: Limits = {
  maxConcurrent: 8,
  minIntervalMs: 0,
  callsPerMinute: null,
  timeoutMs: 60_000,
  bytesPerDay: null,
  backoffBaseMs: 30_000,
  backoffMaxMs: 15 * 60_000,
}

/** A field's bounds, for checking limits an operator or an agent proposes. */
export type LimitBounds = { [K in keyof Limits]: { min: number; max: number } }

export const LIMIT_BOUNDS: LimitBounds = {
  maxConcurrent: { min: 1, max: 1_024 },
  minIntervalMs: { min: 0, max: 60 * 60_000 },
  callsPerMinute: { min: 1, max: 1_000_000 },
  timeoutMs: { min: 1, max: 24 * 60 * 60_000 },
  bytesPerDay: { min: 1, max: Number.MAX_SAFE_INTEGER },
  backoffBaseMs: { min: 1, max: 24 * 60 * 60_000 },
  backoffMaxMs: { min: 1, max: 7 * 24 * 60 * 60_000 },
}

/** Throws a RangeError naming the first field outside its bounds. */
export function checkLimits(
  limits: Limits,
  bounds: LimitBounds = LIMIT_BOUNDS,
): Limits {
  for (const key of Object.keys(bounds) as Array<keyof Limits>) {
    const value = limits[key]

    if (value === null && (key === "callsPerMinute" || key === "bytesPerDay")) {
      continue
    }

    const { min, max } = bounds[key]

    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    ) {
      throw new RangeError(`${key} must be a number from ${min} to ${max}.`)
    }
  }

  if (limits.backoffBaseMs > limits.backoffMaxMs) {
    throw new RangeError("backoffBaseMs cannot be longer than backoffMaxMs.")
  }

  return limits
}
