import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";

import {
  checkDistrictTheatres,
  validateDistrictMovieConfig,
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

test("configured movies use city-specific District showtimes URLs", async () => {
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
