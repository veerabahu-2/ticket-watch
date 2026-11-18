import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";

import {
  checkDistrictTheatres,
  validateDistrictMovieConfig,
  normalizeTheatreKey,
} from "../src/sources/district.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function movieConfig(overrides = {}) {
  return {
    id: "example",
    title: "Example",
    city: "Chennai",
    district: {
      url: "https://www.district.in/movies/example-movie-tickets-in-chennai-MV123",
      contentId: "123",
      ...overrides.district,
    },
    ...overrides,
  };
}

function discoveryMovieConfig(overrides = {}) {
  return {
    id: "avengers-endgame-encore-english",
    title: "Avengers Endgame: Encore (English)",
    city: "Chennai",
    district: {
      discoveryUrl: "https://www.district.in/movies/chennai-movie-tickets",
      movieTitle: "Avengers Endgame: Encore",
      ...overrides.district,
    },
    ...overrides,
  };
}

test("configured movies have valid District configuration", async () => {
  const config = JSON.parse(
    await readFile(new URL("../config.json", import.meta.url), "utf8"),
  );

  for (const configuredMovie of config.movies) {
    assert.doesNotThrow(() => validateDistrictMovieConfig(configuredMovie));
  }
});

test("generic District landing URLs are rejected", () => {
  const configuredMovie = movieConfig({
    district: {
      url: "https://www.district.in/movies/chennai-movie-tickets-MV123",
      contentId: "123",
    },
  });

  assert.throws(
    () => validateDistrictMovieConfig(configuredMovie),
    /city-specific showtimes URL/,
  );
});

test("invalid District configuration returns unknown without fetching", async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("should not fetch");
  };

  const result = await checkDistrictTheatres(
    movieConfig({
      district: {
        url: "https://www.district.in/movies/chennai-movie-tickets-MV123",
        contentId: "123",
      },
    }),
  );

  assert.equal(result.status, "unknown");
  assert.match(result.reason, /city-specific showtimes URL/);
  assert.equal(fetchCalled, false);
});

test("ScreeningEvent JSON-LD is collected by theatre", async () => {
  const html = `
    <script type="application/ld+json">
      {"@type":"Movie","name":"Example"}
    </script>
    <script type="application/ld+json">
      [
        {
          "@type":"ScreeningEvent",
          "location":{"name":"Cinema One","url":"https://district.in/cinema-one"}
        },
        {
          "@type":"ScreeningEvent",
          "location":{"name":"Cinema One","url":"https://district.in/cinema-one"}
        },
        {
          "@type":"ScreeningEvent",
          "location":{"name":"Cinema Two","url":"https://district.in/cinema-two"}
        }
      ]
    </script>
  `;
  globalThis.fetch = async () => new Response(html, { status: 200 });

  const result = await checkDistrictTheatres(movieConfig());

  assert.equal(result.status, "ok");
  assert.equal(result.reason, "3 screening event(s) across 2 theatre(s)");
  assert.deepEqual(
    result.theatres.map(({ name }) => name),
    ["Cinema One", "Cinema Two"],
  );
});

test("a page without Movie JSON-LD is reported as unknown", async () => {
  globalThis.fetch = async () =>
    new Response("<html><body>Book Tickets</body></html>", { status: 200 });

  const result = await checkDistrictTheatres(movieConfig());

  assert.equal(result.status, "unknown");
  assert.match(result.reason, /no Movie JSON-LD block/);
});

test("discovers a new movie page from the Chennai catalogue and checks it", async () => {
  const showtimesUrl =
    "https://www.district.in/movies/avengers-endgame-encore-movie-tickets-in-chennai-MV123";
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(url);

    if (url === "https://www.district.in/movies/chennai-movie-tickets") {
      return new Response(
        `<script type="application/ld+json">
          {"@type":"ItemList","itemListElement":[
            {"@type":"ListItem","item":{"@type":"Movie","name":"Avengers Endgame: Encore","url":"${showtimesUrl}"}}
          ]}
        </script>`,
        { status: 200 },
      );
    }

    return new Response(
      `<script type="application/ld+json">{"@type":"Movie","name":"Avengers Endgame: Encore"}</script>
       <script type="application/ld+json">{"@type":"ScreeningEvent","location":{"name":"Cinema One","url":"https://district.in/cinema-one"}}</script>`,
      { status: 200 },
    );
  };

  const result = await checkDistrictTheatres(discoveryMovieConfig());

  assert.equal(result.status, "ok");
  assert.equal(result.url, showtimesUrl);
  assert.equal(result.theatres.length, 1);
  assert.deepEqual(fetchedUrls, [
    "https://www.district.in/movies/chennai-movie-tickets",
    showtimesUrl,
  ]);
});

test("keeps checking when the movie is not listed in the District catalogue yet", async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(
      `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[]}</script>`,
      { status: 200 },
    );
  };

  const result = await checkDistrictTheatres(discoveryMovieConfig());

  assert.equal(result.status, "ok");
  assert.equal(result.theatres.length, 0);
  assert.match(result.reason, /not listed/);
  assert.equal(fetchCount, 1);
});

