const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;

const NEXT_DATA_RE =
  /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s;

function findIndicator(text, indicators = []) {
  return indicators.find((indicator) => indicator && text.includes(indicator));
}

function errorMessage(error) {
  if (error?.name === "AbortError") {
    return "fetch timed out after 15s";
  }

  return error?.message || String(error);
}

// District's Next.js page embeds real showtime data at this path. It's an
// empty object before booking opens and gets populated with cinema/session
// entries the moment tickets go on sale — far more reliable than matching
// marketing copy, which can be reworded without notice.
function readSessionsFromNextData(html, contentId) {
  const match = html.match(NEXT_DATA_RE);
  if (!match) {
    return { found: false };
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return { found: false };
  }

  const mdp = data?.props?.pageProps?.initialState?.mdpV2;
  if (!mdp || typeof mdp.sessions !== "object" || mdp.sessions === null) {
    return { found: false };
  }

  const movieData = mdp.movieData?.[contentId];
  if (!movieData) {
    return { found: false };
  }

  return { found: true, sessionCount: Object.keys(mdp.sessions).length };
}

export async function checkDistrict(config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(config.district.url, {
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
        reason: `HTTP ${response.status} ${response.statusText}`.trim(),
      };
    }

    const text = await response.text();

    // Primary signal: the embedded session data, which is authoritative and
    // structural rather than text that marketing copy could reword.
    const sessions = readSessionsFromNextData(text, config.district.contentId);
    if (sessions.found) {
      return sessions.sessionCount > 0
        ? { status: "open", reason: `${sessions.sessionCount} session entries present` }
        : { status: "closed", reason: "sessions object is empty" };
    }

    // Fallback: __NEXT_DATA__ shape changed or wasn't present. Fall back to
    // matching copy on the page so a structural change doesn't go unnoticed
    // (it still surfaces as "unknown" below, which triggers the broken-check
    // alert after enough consecutive misses).
    const openIndicator = findIndicator(text, config.district.openIndicators);
    if (openIndicator) {
      return {
        status: "open",
        reason: `matched open indicator (fallback): ${openIndicator}`,
      };
    }

    const closedIndicator = findIndicator(text, config.district.closedIndicators);
    if (closedIndicator) {
      return {
        status: "closed",
        reason: `matched closed indicator (fallback): ${closedIndicator}`,
      };
    }

    return {
      status: "unknown",
      reason: "no session data and no configured text indicator matched",
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
