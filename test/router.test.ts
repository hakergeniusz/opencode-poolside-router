/**
 * Port of the original pi-poolside-router smoke.ts to the pure OpenCode router
 * core. No pi runtime or OpenCode SDK imports.
 *
 * Run with: npm test  (node --experimental-strip-types)
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  PoolsideRouter,
  discoverKeys,
  normalize,
  type KeyEntry,
} from "../src/router.ts"

const keys: KeyEntry[] = [
  ...Array.from({ length: 9 }, (_, i) => ({ label: `poolside-key${i + 1}`, apiKey: `k${i + 1}` })),
  { label: "poolside-work", apiKey: "work" },
  { label: "poolside", apiKey: "plain" },
]

test("discoverKeys orders numbered, renamed, then plain", () => {
  const found = discoverKeys({
    POOLSIDE_API_KEY: "plain",
    POOLSIDE_API_KEY_2: "k2",
    POOLSIDE_API_KEY_1: "k1",
    POOLSIDE_API_KEY_WORK: "work",
    POOLSIDE_API_KEY_ZZZ: "zzz",
    IGNORED: "nope",
  })
  assert.deepEqual(
    found.map((k) => k.label),
    ["poolside-key1", "poolside-key2", "poolside-work", "poolside-zzz", "poolside"],
  )
})

test("first request picks key1; retry advances keys while the model holds", () => {
  const router = new PoolsideRouter(keys)
  const first = router.route("laguna-s", "s1", "primary")
  assert.equal(first.modelID, "laguna-s-2.1")
  assert.equal(first.keyIndex, 0)

  // Success holds the pair: routing again without a failure does not move.
  const held = router.route("laguna-s", "s1", "primary")
  assert.equal(held.keyIndex, 0)

  const failed = router.onFailure("laguna-s", "s1")
  assert.equal(failed.keyChanged, true)
  const second = router.route("laguna-s", "s1", "primary")
  assert.equal(second.modelID, "laguna-s-2.1")
  assert.equal(second.keyIndex, 1)
})

test("rename labels join the rotation after numbered keys, then wrap", () => {
  const router = new PoolsideRouter(keys)
  router.route("laguna-s", "s1", "primary")
  let index = 0
  for (let i = 0; i < 9; i++) {
    router.onFailure("laguna-s", "s1")
    index = router.route("laguna-s", "s1", "primary").keyIndex
  }
  assert.equal(index, 9, "renamed label poolside-work")
  router.onFailure("laguna-s", "s1")
  assert.equal(router.route("laguna-s", "s1", "primary").keyIndex, 10, "plain poolside last")
  router.onFailure("laguna-s", "s1")
  assert.equal(router.route("laguna-s", "s1", "primary").keyIndex, 0, "wraps to key1")
})

test("laguna-xs has an independent position", () => {
  const router = new PoolsideRouter(keys)
  assert.equal(router.route("laguna-xs", "s1", "primary").keyIndex, 0)
  assert.equal(router.route("laguna-s", "s1", "primary").keyIndex, 0)
  for (let i = 0; i < 3; i++) router.onFailure("laguna-s", "s1")
  assert.equal(router.route("laguna-s", "s1", "primary").keyIndex, 3)
  assert.equal(router.route("laguna-xs", "s1", "primary").keyIndex, 0)
})

test("direct requests use the last-good hint and store no state", () => {
  const router = new PoolsideRouter(keys)
  router.route("laguna-s", "s1", "primary")
  for (let i = 0; i < 4; i++) router.onFailure("laguna-s", "s1")
  assert.equal(router.route("laguna-s", "s1", "primary").keyIndex, 4)

  const direct = router.route("laguna-s", "s2", "compaction")
  assert.equal(direct.keyIndex, 4, "direct reuses the last good key")
  // The direct route did not move the primary position.
  assert.equal(router.route("laguna-s", "s1", "primary").keyIndex, 4)
})

test("reset is per-ladder and restarts at the head", () => {
  const router = new PoolsideRouter(keys)
  for (let i = 0; i < 5; i++) router.onFailure("laguna-s", "s1")
  assert.equal(router.route("laguna-s", "s1", "primary").keyIndex, 5)

  router.reset(["laguna-s"])
  assert.equal(router.epochOf("laguna-s"), 1)
  assert.equal(router.epochOf("laguna-xs"), 0)
  assert.equal(router.route("laguna-s", "s1", "primary").keyIndex, 0)
})

test("no discovered keys falls back to a single provider entry", () => {
  const router = new PoolsideRouter([])
  assert.equal(router.keyCount(), 1)
  assert.equal(router.keyAt(0), undefined)
  assert.equal(router.route("laguna-s", "s1", "primary").keyIndex, 0)
})

test("state normalization never produces NaN", () => {
  assert.equal(normalize(57, 10), 7)
  assert.equal(normalize(-3, 10), 7)
  assert.equal(normalize(Number.NaN, 10), 0)
  assert.equal(normalize(99, 1), 0)
})

test("forgetSession clears per-session position", () => {
  const router = new PoolsideRouter(keys)
  router.onFailure("laguna-s", "s1")
  assert.equal(router.route("laguna-s", "s1", "primary").keyIndex, 1)
  router.forgetSession("s1")
  assert.equal(router.currentKeyIndex("s1", "laguna-s"), 1, "falls back to lastGood hint")
})
