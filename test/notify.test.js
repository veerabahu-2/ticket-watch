import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { notify, placeCall } from "../src/notify.js";

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

test("placeCall is skipped when Bland is not configured", async () => {
  const saved = { key: process.env.BLAND_API_KEY, phone: process.env.BLAND_PHONE_NUMBER };
  delete process.env.BLAND_API_KEY;
  delete process.env.BLAND_PHONE_NUMBER;
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };

  try {
    await placeCall({ speech: "Hello" });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (saved.key !== undefined) process.env.BLAND_API_KEY = saved.key;
    if (saved.phone !== undefined) process.env.BLAND_PHONE_NUMBER = saved.phone;
  }
});

test("placeCall posts the speech and number to Bland", async () => {
  const saved = { key: process.env.BLAND_API_KEY, phone: process.env.BLAND_PHONE_NUMBER };
  process.env.BLAND_API_KEY = "test-key";
  process.env.BLAND_PHONE_NUMBER = "+910000000000";
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response("{}", { status: 200 });
  };

  try {
    await placeCall({ speech: "Tickets opened" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.bland.ai/v1/calls");
    assert.equal(requests[0].options.headers.authorization, "test-key");
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.phone_number, "+910000000000");
    assert.equal(body.first_sentence, "Tickets opened");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["BLAND_API_KEY", saved.key], ["BLAND_PHONE_NUMBER", saved.phone]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("placeCall calls every listed number in order and keeps going after a failure", async () => {
  const saved = { key: process.env.BLAND_API_KEY, phone: process.env.BLAND_PHONE_NUMBER };
  process.env.BLAND_API_KEY = "test-key";
  process.env.BLAND_PHONE_NUMBER = "+910000000001, +910000000002";
  const numbers = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const { phone_number: phoneNumber } = JSON.parse(options.body);
    numbers.push(phoneNumber);
    return phoneNumber === "+910000000001"
      ? new Response("no credits", { status: 402, statusText: "Payment Required" })
      : new Response("{}", { status: 200 });
  };

  try {
    await assert.rejects(placeCall({ speech: "Tickets opened" }), /failed for 1 of 2 number\(s\)/);
    assert.deepEqual(numbers, ["+910000000001", "+910000000002"]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["BLAND_API_KEY", saved.key], ["BLAND_PHONE_NUMBER", saved.phone]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
