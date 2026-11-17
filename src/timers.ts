/** Timers that never keep a process alive on their own. */

export function unref(timer: ReturnType<typeof setTimeout>): void {
  ;(timer as { unref?: () => void }).unref?.()
}

/** Waits `ms`, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    if (ms <= 0) {
      resolve()
      return
    }

    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    unref(timer)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * An AbortController that aborts after `ms` (a TimeoutError, as
 * AbortSignal.timeout's) or when `parent` does; `done` stops both, so a
 * signal used only while waiting never aborts what came after.
 */
export function waitSignal(
  ms: number,
  parent?: AbortSignal,
): { signal: AbortSignal; done: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(
    () => {
      timedOut = true
      controller.abort(new DOMException("The wait ran out.", "TimeoutError"))
    },
    Math.max(0, ms),
  )
  unref(timer)
  const onAbort = () => controller.abort(parent!.reason)

  if (parent?.aborted) {
    controller.abort(parent.reason)
  } else {
    parent?.addEventListener("abort", onAbort, { once: true })
  }

  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      parent?.removeEventListener("abort", onAbort)
    },
    timedOut: () => timedOut,
  }
}

export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  settled: () => boolean
}

export function deferred<T>(): Deferred<T> {
  let settled = false
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = (value) => {
      if (!settled) {
        settled = true
        yes(value)
      }
    }
    reject = (reason) => {
      if (!settled) {
        settled = true
        no(reason)
      }
    }
  })

  return { promise, resolve, reject, settled: () => settled }
}
