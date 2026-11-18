import assert from "node:assert/strict";
import test from "node:test";

import { mergeDistrictState, recordSeenTheatres } from "../src/state.js";

const t0 = new Date("2026-11-18T05:00:00.000Z");
const minutesLater = (minutes) => new Date(t0.getTime() + minutes * 60_000);
const ok = (keys, complete = true) => ({
  complete,
  theatres: keys.map((key) => ({ key, name: key })),
});

function district(knownTheatres, lastSeen = {}) {
  return { knownTheatres, unknownStreak: 0, brokenAlertSent: false, lastSeen, removed: {} };
}

test("keeps a theatre that is missing for less than the removal window", () => {
  const state = district(["cinema:1", "cinema:2"]);
  recordSeenTheatres(state, ok(["cinema:1", "cinema:2"]), t0, 5);

  assert.deepEqual(recordSeenTheatres(state, ok(["cinema:1"]), minutesLater(4), 5), []);
  assert.deepEqual(state.knownTheatres, ["cinema:1", "cinema:2"]);
});

test("removes a theatre missing for the removal window and tombstones it", () => {
  const state = district(["cinema:1", "cinema:2"]);
  recordSeenTheatres(state, ok(["cinema:1", "cinema:2"]), t0, 5);

  assert.deepEqual(recordSeenTheatres(state, ok(["cinema:1"]), minutesLater(5), 5), [
    "cinema:2",
  ]);
  assert.deepEqual(state.knownTheatres, ["cinema:1"]);
  assert.equal(state.removed["cinema:2"], minutesLater(5).toISOString());
});

test("never removes on a partial or empty check", () => {
  const state = district(["cinema:1", "cinema:2"]);
  recordSeenTheatres(state, ok(["cinema:1", "cinema:2"]), t0, 5);

  assert.deepEqual(recordSeenTheatres(state, ok(["cinema:1"], false), minutesLater(30), 5), []);
  assert.deepEqual(recordSeenTheatres(state, ok([]), minutesLater(30), 5), []);
  assert.deepEqual(state.knownTheatres, ["cinema:1", "cinema:2"]);
});

test("starts the removal timer for theatres known before lastSeen existed", () => {
  const state = { knownTheatres: ["cinema:1", "cinema:9"], unknownStreak: 0 };

  assert.deepEqual(recordSeenTheatres(state, ok(["cinema:1"]), t0, 5), []);
  assert.deepEqual(recordSeenTheatres(state, ok(["cinema:1"]), minutesLater(5), 5), [
    "cinema:9",
  ]);
});

test("a removed theatre that reappears clears its tombstone", () => {
  const state = district(["cinema:1"], { "cinema:1": t0.toISOString() });
  recordSeenTheatres(state, ok(["cinema:2"]), minutesLater(6), 5);
  assert.deepEqual(state.knownTheatres, []);

  recordSeenTheatres(state, ok(["cinema:1"]), minutesLater(10), 5);
  assert.equal(state.removed["cinema:1"], undefined);
});

test("merge drops a theatre whose removal is newer than its last sighting", () => {
  const removedBy = {
    ...district([], { "cinema:2": t0.toISOString() }),
    removed: { "cinema:2": minutesLater(6).toISOString() },
  };
  const stale = district(["cinema:2"], { "cinema:2": t0.toISOString() });

  assert.deepEqual(mergeDistrictState(removedBy, stale).knownTheatres, []);
  assert.deepEqual(mergeDistrictState(stale, removedBy).knownTheatres, []);
});

test("merge keeps a theatre seen again after its removal", () => {
  const removedBy = {
    ...district([], { "cinema:2": t0.toISOString() }),
    removed: { "cinema:2": minutesLater(6).toISOString() },
  };
  const seenAgain = district(["cinema:2"], { "cinema:2": minutesLater(8).toISOString() });
  const merged = mergeDistrictState(removedBy, seenAgain);

  assert.deepEqual(merged.knownTheatres, ["cinema:2"]);
  assert.deepEqual(merged.removed, {});
});

test("merge accepts state written before lastSeen and removed existed", () => {
  const merged = mergeDistrictState(
    { knownTheatres: ["cinema:1"], unknownStreak: 1, brokenAlertSent: false },
    { knownTheatres: ["cinema:2"], unknownStreak: 0, brokenAlertSent: true },
  );

  assert.deepEqual(merged, {
    knownTheatres: ["cinema:2", "cinema:1"],
    unknownStreak: 1,
    brokenAlertSent: true,
    lastSeen: {},
    removed: {},
  });
});
