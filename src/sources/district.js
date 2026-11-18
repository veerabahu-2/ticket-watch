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

// District links one cinema as both ".../name-c/1022257" (JSON-LD) and
// ".../name-CD1022257" (rendered page), so theatres are keyed by the numeric id.
export function normalizeTheatreKey(key) {
  const match = String(key).match(/(?:[-/]c\/|-CD)(\d+)(?:[/?#]|$)/);
  return match ? `cinema:${match[1]}` : key;
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
    const key = location?.url ? normalizeTheatreKey(location.url) : location?.name;

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
    /\[([^\]!][^\]]*)\]\((https:\/\/www\.district\.in\/movies\/[^)\s]+-CD\d+)\)/g;

  // Showtime theatres are list items; the page footer also links other
  // cinemas in plain paragraphs, which must not count as open.
  for (const line of markdown.split("\n")) {
    if (!/^\s*[*-]\s/.test(line)) {
      continue;
    }

    for (const match of line.matchAll(cinemaUrlRe)) {
      const [, name, url] = match;
      const key = normalizeTheatreKey(url);

      if (!theatresByKey.has(key)) {
        theatresByKey.set(key, { key, name: name.trim() });
      }
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

const MAX_SHOW_DATES = 7;

// The movie page lists only its first show date; each later date is a
// separate ?fromdate= page, linked from the date tabs.
function collectShowDates(text) {
  const dates = new Set();

  for (const match of text.matchAll(/fromdate=(\d{4}-\d{2}-\d{2})/g)) {
    dates.add(match[1]);
  }

  return [...dates].sort().slice(0, MAX_SHOW_DATES);
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

        const readerText = await readerResponse.text();

        return {
          status: "ok",
          readerText,
          dates: collectShowDates(readerText),
          source: "reader fallback",
        };
      }

      return {
        status: "unknown",
        theatres: [],
        reason: `HTTP ${response.status} ${response.statusText}`.trim(),
      };
    }

    const html = await response.text();

    return {
      status: "ok",
      blocks: parseJsonLdBlocks(html),
      dates: collectShowDates(html),
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
  const first = await checkShowtimesPage(url);

  if (first.status !== "ok" || first.dates.length <= 1) {
    return first;
  }

  const baseUrl = url.split("?")[0];
  const later = await Promise.all(
    first.dates
      .slice(1)
      .map((date) => checkShowtimesPage(`${baseUrl}?fromdate=${date}`)),
  );
  const theatresByKey = new Map(first.theatres.map((theatre) => [theatre.key, theatre]));
  let failedDates = 0;

  for (const result of later) {
    if (result.status !== "ok") {
      failedDates += 1;
      continue;
    }

    for (const theatre of result.theatres) {
      if (!theatresByKey.has(theatre.key)) {
        theatresByKey.set(theatre.key, theatre);
      }
    }
  }

  const theatres = [...theatresByKey.values()];

  return {
    status: "ok",
    theatres,
    reason: `${theatres.length} theatre(s) across ${first.dates.length} date(s)${
      failedDates ? `, ${failedDates} date(s) failed` : ""
    }; first date: ${first.reason}`,
  };
}

async function checkShowtimesPage(url) {
  const page = await fetchDistrictPage(url);

  if (page.status !== "ok") {
    return { ...page, theatres: [] };
  }

  if (page.readerText) {
    const theatres = collectReaderTheatres(page.readerText);

    return {
      status: "ok",
      theatres,
      dates: page.dates,
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
    dates: page.dates,
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
