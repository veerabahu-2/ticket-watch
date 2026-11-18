import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { notify, placeCall } from "./notify.js";
import {
  checkDistrictTheatres,
  normalizeTheatreKey,
  validateDistrictMovieConfig,
} from "./sources/district.js";
import { DEFAULT_REMOVE_AFTER_MINUTES, recordSeenTheatres } from "./state.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(rootDir, "config.json");
const statePath = path.join(rootDir, "state.json");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(date) {
  const [, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

function formatDates(dates) {
  return [...dates].sort().map(formatDate).join(", ");
}

function buildAlertTitle(movieConfig, alert) {
  const dates = alert.dates.length > 0 ? ` (${formatDates(alert.dates)})` : "";

  return alert.isNewTheatre
    ? `${movieConfig.title} tickets just opened at ${alert.name}${dates}!`
    : `${movieConfig.title}: new date${alert.dates.length > 1 ? "s" : ""} at ${alert.name}${dates}!`;
}

function buildNewTheatreMessage(movieConfig, alert, districtUrl) {
  return [
    `${buildAlertTitle(movieConfig, alert)}`,
    "",
    `District: ${districtUrl}`,
    `BookMyShow: ${movieConfig.bookmyshow.url}`,
    "BookMyShow is not auto-checked; check there too.",
  ].join("\n");
}

function buildBrokenMessage(movieConfig, result, movieState) {
  return [
    `District status has been unknown for ${movieState.district.unknownStreak} consecutive checks.`,
    `Latest reason: ${result.reason}`,
    "",
    `Check manually: ${result.url || movieConfig.district.url || movieConfig.district.discoveryUrl}`,
  ].join("\n");
}

function assertConfigAndState(config, state) {
  if (!Array.isArray(config.movies)) {
    throw new Error("config.json must contain a movies array");
  }

  for (const movieConfig of config.movies) {
    if (!movieConfig.id) {
      throw new Error("Each configured movie must have an id");
    }

    validateDistrictMovieConfig(movieConfig);

    if (!state[movieConfig.id]?.district) {
      throw new Error(`state.json is missing district state for movie id ${movieConfig.id}`);
    }

    if (!Array.isArray(state[movieConfig.id].district.knownTheatres)) {
      throw new Error(
        `state.json district.knownTheatres must be an array for movie id ${movieConfig.id}`,
      );
    }
  }
}

async function handleUnknownDistrictResult(config, movieConfig, movieState, result) {
  movieState.district.unknownStreak += 1;

  if (
    movieState.district.unknownStreak >= config.unknownStreakAlertThreshold &&
    !movieState.district.brokenAlertSent
  ) {
    await notify({
      title: `ticket-watch: District check may be broken for ${movieConfig.title}`,
      message: buildBrokenMessage(movieConfig, result, movieState),
      url: result.url || movieConfig.district.url || movieConfig.district.discoveryUrl,
    });

    movieState.district.brokenAlertSent = true;
  }
}

async function handleOkDistrictResult(config, movieConfig, movieState, result) {
  movieState.district.unknownStreak = 0;
  movieState.district.brokenAlertSent = false;

  // Forget theatres that District stopped listing, so a later real opening
  // alerts and calls again.
  const removedKeys = recordSeenTheatres(
    movieState.district,
    result,
    new Date(),
    config.removeAfterMinutes ?? DEFAULT_REMOVE_AFTER_MINUTES,
  );

  if (removedKeys.length > 0) {
    console.log(`Forgot theatre(s) no longer listed: ${removedKeys.join(", ")}`);
  }

  const knownTheatres = new Set(movieState.district.knownTheatres);
  const newTheatres = result.theatres.filter((theatre) => !knownTheatres.has(theatre.key));
  const newShows = handleDistrictShows(config, movieState, result);

  // One alert per theatre: a new theatre, or new dates at a known theatre.
  const alerts = new Map();

  for (const theatre of newTheatres) {
    alerts.set(theatre.key, { name: theatre.name, isNewTheatre: true, dates: [] });
  }

  for (const show of newShows) {
    if (!alerts.has(show.theatreKey)) {
      alerts.set(show.theatreKey, { name: show.name, isNewTheatre: false, dates: [] });
    }

    alerts.get(show.theatreKey).dates.push(show.date);
  }

  movieState.district.knownTheatres.push(
    ...newTheatres.map((theatre) => theatre.key),
  );

  if (alerts.size === 0) {
    return { newTheatres, newShows };
  }

  for (const alert of alerts.values()) {
    await notify({
      title: buildAlertTitle(movieConfig, alert),
      message: buildNewTheatreMessage(movieConfig, alert, result.url),
      url: result.url,
    });
  }

  // The call is best effort: a failed call must not block saving state, or
  // the next poll would resend every text alert.
  try {
    const parts = [...alerts.values()].map((alert) =>
      alert.dates.length > 0 ? `${alert.name} for ${formatDates(alert.dates)}` : alert.name,
    );

    await placeCall({
      speech: `${movieConfig.title} tickets just opened at ${parts.join("; ")}. Book now on District.`,
    });
  } catch (error) {
    console.error(`Phone call failed: ${error?.stack || error?.message || error}`);
  }

  return { newTheatres, newShows };
}

// Tracks each theatre and date as a show, so a theatre that opens a later
// date alerts again. Returns the new shows.
function handleDistrictShows(config, movieState, result) {
  const shows = result.shows || [];
  const showResult = {
    theatres: shows,
    // A theatre without any dated show means the dates were not readable,
    // so missing shows must not count as removed.
    complete:
      result.complete &&
      result.theatres.every((theatre) => shows.some((show) => show.theatreKey === theatre.key)),
  };

  // The first run with show tracking learns the open dates without alerts,
  // because those theatres were already alerted.
  if (!movieState.districtShows) {
    movieState.districtShows = {
      knownTheatres: shows.map((show) => show.key),
      unknownStreak: 0,
      brokenAlertSent: false,
    };
    recordSeenTheatres(movieState.districtShows, showResult, new Date(), 0);
    console.log(`Learned ${shows.length} open show date(s) without alerts`);
    return [];
  }

  const removedKeys = recordSeenTheatres(
    movieState.districtShows,
    showResult,
    new Date(),
    config.removeAfterMinutes ?? DEFAULT_REMOVE_AFTER_MINUTES,
  );

  if (removedKeys.length > 0) {
    console.log(`Forgot show date(s) no longer listed: ${removedKeys.join(", ")}`);
  }

  const known = new Set(movieState.districtShows.knownTheatres);
  const newShows = shows.filter((show) => !known.has(show.key));
  movieState.districtShows.knownTheatres.push(...newShows.map((show) => show.key));

  return newShows;
}

async function run() {
  const config = await readJson(configPath);
  const state = await readJson(statePath);
  const before = stableJson(state);

  assertConfigAndState(config, state);

  for (const movieConfig of config.movies) {
    const district = state[movieConfig.id].district;
    district.knownTheatres = [...new Set(district.knownTheatres.map(normalizeTheatreKey))];
  }

  for (const movieConfig of config.movies) {
    const movieState = state[movieConfig.id];
    const result = await checkDistrictTheatres(movieConfig);
    let newTheatreCount = 0;
    let newShowCount = 0;

    if (result.status === "ok") {
      const { newTheatres, newShows } = await handleOkDistrictResult(
        config,
        movieConfig,
        movieState,
        result,
      );
      newTheatreCount = newTheatres.length;
      newShowCount = newShows.length;
    } else {
      await handleUnknownDistrictResult(config, movieConfig, movieState, result);
    }

    console.log(
      `[${new Date().toISOString()}] ${movieConfig.id} district=${result.status} newTheatres=${newTheatreCount} newShows=${newShowCount} knownTheatres=${movieState.district.knownTheatres.length} knownShows=${movieState.districtShows?.knownTheatres.length ?? 0} reason=${result.reason}`,
    );
  }

  const after = stableJson(state);

  if (after !== before) {
    await writeFile(statePath, after);
  }
}

run().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
