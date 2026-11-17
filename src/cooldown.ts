import {
  BrokenCircuitError,
  CircuitBreakerPolicy,
  CircuitState,
  ConsecutiveBreaker,
  DelegateBackoff,
  IsolatedCircuitError,
  circuitBreaker,
  handleType,
  type IHalfOpenAfterBackoffContext,
} from "cockatiel"

import type { Limits } from "./limits.js"
import type { Signal } from "./signals.js"

/**
 * A place's cool-down: cockatiel's circuit breaker, opened only by a refusal
 * (never by a plain error, a slow answer or a "go slower"). It stays open for
 * as long as the place asked (its Retry-After, no longer than
 * `backoffMaxMs`), else for `backoffBaseMs` doubling each time a probe after
 * it is refused again, up to `backoffMaxMs`. Then it half-opens: one call
 * probes the place while the others are refused, and a probe that is not
 * refused closes it.
 */

export type Cooling = {
  reason: string
  since: number
  until: number
}

/** Thrown inside the breaker for a refusal, so it opens; unwrapped outside. */
export class Refused<T> extends Error {
  constructor(
    readonly outcome: T,
    readonly signal: Extract<Signal, { kind: "refuse" }>,
  ) {
    super(signal.reason)
    this.name = "Refused"
  }
}

export type CooldownRun<T> =
  | { kind: "ran"; outcome: T }
  | { kind: "refused"; outcome: T; cooling: Cooling }
  /** The breaker was open, or a probe already running: nothing ran. */
  | { kind: "blocked" }

export class Cooldown {
  #breaker: CircuitBreakerPolicy
  #cooling: Cooling | null = null
  #limits: () => Limits

  constructor(limits: () => Limits) {
    this.#limits = limits
    this.#breaker = this.#make()
  }

  /** The cool-down now, or null once it is over (a probe may go). */
  at(now: number): Cooling | null {
    if (this.#breaker.state === CircuitState.Isolated) {
      return this.#cooling ?? { reason: "held", since: now, until: Infinity }
    }

    return this.#cooling && this.#cooling.until > now ? this.#cooling : null
  }

  /** Whether a probe is running and the others wait for it. */
  get probing(): boolean {
    return this.#breaker.state === CircuitState.HalfOpen
  }

  /**
   * Runs `fn` through the breaker. `fn` answers an outcome and the place's
   * signal for it; a refusal opens the breaker, anything else counts as a
   * success.
   */
  async run<T>(
    fn: () => Promise<{ outcome: T; signal: Signal | null }>,
  ): Promise<CooldownRun<T>> {
    try {
      const outcome = await this.#breaker.execute(async () => {
        const { outcome, signal } = await fn()

        if (signal?.kind === "refuse") {
          throw new Refused(outcome, signal)
        }

        return outcome
      })

      return { kind: "ran", outcome }
    } catch (error) {
      if (error instanceof Refused) {
        return {
          kind: "refused",
          outcome: error.outcome as T,
          // Set by the back-off below when the breaker opened; a refusal
          // that came while it was open already keeps the one it has.
          cooling: this.#cooling ?? {
            reason: error.signal.reason,
            since: Date.now(),
            until: Date.now(),
          },
        }
      }

      if (
        error instanceof BrokenCircuitError ||
        error instanceof IsolatedCircuitError
      ) {
        return { kind: "blocked" }
      }

      throw error
    }
  }

  /**
   * A refusal that came after its caller stopped waiting, or from outside
   * a run (a site read some other way): opens the breaker as a refusal in a
   * run would.
   */
  async refuse(
    signal: Extract<Signal, { kind: "refuse" }>,
  ): Promise<Cooling | null> {
    const ran = await this.run(async () => ({ outcome: null, signal }))
    // Blocked: it is open already, or a probe is under way; that one decides.
    return ran.kind === "refused" ? ran.cooling : this.at(Date.now())
  }

  /** Ends a cool-down now: the next call goes as if none had happened. */
  reset(): void {
    this.#cooling = null
    this.#breaker = this.#make()
  }

  /** Holds the place shut until `dispose` (an operator's switch). */
  isolate(): { dispose: () => void } {
    return this.#breaker.isolate()
  }

  #make(): CircuitBreakerPolicy {
    const backoff = new DelegateBackoff<IHalfOpenAfterBackoffContext>(
      (context) => {
        const limits = this.#limits()
        const error = context.result as { error?: unknown }
        const refusal =
          error.error instanceof Refused ? error.error.signal : undefined
        const asked =
          refusal?.retryAfterMs === undefined
            ? undefined
            : Math.min(refusal.retryAfterMs, limits.backoffMaxMs)
        const doubled = Math.min(
          limits.backoffMaxMs,
          limits.backoffBaseMs * 2 ** Math.min(context.attempt - 1, 30),
        )
        const delay = asked ?? doubled
        const now = Date.now()

        this.#cooling = {
          reason: refusal?.reason ?? "it refused a call",
          since: now,
          until: now + delay,
        }

        return delay
      },
    )

    return circuitBreaker(handleType(Refused), {
      halfOpenAfter: backoff,
      breaker: new ConsecutiveBreaker(1),
    })
  }
}
