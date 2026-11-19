/**
 * Pure routing core for opencode-poolside-router.
 *
 * No OpenCode or pi runtime imports — this module is safe to unit-test on its
 * own. `src/index.ts` wires it into the OpenCode V2 plugin APIs.
 */

export const PROVIDER = "poolside"
export const BASE_URL = "https://inference.poolside.ai/v1"
export const CONTEXT_WINDOW = 262144
export const MAX_TOKENS = 32768

export type AliasId = "laguna-s" | "laguna-xs"
export type RequestKind = "primary" | "compaction" | "title" | "generate"

/** Newest first. Single-model ladders: rotation is entirely by key. */
export const LADDERS: Record<AliasId, readonly string[]> = {
  "laguna-s": ["laguna-s-2.1"],
  "laguna-xs": ["laguna-xs-2.1"],
}

export const ALIASES: readonly AliasId[] = ["laguna-s", "laguna-xs"]

const ALIAS_TO_CONCRETE: Record<string, string> = {
  "laguna-s": LADDERS["laguna-s"][0],
  "laguna-xs": LADDERS["laguna-xs"][0],
}

const CONCRETE_TO_ALIAS: Record<string, AliasId> = {
  [LADDERS["laguna-s"][0]]: "laguna-s",
  [LADDERS["laguna-xs"][0]]: "laguna-xs",
}

export interface KeyEntry {
  /** Human-readable provider label, e.g. `poolside-key1` or `poolside-work`. */
  label: string
  apiKey: string
}

/** Mirrors the pi original's `{ m, k, epoch }` router state. */
export interface RouterState {
  /** Index into the ladder. Always 0 for these single-model ladders. */
  m: number
  /** Index into the discovered key list. */
  k: number
  /** Bumped by `reset`; a mismatch restarts the ladder. */
  epoch: number
}

/** Integer modulo, with a safe fallback for corrupt / NaN input. */
export function normalize(value: number, n: number): number {
  const size = Math.max(1, n)
  return Number.isInteger(value) ? ((value % size) + size) % size : 0
}

/**
 * Discover accounts in the same order the pi original discovered
 * `poolside-keyN` providers:
 *   1. numbered `POOLSIDE_API_KEY_1..N` (numeric order),
 *   2. renamed `POOLSIDE_API_KEY_<LABEL>` (lexical order),
 *   3. the plain `POOLSIDE_API_KEY` last, as the single-key fallback.
 */
export function discoverKeys(
  env: Record<string, string | undefined> =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
): KeyEntry[] {
  const numbered: Array<{ n: number; apiKey: string }> = []
  const renamed: Array<{ label: string; apiKey: string }> = []
  let plain: string | undefined

  for (const [name, value] of Object.entries(env)) {
    if (!value) continue
    if (name === "POOLSIDE_API_KEY") {
      plain = value
      continue
    }
    const numberedMatch = name.match(/^POOLSIDE_API_KEY_(\d+)$/)
    if (numberedMatch) {
      numbered.push({ n: Number(numberedMatch[1]), apiKey: value })
      continue
    }
    const renamedMatch = name.match(/^POOLSIDE_API_KEY_([A-Za-z][A-Za-z0-9_-]*)$/)
    if (renamedMatch) {
      renamed.push({ label: renamedMatch[1].toLowerCase(), apiKey: value })
    }
  }

  return [
    ...numbered
      .sort((a, b) => a.n - b.n)
      .map(({ n, apiKey }) => ({ label: `poolside-key${n}`, apiKey })),
    ...renamed
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(({ label, apiKey }) => ({ label: `poolside-${label}`, apiKey })),
    ...(plain ? [{ label: PROVIDER, apiKey: plain }] : []),
  ]
}

const stateKey = (alias: AliasId, sessionID: string) => `${alias}\u0000${sessionID}`

export interface RouteResult {
  /** Concrete model id to serve this request with. */
  modelID: string
  /** Index of the key whose credentials should be used. */
  keyIndex: number
}

/**
 * Holds the mutable router state. Epochs and `lastGood` are process-global per
 * alias (as in the pi original); the current position is tracked per session.
 */
export class PoolsideRouter {
  private keys: KeyEntry[]
  private readonly epochs = new Map<AliasId, number>()
  private readonly states = new Map<string, RouterState>()
  private readonly lastGood = new Map<AliasId, { m: number; k: number }>()
  private readonly sessionAlias = new Map<string, AliasId>()
  private readonly sessionKey = new Map<string, number>()

  constructor(keys: KeyEntry[]) {
    this.keys = keys.slice()
  }

  setKeys(keys: KeyEntry[]): void {
    this.keys = keys.slice()
  }

