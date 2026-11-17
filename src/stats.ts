/**
 * A place's counters, in memory: calls, errors, signals, bytes and a sample
 * of answer times, by the minute for the last hour and by the hour for the
 * rest of the day, so the 50th and 95th percentile can be read over a minute,
 * an hour and a day at a bounded cost.
 */

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Answer times kept per minute; more are sampled evenly. */
export const SAMPLES_PER_MINUTE = 16
/** Answer times kept per hour once its minutes are merged. */
export const SAMPLES_PER_HOUR = 32

type Bucket = {
  /** Its start: a whole minute, or a whole hour once merged. */
  at: number
  span: number
  calls: number
  errors: number
  signals: number
  bytes: number
  /** A sample of answer times, each standing for `weight` calls. */
  ms: number[]
  weight: number
}

export type WindowCounts = {
  calls: number
  errors: number
  /** Refusals and slow-downs the place signalled. */
  signals: number
  bytes: number
  p50Ms: number | null
  p95Ms: number | null
}

export type CallRecord = {
  ok: boolean
  ms: number
  bytes?: number
  signalled?: boolean
}

export class Counters {
  #buckets: Bucket[] = []
  readonly since: number

  constructor(
    now: number,
    private readonly random: () => number = Math.random,
  ) {
    this.since = now
  }

  record(call: CallRecord, now: number): void {
    const bucket = this.#bucketFor(now)
    bucket.calls++
    if (!call.ok) bucket.errors++
    if (call.signalled) bucket.signals++
    if (call.bytes) bucket.bytes += call.bytes
    this.#sample(bucket, call.ms)
  }

  /** A signal that came on its own, after its call was counted. */
  recordSignal(now: number): void {
    this.#bucketFor(now).signals++
  }

  /** Bytes answered over the last day. */
  bytesToday(now: number): number {
    return this.#buckets
      .filter((bucket) => bucket.at + bucket.span > now - DAY)
      .reduce((sum, bucket) => sum + bucket.bytes, 0)
  }

  /**
   * How long until the bytes counted over the last day come down under
   * `limit`, as the oldest leave the day.
   */
  bytesFreeIn(limit: number, now: number): number {
    let total = this.bytesToday(now)

    for (const bucket of this.#buckets) {
      if (bucket.at + bucket.span <= now - DAY || bucket.bytes === 0) {
        continue
      }

      total -= bucket.bytes

      if (total < limit) {
        return Math.max(1_000, bucket.at + bucket.span + DAY - now)
      }
    }

    return DAY
  }

  /** This minute and the one before, the last hour and the last day. */
  windows(now: number): {
    minute: WindowCounts
    hour: WindowCounts
    day: WindowCounts
  } {
    this.#tidy(now)

    return {
      minute: this.#counts(now - (now % MINUTE) - MINUTE),
      hour: this.#counts(now - HOUR),
      day: this.#counts(now - DAY),
    }
  }

  #bucketFor(now: number): Bucket {
    const at = now - (now % MINUTE)
    const last = this.#buckets.at(-1)

    if (last && last.at === at && last.span === MINUTE) {
      return last
    }

    const bucket: Bucket = {
      at,
      span: MINUTE,
      calls: 0,
      errors: 0,
      signals: 0,
      bytes: 0,
      ms: [],
      weight: 1,
    }
    this.#buckets.push(bucket)
    this.#tidy(now)
    return bucket
  }

  /** Keeps one answer time, each call of the bucket as likely to be kept. */
  #sample(bucket: Bucket, ms: number): void {
    if (bucket.ms.length < SAMPLES_PER_MINUTE) {
      bucket.ms.push(ms)
      return
    }

    const slot = Math.floor(this.random() * bucket.calls)

    if (slot < SAMPLES_PER_MINUTE) {
      bucket.ms[slot] = ms
    }

    bucket.weight = bucket.calls / bucket.ms.length
  }

  /** Drops what is past a day and merges minutes past the last hour. */
  #tidy(now: number): void {
    const dayAgo = now - DAY
    const hourStart = now - (now % HOUR) - HOUR
    const kept: Bucket[] = []
    let pending: Bucket[] = []
    let pendingHour = -1

    const flush = () => {
      if (pending.length > 0) {
        kept.push(this.#merge(pending, pendingHour))
        pending = []
      }
    }

    for (const bucket of this.#buckets) {
      if (bucket.at + bucket.span <= dayAgo) {
        continue
      }

      if (bucket.span === MINUTE && bucket.at < hourStart) {
        const hour = bucket.at - (bucket.at % HOUR)
        if (hour !== pendingHour) flush()
        pendingHour = hour
        pending.push(bucket)
        continue
      }

      flush()
      kept.push(bucket)
    }

    flush()
    this.#buckets = kept
  }

  /** Minutes merged into an hour: counts added, times drawn by weight. */
  #merge(minutes: Bucket[], at: number): Bucket {
    // Weighted sampling without replacement (Efraimidis–Spirakis).
    const keyed = minutes.flatMap((bucket) =>
      bucket.ms.map((ms) => ({
        ms,
        key: this.random() ** (1 / Math.max(bucket.weight, 1)),
      })),
    )
    keyed.sort((a, b) => b.key - a.key)
    const calls = minutes.reduce((sum, bucket) => sum + bucket.calls, 0)
    const kept = keyed.slice(0, SAMPLES_PER_HOUR).map((entry) => entry.ms)

    return {
      at,
      span: HOUR,
      calls,
      errors: minutes.reduce((sum, bucket) => sum + bucket.errors, 0),
      signals: minutes.reduce((sum, bucket) => sum + bucket.signals, 0),
      bytes: minutes.reduce((sum, bucket) => sum + bucket.bytes, 0),
      ms: kept,
      weight: kept.length > 0 ? calls / kept.length : 1,
    }
  }

  #counts(from: number): WindowCounts {
    const inside = this.#buckets.filter((bucket) => bucket.at >= from)
    const samples = inside.flatMap((bucket) =>
      bucket.ms.map((ms) => ({ ms, weight: bucket.weight })),
    )

    return {
      calls: inside.reduce((sum, bucket) => sum + bucket.calls, 0),
      errors: inside.reduce((sum, bucket) => sum + bucket.errors, 0),
      signals: inside.reduce((sum, bucket) => sum + bucket.signals, 0),
      bytes: inside.reduce((sum, bucket) => sum + bucket.bytes, 0),
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
    }
  }
}

/** A weighted percentile of sampled times. */
export function percentile(
  samples: Array<{ ms: number; weight: number }>,
  p: number,
): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a.ms - b.ms)
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0)
  const target = (p / 100) * total
  let seen = 0

  for (const entry of sorted) {
    seen += entry.weight
    if (seen >= target) return entry.ms
  }

  return sorted.at(-1)!.ms
}
