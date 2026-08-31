const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;
const READER_BASE_URL = "https://r.jina.ai/";

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
    return [value, ...Object.values(value).flatMap(flattenJsonLd)];
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

function normalizeTitle(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function collectReaderTheatres(markdown) {
  const theatresByKey = new Map();
  const cinemaUrlRe =
    /\[([^\]]+)\]\((https:\/\/www\.district\.in\/movies\/[^)\s]+-in-[^)\s]+-CD\d+)\)/g;

  for (const match of markdown.matchAll(cinemaUrlRe)) {
    const [, name, key] = match;

    if (!theatresByKey.has(key)) {
      theatresByKey.set(key, { key, name: name.trim() });
    }
  }

  return [...theatresByKey.values()];
}

function findReaderMovieUrl(markdown, movieConfig) {
  const city = slugify(movieConfig.city);
  const title = normalizeTitle(movieConfig.district.movieTitle);
  const movieUrlRe = new RegExp(
    `https://www\\.district\\.in/movies/[^)\\s]+-movie-tickets-in-${city}-MV\\d+`,
    "g",
  );

  for (const match of markdown.matchAll(movieUrlRe)) {
    const url = match[0];
    const slug = decodeURIComponent(url.split("/").pop() || "")
      .replace(/-movie-tickets-in-[^-]+-MV\d+$/, "");

    if (normalizeTitle(slug) === title) {
      return url;
    }
  }

  return undefined;
}

function validateDistrictUrl(urlString, movieConfig) {
  const city = slugify(movieConfig.city);
  const contentId = String(movieConfig.district?.contentId || "").trim();
  let url;

  try {
    url = new URL(urlString);
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

export function validateDistrictMovieConfig(movieConfig) {
  if (movieConfig.district?.url) {
    validateDistrictUrl(movieConfig.district.url, movieConfig);
    return;
  }

  try {
    const discoveryUrl = new URL(movieConfig.district?.discoveryUrl);
    const expectedPath = `/movies/${slugify(movieConfig.city)}-movie-tickets`;

    if (
      discoveryUrl.hostname !== "www.district.in" ||
      discoveryUrl.pathname !== expectedPath ||
      !movieConfig.district?.movieTitle
    ) {
      throw new Error("invalid discovery configuration");
    }
  } catch {
    throw new Error(
      `District configuration for movie id ${movieConfig.id} must provide either a city-specific showtimes URL or a valid city catalogue discovery URL and movieTitle`,
    );
  }
}

async function fetchDistrictPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 403) {
        const readerResponse = await fetch(`${READER_BASE_URL}${url}`);

        if (!readerResponse.ok) {
          return {
            status: "unknown",
            theatres: [],
            reason: `District returned HTTP 403 and reader fallback returned HTTP ${readerResponse.status} ${readerResponse.statusText}`.trim(),
          };
        }

        return {
          status: "ok",
          readerText: await readerResponse.text(),
          source: "reader fallback",
        };
      }

      return {
        status: "unknown",
        theatres: [],
        reason: `HTTP ${response.status} ${response.statusText}`.trim(),
      };
    }

    return {
      status: "ok",
      blocks: parseJsonLdBlocks(await response.text()),
      source: "District",
    };
  } catch (error) {
    return {
      status: "unknown",
      reason: errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkShowtimes(url) {
  const page = await fetchDistrictPage(url);

  if (page.status !== "ok") {
    return { ...page, theatres: [] };
  }

  if (page.readerText) {
    const theatres = collectReaderTheatres(page.readerText);

    return {
      status: "ok",
      theatres,
      reason: `reader fallback found ${theatres.length} theatre(s)`,
    };
  }

  const { blocks } = page;

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
}

async function discoverDistrictMovieUrl(movieConfig) {
  const page = await fetchDistrictPage(movieConfig.district.discoveryUrl);

  if (page.status !== "ok") {
    return {
      ...page,
      theatres: [],
    };
  }

  if (page.readerText) {
    const url = findReaderMovieUrl(page.readerText, movieConfig);

    if (!url) {
      return {
        status: "ok",
        theatres: [],
        reason: "movie is not listed in the District Chennai catalogue yet",
        url: movieConfig.district.discoveryUrl,
      };
    }

    return {
      ...(await checkShowtimes(url)),
      url,
    };
  }

  const targetTitle = normalizeTitle(movieConfig.district.movieTitle);
  const movie = page.blocks.find(
    (block) =>
      hasType(block, "Movie") &&
      normalizeTitle(block.name) === targetTitle &&
      typeof block.url === "string",
  );

  if (!movie) {
    return {
      status: "ok",
      theatres: [],
      reason: "movie is not listed in the District Chennai catalogue yet",
      url: movieConfig.district.discoveryUrl,
    };
  }

  try {
    validateDistrictUrl(movie.url, {
      ...movieConfig,
      district: {
        ...movieConfig.district,
        url: movie.url,
        contentId: movie.url.match(/MV(\d+)$/)?.[1],
      },
    });
  } catch (error) {
    return {
      status: "unknown",
      theatres: [],
      reason: `District catalogue returned an invalid movie page: ${errorMessage(error)}`,
    };
  }

  return {
    ...(await checkShowtimes(movie.url)),
    url: movie.url,
  };
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

  if (movieConfig.district.url) {
    return {
      ...(await checkShowtimes(movieConfig.district.url)),
      url: movieConfig.district.url,
    };
  }

  return discoverDistrictMovieUrl(movieConfig);
}
