const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;

const JSON_LD_RE =
  /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function errorMessage(error) {
  if (error?.name === "AbortError") {
    return "fetch timed out after 15s";
  }

  return error?.message || String(error);
}

function hasType(item, type) {
  const itemType = item?.["@type"];
  return Array.isArray(itemType) ? itemType.includes(type) : itemType === type;
}

function flattenJsonLd(value) {
  if (Array.isArray(value)) {
    return value.flatMap(flattenJsonLd);
  }

  if (value && typeof value === "object") {
    const graph = value["@graph"];
    return graph ? [value, ...flattenJsonLd(graph)] : [value];
  }

  return [];
}

function parseJsonLdBlocks(html) {
  const blocks = [];

  for (const match of html.matchAll(JSON_LD_RE)) {
    try {
      blocks.push(...flattenJsonLd(JSON.parse(match[1].trim())));
    } catch {
      // A single malformed JSON-LD script should not invalidate the page.
    }
  }

  return blocks;
}

function collectTheatres(blocks) {
  const theatresByKey = new Map();
  let screeningEventCount = 0;

  for (const block of blocks) {
    if (!hasType(block, "ScreeningEvent")) {
      continue;
    }

    screeningEventCount += 1;

    const location = Array.isArray(block.location)
      ? block.location[0]
      : block.location;
    const key = location?.url || location?.name;

    if (!key || theatresByKey.has(key)) {
      continue;
    }

    theatresByKey.set(key, {
      key,
      name: location?.name || key,
    });
  }

  return {
    screeningEventCount,
    theatres: [...theatresByKey.values()],
  };
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function validateDistrictMovieConfig(movieConfig) {
  const city = slugify(movieConfig.city);
  const contentId = String(movieConfig.district?.contentId || "").trim();
  let url;

  try {
    url = new URL(movieConfig.district?.url);
  } catch {
    throw new Error(`District URL is invalid for movie id ${movieConfig.id}`);
  }

  const expectedSuffix = `-movie-tickets-in-${city}-MV${contentId}`;

  if (
    url.hostname !== "www.district.in" ||
    !contentId ||
    !url.pathname.endsWith(expectedSuffix)
  ) {
    throw new Error(
      `District URL for movie id ${movieConfig.id} must be the city-specific showtimes URL ending in ${expectedSuffix}`,
    );
  }
}

export async function checkDistrictTheatres(movieConfig) {
  try {
    validateDistrictMovieConfig(movieConfig);
  } catch (error) {
    return {
      status: "unknown",
      theatres: [],
      reason: errorMessage(error),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(movieConfig.district.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        status: "unknown",
        theatres: [],
        reason: `HTTP ${response.status} ${response.statusText}`.trim(),
      };
    }

    const blocks = parseJsonLdBlocks(await response.text());

    if (!blocks.some((block) => hasType(block, "Movie"))) {
      return {
        status: "unknown",
        theatres: [],
        reason: "no Movie JSON-LD block found (page shape may have changed)",
      };
    }

    const { screeningEventCount, theatres } = collectTheatres(blocks);

    return {
      status: "ok",
      theatres,
      reason: `${screeningEventCount} screening event(s) across ${theatres.length} theatre(s)`,
    };
  } catch (error) {
    return {
      status: "unknown",
      theatres: [],
      reason: errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
