import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { notify } from "../src/notify.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  NTFY_TOPIC: process.env.NTFY_TOPIC,
  REQUIRE_NTFY: process.env.REQUIRE_NTFY,
  REQUIRE_TELEGRAM: process.env.REQUIRE_TELEGRAM,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  delete process.env.NTFY_TOPIC;
  delete process.env.REQUIRE_NTFY;
  delete process.env.REQUIRE_TELEGRAM;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("NTFY_TOPIC", originalEnv.NTFY_TOPIC);
  restoreEnv("REQUIRE_NTFY", originalEnv.REQUIRE_NTFY);
  restoreEnv("REQUIRE_TELEGRAM", originalEnv.REQUIRE_TELEGRAM);
  restoreEnv("TELEGRAM_BOT_TOKEN", originalEnv.TELEGRAM_BOT_TOKEN);
  restoreEnv("TELEGRAM_CHAT_ID", originalEnv.TELEGRAM_CHAT_ID);
});

test("Telegram HTTP failures reject notification delivery", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "123";
  globalThis.fetch = async () =>
    new Response("bad request", {
      status: 400,
      statusText: "Bad Request",
    });

  await assert.rejects(
    notify({ title: "Title", message: "Message" }),
    /notification channel\(s\) failed/,
  );
});

test("Telegram sends to every configured chat", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "123, 456";
  const chatIds = [];
  globalThis.fetch = async (_url, options) => {
    chatIds.push(JSON.parse(options.body).chat_id);
    return new Response('{"ok":true}', { status: 200 });
  };

  await notify({ title: "Title", message: "Message" });

  assert.deepEqual(chatIds, ["123", "456"]);
});

test("ntfy HTTP failures reject notification delivery", async () => {
  process.env.NTFY_TOPIC = "test-topic";
  globalThis.fetch = async () =>
    new Response("unavailable", {
      status: 503,
      statusText: "Service Unavailable",
    });

  await assert.rejects(
    notify({ title: "Title", message: "Message" }),
    /notification channel\(s\) failed/,
  );
});

test("required channels reject missing configuration", async () => {
  process.env.REQUIRE_NTFY = "true";
  process.env.REQUIRE_TELEGRAM = "true";

  await assert.rejects(
    notify({ title: "Title", message: "Message" }),
    /notification channel\(s\) failed/,
  );
});
