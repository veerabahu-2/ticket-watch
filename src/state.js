import { normalizeTheatreKey } from "./sources/district.js";

// A known theatre that has been missing from complete checks for this long is
// forgotten, so a real reopening alerts again. 0 removes it on the next
// complete check that does not list it.
export const DEFAULT_REMOVE_AFTER_MINUTES = 0;

function normalizeTimes(times = {}) {
  const result = {};

  for (const [key, at] of Object.entries(times)) {
    const normalized = normalizeTheatreKey(key);

    if (!result[normalized] || at > result[normalized]) {
      result[normalized] = at;
    }
  }

  return result;
}

function maxTimes(a, b) {
  const result = { ...a };

  for (const [key, at] of Object.entries(b)) {
    if (!result[key] || at > result[key]) {
      result[key] = at;
    }
  }

  return result;
}

// Merges the district state of two pollers. knownTheatres is a union, except
// that a theatre one poller removed stays removed unless it was seen again
// after the removal.
export function mergeDistrictState(a = {}, b = {}) {
  const lastSeen = maxTimes(normalizeTimes(a.lastSeen), normalizeTimes(b.lastSeen));
  const removed = maxTimes(normalizeTimes(a.removed), normalizeTimes(b.removed));
  const isRemoved = (key) => removed[key] && !(lastSeen[key] > removed[key]);

  for (const key of Object.keys(removed)) {
    if (!isRemoved(key)) {
      delete removed[key];
    }
  }

  return {
    knownTheatres: [
      ...new Set(
        [...(b.knownTheatres || []), ...(a.knownTheatres || [])].map(normalizeTheatreKey),
      ),
    ].filter((key) => !isRemoved(key)),
    unknownStreak: Math.max(a.unknownStreak || 0, b.unknownStreak || 0),
    brokenAlertSent: Boolean(a.brokenAlertSent || b.brokenAlertSent),
    lastSeen,
    removed,
  };
}

// Records the theatres of an ok check and removes known theatres that
// complete checks have not seen for removeAfterMinutes. Returns removed keys.
export function recordSeenTheatres(district, result, now, removeAfterMinutes) {
  const nowIso = now.toISOString();
  const currentKeys = new Set(result.theatres.map((theatre) => theatre.key));

  district.lastSeen ||= {};
  district.removed ||= {};

  for (const key of currentKeys) {
    district.lastSeen[key] = nowIso;
    delete district.removed[key];
  }

  // A partial or empty page must not count as the theatre being gone.
  if (!result.complete || currentKeys.size === 0) {
    return [];
  }

  const cutoff = now.getTime() - removeAfterMinutes * 60_000;
  const removedKeys = [];

  for (const key of district.knownTheatres) {
    if (currentKeys.has(key)) {
      continue;
    }

    // Theatres known before lastSeen existed start their timer now.
    if (!district.lastSeen[key]) {
      district.lastSeen[key] = nowIso;
    } else if (Date.parse(district.lastSeen[key]) <= cutoff) {
      removedKeys.push(key);
    }
  }

  if (removedKeys.length > 0) {
    district.knownTheatres = district.knownTheatres.filter(
      (key) => !removedKeys.includes(key),
    );

    for (const key of removedKeys) {
      district.removed[key] = nowIso;
    }
  }

  return removedKeys;
}
