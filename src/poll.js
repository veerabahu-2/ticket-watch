import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { notify } from "./notify.js";
import { checkDistrict } from "./sources/district.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(rootDir, "config.json");
const statePath = path.join(rootDir, "state.json");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildOpenMessage(config) {
  return [
    `${config.movie} ticket booking appears to be open on District for ${config.city}.`,
    "",
    `District: ${config.district.url}`,
    `BookMyShow: ${config.bookmyshow.url}`,
    "BookMyShow is not auto-checked; verify there too.",
  ].join("\n");
}

function buildBrokenMessage(config, result, state) {
  return [
    `District status has been unknown for ${state.district.unknownStreak} consecutive checks.`,
    `Latest reason: ${result.reason}`,
    "",
    `Check manually: ${config.district.url}`,
  ].join("\n");
}

async function run() {
  const config = await readJson(configPath);
  const state = await readJson(statePath);
  const before = stableJson(state);
  const result = await checkDistrict(config);

  if (result.status === "open") {
    if (!state.district.open) {
      await notify({
        title: `${config.movie} tickets are OPEN (District)`,
        message: buildOpenMessage(config),
        url: config.district.url,
      });

      state.district.open = true;
      state.district.notifiedAt = new Date().toISOString();
    }

    state.district.unknownStreak = 0;
  } else if (result.status === "closed") {
    state.district.open = false;
    state.district.unknownStreak = 0;
    state.district.brokenAlertSent = false;
  } else {
    state.district.unknownStreak += 1;

    if (
      state.district.unknownStreak >= config.unknownStreakAlertThreshold &&
      !state.district.brokenAlertSent
    ) {
      await notify({
        title: "ticket-watch: District check may be broken",
        message: buildBrokenMessage(config, result, state),
        url: config.district.url,
      });

      state.district.brokenAlertSent = true;
    }
  }

  const after = stableJson(state);

  if (after !== before) {
    await writeFile(statePath, after);
  }

  console.log(
    `[${new Date().toISOString()}] district=${result.status} unknownStreak=${state.district.unknownStreak} reason=${result.reason}`,
  );
}

run().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
