/**
 * How long a place's calls take, per tool (or per kind of call): its usual
 * time, whether it has turned slow, and the time limit its answers suggest.
 *
 * - Usual time: the median of its latest successes (robust to the odd slow
 *   one).
 * - Slow: a run of answers each far slower than the usual time, or a run of
 *   calls past their time limit, whatever the tool. Fast and slow tools of
 *   one place never mix: each has its own usual time.
 * - Learned time limit: TCP's retransmission timeout (RFC 6298): a smoothed
 *   time and its variation, the limit the smoothed time plus four times the
 *   variation, so a tool that is always slow but always answers is given the
 *   time it needs, and one that answers fast is not waited on for minutes.
 */

export type LatencyOptions = {
  /** A slow answer takes at least this many times the usual time… */
  slowFactor: number
  /** …and at least this long. */
  slowFloorMs: number
  /** This many slow answers (or calls past the limit) in a row is "slow". */
  slowRun: number
  /** The successes the usual time is the median of. */
  baselineSamples: number
  /** Fewer successes than this: no usual time yet. */
  baselineMin: number
  /** Tools tracked per place; the least recently used is dropped. */
  maxTools: number
}

export const LATENCY_DEFAULTS: LatencyOptions = {
  slowFactor: 5,
  slowFloorMs: 10_000,
  slowRun: 3,
  baselineSamples: 20,
  baselineMin: 5,
  maxTools: 100,
}

/**
 * What counts as the place slowing down: "latency" (a tool's answers far
 * slower than its usual, or calls past their time limit), "timeouts" (only
 * calls past their time limit: a command or a transfer takes as long as its
 * work does), or "none" (only the place's own signals count).
 */
export type SlowDetection = "latency" | "timeouts" | "none"

type ToolTimes = {
  recent: number[]
  slow: number
  /** RFC 6298's smoothed time and variation; null before the first. */
  srtt: number | null
  rttvar: number
  samples: number
}

export type LatencyEnd = {
  tool: string
  ms: number
  ok: boolean
  timedOut: boolean
}

export class Latency {
  #tools = new Map<string, ToolTimes>()
  #timeouts = 0

  constructor(private readonly options: LatencyOptions = LATENCY_DEFAULTS) {}

  /** A tool's usual time, or null before enough successes. */
  usualMs(tool: string): number | null {
    const times = this.#tools.get(tool)
    return times ? this.#usual(times) : null
  }

  /**
   * The time limit a tool's answers suggest (RFC 6298, G = 1 s), or null
   * before `minSamples` successes.
   */
  learnedTimeoutMs(tool: string, minSamples = this.options.baselineMin) {
    const times = this.#tools.get(tool)

    if (!times || times.srtt === null || times.samples < minSamples) {
      return null
    }

    return Math.round(times.srtt + Math.max(1_000, 4 * times.rttvar))
  }

  /**
   * Counts a call's end. Answers the reason when this call made a run of
   * slow ones (and starts the run again), else null.
   */
  record(end: LatencyEnd, detect: SlowDetection): string | null {
    const times = this.#times(end.tool)
    const base = this.#usual(times)
    const slowAnswer =
      detect === "latency" &&
      !end.timedOut &&
      base !== null &&
      end.ms >=
        Math.max(this.options.slowFloorMs, base * this.options.slowFactor)

    times.slow = slowAnswer ? times.slow + 1 : 0
    this.#timeouts = detect !== "none" && end.timedOut ? this.#timeouts + 1 : 0

    if (end.ok && !end.timedOut) {
      times.recent.push(end.ms)
      if (times.recent.length > this.options.baselineSamples)
        times.recent.shift()
      this.#smooth(times, end.ms)
    }

    if (this.#timeouts >= this.options.slowRun) {
      const count = this.#timeouts
      this.#timeouts = 0
      return `${count} calls in a row ran past their time limit`
    }

    if (times.slow >= this.options.slowRun) {
      const count = times.slow
      times.slow = 0
      return `its answers${end.tool ? ` to ${end.tool}` : ""} are taking much longer than usual (${count} in a row, about ${Math.round(end.ms / 1000)} s each against ${Math.max(1, Math.round(base! / 1000))} s)`
    }

    return null
  }

  /** Whether the latest answer counted as slow for its tool. */
  isSlow(tool: string): boolean {
    return (this.#tools.get(tool)?.slow ?? 0) > 0
  }

  /** Forgets the runs of slow answers and calls past their limit. */
  resetRuns(): void {
    this.#timeouts = 0
    for (const times of this.#tools.values()) times.slow = 0
  }

  #usual(times: ToolTimes): number | null {
    if (times.recent.length < this.options.baselineMin) return null
    const sorted = [...times.recent].sort((a, b) => a - b)
    return sorted[Math.floor((sorted.length - 1) / 2)]!
  }

  /** RFC 6298 2.2 and 2.3: alpha 1/8, beta 1/4. */
  #smooth(times: ToolTimes, ms: number): void {
    if (times.srtt === null) {
      times.srtt = ms
      times.rttvar = ms / 2
    } else {
      times.rttvar = 0.75 * times.rttvar + 0.25 * Math.abs(times.srtt - ms)
      times.srtt = 0.875 * times.srtt + 0.125 * ms
    }
    times.samples++
  }

  #times(tool: string): ToolTimes {
    let times = this.#tools.get(tool)

    if (times) {
      this.#tools.delete(tool)
    } else {
      times = { recent: [], slow: 0, srtt: null, rttvar: 0, samples: 0 }

      if (this.#tools.size >= this.options.maxTools) {
        const oldest = this.#tools.keys().next().value
        if (oldest !== undefined) this.#tools.delete(oldest)
      }
    }

    this.#tools.set(tool, times)
    return times
  }
}
