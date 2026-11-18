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

// A show is one theatre on one date, keyed "cinema:ID|YYYY-MM-DD", so a
// theatre that opens a later date alerts again.
export function showKey(theatreKey, date) {
  return `${theatreKey}|${date}`;
}

function addShow(showsByKey, theatre, startTime) {
  const date = String(startTime || "").slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return;
  }

  const key = showKey(theatre.key, date);

  if (!showsByKey.has(key)) {
    showsByKey.set(key, { key, theatreKey: theatre.key, name: theatre.name, date });
  }
}

function collectTheatres(blocks) {
  const theatresByKey = new Map();
  const showsByKey = new Map();
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

    if (!key) {
      continue;
    }

    if (!theatresByKey.has(key)) {
      theatresByKey.set(key, {
        key,
        name: location?.name || key,
      });
    }

    addShow(showsByKey, theatresByKey.get(key), block.startDate);
  }

  return {
    screeningEventCount,
    theatres: [...theatresByKey.values()],
    shows: [...showsByKey.values()],
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
const MAX_FORMATS = 6;
const NEXT_DATA_RE = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

function parseNextData(html) {
  const match = html.match(NEXT_DATA_RE);

  if (!match) {
    return undefined;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

// The page data lists the theatres of the selected language and date as
// movieSessions.*.arrangedSessions, also when the page has no JSON-LD events.
function collectNextDataTheatres(nextData) {
  const theatresByKey = new Map();
  const showsByKey = new Map();
  const movieSessions = nextData?.props?.pageProps?.data?.serverState?.movieSessions || {};

  for (const entity of Object.values(movieSessions)) {
    for (const cinema of entity?.arrangedSessions || []) {
      const id = cinema?.data?.id;

      if (!id || !(cinema.sessions?.length > 0)) {
        continue;
      }

      const key = `cinema:${id}`;

      if (!theatresByKey.has(key)) {
        theatresByKey.set(key, { key, name: cinema.data.name || key });
      }

      for (const session of cinema.sessions) {
        addShow(showsByKey, theatresByKey.get(key), session?.showTime);
      }
    }
  }

  return { theatres: [...theatresByKey.values()], shows: [...showsByKey.values()] };
}

function collectNextDataDates(nextData) {
  const dates = new Set();
  const movieSessions = nextData?.props?.pageProps?.data?.serverState?.movieSessions || {};

  for (const entity of Object.values(movieSessions)) {
    for (const date of entity?.data?.sessionDates || []) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        dates.add(date);
      }
    }
  }

  return dates;
}

// Each language (Tamil, English, ...) is a separate format with its own
// theatres; the default page shows only one of them, and District changes
// which one.
function collectFormats(text) {
  const formats = new Set();

  for (const match of text.matchAll(/"fmtGrpId":"([A-Za-z0-9]+)"|frmtid=([A-Za-z0-9]+)/g)) {
    formats.add((match[1] || match[2]).toLowerCase());
  }

  return [...formats].sort().slice(0, MAX_FORMATS);
}

// The movie page lists only its first show date; each later date is a
// separate ?fromdate= page, linked from the date tabs.
function collectShowDates(text, nextData) {
  const dates = collectNextDataDates(nextData);

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
          formats: collectFormats(readerText),
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
    const nextData = parseNextData(html);

    return {
      status: "ok",
      blocks: parseJsonLdBlocks(html),
      nextData: collectNextDataTheatres(nextData),
      dates: collectShowDates(html, nextData),
      formats: collectFormats(html),
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

  const formats = first.formats || [];

  if (first.status !== "ok" || (formats.length === 0 && first.dates.length <= 1)) {
    return first;
  }

  const baseUrl = url.split("?")[0];
  const formatFirsts = await Promise.all(
    formats.map((format) => checkShowtimesPage(`${baseUrl}?frmtid=${format}`)),
  );
  const laterUrls = [
    ...first.dates.slice(1).map((date) => `${baseUrl}?fromdate=${date}`),
    ...formats.flatMap((format, index) =>
      (formatFirsts[index].dates || [])
        .slice(1)
        .map((date) => `${baseUrl}?frmtid=${format}&fromdate=${date}`),
    ),
  ];
  const later = [...formatFirsts, ...(await Promise.all(laterUrls.map(checkShowtimesPage)))];
  const theatresByKey = new Map(first.theatres.map((theatre) => [theatre.key, theatre]));
  const showsByKey = new Map(first.shows.map((show) => [show.key, show]));
  let failedPages = 0;

  for (const result of later) {
    if (result.status !== "ok") {
      failedPages += 1;
      continue;
    }

    for (const theatre of result.theatres) {
      if (!theatresByKey.has(theatre.key)) {
        theatresByKey.set(theatre.key, theatre);
      }
    }

    for (const show of result.shows) {
      if (!showsByKey.has(show.key)) {
        showsByKey.set(show.key, show);
      }
    }
  }

  const theatres = [...theatresByKey.values()];

  return {
    status: "ok",
    theatres,
    shows: [...showsByKey.values()],
    complete: [first, ...later].every((result) => result.complete),
    reason: `${theatres.length} theatre(s) across ${Math.max(formats.length, 1)} language(s), ${
      later.length + 1
    } page(s)${failedPages ? `, ${failedPages} page(s) failed` : ""}; first page: ${first.reason}`,
  };
}

async function checkShowtimesPage(url) {
  const page = await fetchDistrictPage(url);

  if (page.status !== "ok") {
    return { ...page, theatres: [], shows: [] };
  }

  if (page.readerText) {
    const theatres = collectReaderTheatres(page.readerText);

    return {
      status: "ok",
      theatres,
      // The reader text has no show dates.
      shows: [],
      // The reader may show only one language, so it must not remove theatres.
      complete: false,
      dates: page.dates,
      formats: page.formats,
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

  const { screeningEventCount, theatres, shows } = collectTheatres(blocks);

  for (const theatre of page.nextData.theatres) {
    if (!theatres.some((known) => known.key === theatre.key)) {
      theatres.push(theatre);
    }
  }

  for (const show of page.nextData.shows) {
    if (!shows.some((known) => known.key === show.key)) {
      shows.push(show);
    }
  }

  return {
    status: "ok",
    theatres,
    shows,
    complete: true,
    dates: page.dates,
    formats: page.formats,
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
