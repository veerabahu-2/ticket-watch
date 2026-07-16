import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { notify } from "./notify.js";
import { checkDistrictTheatres } from "./sources/district.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(rootDir, "config.json");
const statePath = path.join(rootDir, "state.json");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildNewTheatresMessage(movieConfig, newTheatres) {
  return [
    `New District theatres for ${movieConfig.title}:`,
    ...newTheatres.map((theatre) => `- ${theatre.name}`),
    "",
    `District: ${movieConfig.district.url}`,
    `BookMyShow: ${movieConfig.bookmyshow.url}`,
    "BookMyShow is not auto-checked; check there too.",
  ].join("\n");
}

function buildBrokenMessage(movieConfig, result, movieState) {
  return [
    `District status has been unknown for ${movieState.district.unknownStreak} consecutive checks.`,
    `Latest reason: ${result.reason}`,
    "",
    `Check manually: ${movieConfig.district.url}`,
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
      url: movieConfig.district.url,
    });

    movieState.district.brokenAlertSent = true;
  }
}

async function handleOkDistrictResult(movieConfig, movieState, result) {
  movieState.district.unknownStreak = 0;
  movieState.district.brokenAlertSent = false;

  const knownTheatres = new Set(movieState.district.knownTheatres);
  const newTheatres = result.theatres.filter((theatre) => !knownTheatres.has(theatre.key));

  if (newTheatres.length === 0) {
    return newTheatres;
  }

  await notify({
    title: `${movieConfig.title} tickets just opened at ${newTheatres.length} theatre(s)!`,
    message: buildNewTheatresMessage(movieConfig, newTheatres),
    url: movieConfig.district.url,
  });

  movieState.district.knownTheatres.push(
    ...newTheatres.map((theatre) => theatre.key),
  );

  return newTheatres;
}

async function run() {
  const config = await readJson(configPath);
  const state = await readJson(statePath);
  const before = stableJson(state);

  assertConfigAndState(config, state);

  for (const movieConfig of config.movies) {
    const movieState = state[movieConfig.id];
    const result = await checkDistrictTheatres(movieConfig);
    let newTheatreCount = 0;

    if (result.status === "ok") {
      const newTheatres = await handleOkDistrictResult(
        movieConfig,
        movieState,
        result,
      );
      newTheatreCount = newTheatres.length;
    } else {
      await handleUnknownDistrictResult(config, movieConfig, movieState, result);
    }

    console.log(
      `[${new Date().toISOString()}] ${movieConfig.id} district=${result.status} newTheatres=${newTheatreCount} knownTheatres=${movieState.district.knownTheatres.length} reason=${result.reason}`,
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
