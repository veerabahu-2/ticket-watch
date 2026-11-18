// Merges two state.json files: knownTheatres is a union, so a theatre that
// either writer already notified is not notified again, unless a writer
// removed it after District stopped listing it (see src/state.js).
// Usage: node scripts/merge-state.mjs <ours> <theirs> > merged.json
import { readFileSync } from "node:fs";

import { mergeDistrictState } from "../src/state.js";

const read = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
};

const ours = read(process.argv[2]);
const theirs = read(process.argv[3]);
const merged = { ...theirs };

for (const [id, movie] of Object.entries(ours)) {
  const a = movie.district || {};
  const b = theirs[id]?.district || {};
  merged[id] = {
    ...theirs[id],
    ...movie,
    district: mergeDistrictState(a, b),
  };
}

process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