  keysSnapshot(): readonly KeyEntry[] {
    return this.keys.slice()
  }

  keyCount(): number {
    return Math.max(1, this.keys.length)
  }

  keyAt(index: number): KeyEntry | undefined {
    return this.keys[normalize(index, this.keyCount())]
  }

  epochOf(alias: AliasId): number {
    return this.epochs.get(alias) ?? 0
  }

  /** Which alias produced a request, from the selected/resolved model id. */
  aliasForModel(modelID: string, sessionID: string): AliasId | undefined {
    if (ALIAS_TO_CONCRETE[modelID]) return modelID as AliasId
    if (CONCRETE_TO_ALIAS[modelID]) return CONCRETE_TO_ALIAS[modelID]
    return this.sessionAlias.get(sessionID)
  }

  /** Key index the current request should use, without mutating state. */
  currentKeyIndex(sessionID: string, alias: AliasId): number {
    const current = this.sessionKey.get(sessionID)
    if (current !== undefined) return normalize(current, this.keyCount())
    const hint = this.lastGood.get(alias)
    return normalize(hint?.k ?? 0, this.keyCount())
  }

  /**
   * Pick the concrete model + key for one model resolution.
   *
   * `primary` uses the stored per-session position and writes it back.
   * Non-primary kinds are the pi original's `direct` requests: they use the
   * last-good hint and deliberately store no new state.
   */
  route(alias: AliasId, sessionID: string, kind: RequestKind): RouteResult {
    const ladder = LADDERS[alias]
    const keyCount = this.keyCount()
    const epoch = this.epochOf(alias)
    let m = 0
    let k = 0

    if (kind !== "primary") {
      const hint = this.lastGood.get(alias)
      m = normalize(hint?.m ?? 0, ladder.length)
      k = normalize(hint?.k ?? 0, keyCount)
    } else {
      const stored = this.states.get(stateKey(alias, sessionID))
      if (stored && stored.epoch === epoch) {
        m = normalize(stored.m, ladder.length)
        k = normalize(stored.k, keyCount)
      }
    }

    // Key index advances fastest, ladder index slowest. Under this plugin every
    // concrete model is present under the single provider, so the current
    // (model, key) pair is always available and needs no hole-skipping walk.
    const from = m * keyCount + k
    const total = Math.max(1, ladder.length * keyCount)
    const idx = ((from % total) + total) % total
    const chosenM = Math.floor(idx / keyCount) % ladder.length
    const chosenK = idx % keyCount

    this.sessionAlias.set(sessionID, alias)
    this.sessionKey.set(sessionID, chosenK)
    if (kind === "primary") {
      this.states.set(stateKey(alias, sessionID), { m: chosenM, k: chosenK, epoch })
      this.lastGood.set(alias, { m: chosenM, k: chosenK })
    }

    return { modelID: ladder[chosenM] ?? alias, keyIndex: chosenK }
  }

  /** Advance the (model, key) pair once after a failed attempt. */
  onFailure(
    alias: AliasId,
    sessionID: string,
  ): RouterState & { keyChanged: boolean } {
    const ladder = LADDERS[alias]
    const keyCount = this.keyCount()
    const epoch = this.epochOf(alias)
    const stored = this.states.get(stateKey(alias, sessionID))

    let m = stored && stored.epoch === epoch ? normalize(stored.m, ladder.length) : 0
    let k = stored && stored.epoch === epoch ? normalize(stored.k, keyCount) : 0
    const before = k

    const total = Math.max(1, ladder.length * keyCount)
    const next = (m * keyCount + k + 1) % total
    m = Math.floor(next / keyCount) % ladder.length
    k = next % keyCount

    const state: RouterState = { m, k, epoch }
    this.states.set(stateKey(alias, sessionID), state)
    this.sessionKey.set(sessionID, k)
    this.sessionAlias.set(sessionID, alias)
    this.lastGood.set(alias, { m, k })
    return { ...state, keyChanged: k !== before }
  }

  /** Bump epochs; stale positions restart at the ladder head. */
  reset(aliases: readonly AliasId[]): void {
    for (const alias of aliases) {
      this.epochs.set(alias, this.epochOf(alias) + 1)
      const prefix = `${alias}\u0000`
      for (const key of this.states.keys()) {
        if (key.startsWith(prefix)) this.states.delete(key)
      }
      this.lastGood.delete(alias)
    }
  }

  forgetSession(sessionID: string): void {
    this.sessionAlias.delete(sessionID)
    this.sessionKey.delete(sessionID)
    for (const key of this.states.keys()) {
      if (key.endsWith(`\u0000${sessionID}`)) this.states.delete(key)
    }
  }
}
