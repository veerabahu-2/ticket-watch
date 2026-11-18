// Merges two state.json files: knownTheatres is a union, so a theatre that
// either writer already notified is never notified again.
// Usage: node scripts/merge-state.mjs <ours> <theirs> > merged.json
import { readFileSync } from "node:fs";

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
    district: {
      knownTheatres: [...new Set([...(b.knownTheatres || []), ...(a.knownTheatres || [])])],
      unknownStreak: Math.max(a.unknownStreak || 0, b.unknownStreak || 0),
      brokenAlertSent: Boolean(a.brokenAlertSent || b.brokenAlertSent),
    },
  };
}

process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
