import { Place, type PlaceOptions } from "./place.js"

/**
 * The places a process calls, each with its own limits and state, kept in
 * memory and bounded: past `maxPlaces` the least recently used one that is
 * idle (nothing running or waiting, not cooling down, going slower or held)
 * is dropped, which only gives it a fresh start. A place that is busy or
 * held is never dropped, so the bound is passed only while more are.
 */
export type BackoffOptions = {
  maxPlaces?: number
}

export class Backoff {
  #places = new Map<string, Place>()
  readonly #maxPlaces: number

  constructor(options: BackoffOptions = {}) {
    this.#maxPlaces = options.maxPlaces ?? 1_000
  }

  /**
   * The place for a key, made with `options` the first time and updated
   * with them after (limits, label), so a caller always passes what it
   * knows now.
   */
  place(key: string, options: PlaceOptions): Place {
    const found = this.#places.get(key)

    if (found) {
      this.#places.delete(key)
      this.#places.set(key, found)
      found.configure(options)
      return found
    }

    if (this.#places.size >= this.#maxPlaces) {
      const now = Date.now()
      for (const [old, place] of this.#places) {
        if (place.idle(now)) {
          this.#places.delete(old)
          break
        }
      }
    }

    const place = new Place(key, options)
    this.#places.set(key, place)
    return place
  }

  /** The place for a key if there is one, without making it. */
  peek(key: string): Place | undefined {
    return this.#places.get(key)
  }

  get size(): number {
    return this.#places.size
  }

  /** Forgets every place (tests, a reset). */
  clear(): void {
    this.#places.clear()
  }
}

/** One registry for the whole process, however many copies load this module. */
export function sharedBackoff(
  name = "default",
  options: BackoffOptions = {},
): Backoff {
  const key = Symbol.for(`kaperkunde.backoff.${name}`)
  const holder = globalThis as unknown as Record<symbol, Backoff | undefined>
  holder[key] ??= new Backoff(options)
  return holder[key]
}