test("uses the reader fallback when District blocks the cloud request", async () => {
  const catalogueUrl = "https://www.district.in/movies/chennai-movie-tickets";
  const showtimesUrl =
    "https://www.district.in/movies/avengers-endgame-encore-movie-tickets-in-chennai-MV123";
  const readerBase = "https://r.jina.ai/";
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(url);

    if (url === catalogueUrl || url === showtimesUrl) {
      return new Response("blocked", { status: 403, statusText: "Forbidden" });
    }

    if (url === `${readerBase}${catalogueUrl}`) {
      return new Response(
        `[Avengers Endgame: Encore](${showtimesUrl})`,
        { status: 200 },
      );
    }

    return new Response(
      [
        "*   [![Image 1: Cinema One](https://cdn.district.in/x.png)](https://www.district.in/movies/cinema-one-chennai-CD123)  [Cinema One](https://www.district.in/movies/cinema-one-chennai-CD123)  2 km away",
        "*   [Cinema One](https://www.district.in/movies/cinema-one-in-chennai-CD123)",
        "Find the best cinemas: [Other Cinema](https://www.district.in/movies/other-cinema-chennai-CD999)",
      ].join("\n"),
      { status: 200 },
    );
  };

  const result = await checkDistrictTheatres(discoveryMovieConfig());

  assert.equal(result.status, "ok");
  assert.equal(result.url, showtimesUrl);
  assert.deepEqual(result.theatres, [
    {
      key: "cinema:123",
      name: "Cinema One",
    },
  ]);
  assert.deepEqual(fetchedUrls, [
    catalogueUrl,
    `${readerBase}${catalogueUrl}`,
    showtimesUrl,
    `${readerBase}${showtimesUrl}`,
  ]);
});

test("normalizeTheatreKey maps both District cinema URL formats to one key", () => {
  assert.equal(
    normalizeTheatreKey("https://www.district.in/movies/pvr-palazzo-chennai-c/1022274"),
    "cinema:1022274",
  );
  assert.equal(
    normalizeTheatreKey("https://www.district.in/movies/pvr-palazzo-chennai-CD1022274"),
    "cinema:1022274",
  );
  assert.equal(normalizeTheatreKey("cinema:1022274"), "cinema:1022274");
});

test("checkDistrictTheatres also finds theatres open only on later show dates", async () => {
  const url = movieConfig().district.url;
  const page = (cinemas, tabs) => {
    const blocks = [
      { "@type": "Movie", name: "Example" },
      ...cinemas.map((id) => ({
        "@type": "ScreeningEvent",
        location: {
          "@type": "MovieTheater",
          name: `Cinema ${id}`,
          url: `https://www.district.in/movies/cinema-${id}-chennai-c/${id}`,
        },
      })),
    ];
    const links = tabs.map((date) => `<a href="${url}?fromdate=${date}">${date}</a>`).join("");
    return `${links}<script type="application/ld+json">${JSON.stringify(blocks)}</script>`;
  };
  const tabs = ["2026-12-17", "2026-12-18"];

  globalThis.fetch = async (requested) => {
    const body = String(requested).endsWith("fromdate=2026-12-18")
      ? page([2], tabs)
      : page([1], tabs);
    return new Response(body, { status: 200 });
  };

  const result = await checkDistrictTheatres(movieConfig());

  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.theatres.map((theatre) => theatre.key).sort(),
    ["cinema:1", "cinema:2"],
  );
});

test("checkDistrictTheatres reads every language, which District lists as separate pages", async () => {
  const url = movieConfig().district.url;
  const nextData = (entity, cinemaId) => ({
    props: {
      pageProps: {
        data: {
          serverState: {
            movieContents: {
              123: {
                languageFormatGroups: [{ fmtGrpId: "TamilFmt" }, { fmtGrpId: "EnglishFmt" }],
              },
            },
            movieSessions: {
              [entity]: {
                data: { sessionDates: ["2026-12-17"] },
                arrangedSessions: [
                  { data: { id: cinemaId, name: `Cinema ${cinemaId}` }, sessions: [{}] },
                ],
              },
            },
          },
        },
      },
    },
  });
  const page = (entity, cinemaId) =>
    `<script type="application/ld+json">${JSON.stringify({ "@type": "Movie" })}</script>` +
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData(entity, cinemaId))}</script>`;

  globalThis.fetch = async (requested) => {
    const body = String(requested).includes("frmtid=englishfmt")
      ? page("englishfmt", 2)
      : page("tamilfmt", 1);
    return new Response(body, { status: 200 });
  };

  const result = await checkDistrictTheatres(movieConfig());

  assert.equal(result.status, "ok");
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.theatres.map((theatre) => theatre.key).sort(),
    ["cinema:1", "cinema:2"],
  );
});
