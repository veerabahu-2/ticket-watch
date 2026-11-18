async function postNtfy({ title, message, url }) {
  const topic = process.env.NTFY_TOPIC;

  if (!topic) {
    if (process.env.REQUIRE_NTFY === "true") {
      throw new Error("NTFY_TOPIC is required but unset");
    }

    console.warn("Skipping ntfy notification: NTFY_TOPIC is unset");
    return;
  }

  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      Title: title,
      Priority: "urgent",
      Tags: "tickets",
      ...(url ? { Click: url } : {}),
    },
    body: message,
  });

  if (!response.ok) {
    throw new Error(`ntfy returned HTTP ${response.status} ${response.statusText}`);
  }
}

async function postTelegram({ title, message, url }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = (process.env.TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((chatId) => chatId.trim())
    .filter(Boolean);

  if (!token || chatIds.length === 0) {
    if (process.env.REQUIRE_TELEGRAM === "true") {
      throw new Error(
        "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required but unset",
      );
    }

    console.warn(
      "Skipping Telegram notification: TELEGRAM_BOT_TOKEN is unset or no TELEGRAM_CHAT_ID chat ids are configured",
    );
    return;
  }

  const text = `${title}\n\n${message}${url ? `\n${url}` : ""}`;
  const failures = [];

  for (const chatId of chatIds) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            chat_id: chatId,
            text,
          }),
        },
      );

      if (!response.ok) {
        const responseText = await response.text().catch(() => "");
        failures.push(
          new Error(
            `chat_id ${chatId}: HTTP ${response.status} ${response.statusText}: ${responseText}`,
          ),
        );
      }
    } catch (error) {
      failures.push(
        new Error(
          `chat_id ${chatId}: ${error?.stack || error?.message || error}`,
        ),
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Telegram notification failed for ${failures.length} chat(s)`,
    );
  }
}

export async function notify({ title, message, url }) {
  const channels = [
    ["ntfy", () => postNtfy({ title, message, url })],
    ["Telegram", () => postTelegram({ title, message, url })],
  ];
  const results = await Promise.allSettled(
    channels.map(([, send]) => send()),
  );
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") {
      return [];
    }

    const channelName = channels[index][0];
    console.error(
      `${channelName} notification failed: ${result.reason?.stack || result.reason?.message || result.reason}`,
    );

    return [
      new Error(`${channelName} notification failed`, {
        cause: result.reason,
      }),
    ];
  });

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} notification channel(s) failed`,
    );
  }
}

// Places one Bland AI phone call. Optional: skipped unless both BLAND_API_KEY
// and BLAND_PHONE_NUMBER (E.164, e.g. +91...) are set.
export async function placeCall({ speech }) {
  const apiKey = process.env.BLAND_API_KEY;
  const phoneNumber = process.env.BLAND_PHONE_NUMBER;

  if (!apiKey || !phoneNumber) {
    console.warn("Skipping phone call: BLAND_API_KEY or BLAND_PHONE_NUMBER is unset");
    return;
  }

  const response = await fetch("https://api.bland.ai/v1/calls", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phone_number: phoneNumber,
      first_sentence: speech,
      task: `You are a ticket alert. Say this message, repeat it once if asked, then end the call: ${speech}`,
      wait_for_greeting: false,
      max_duration: 1,
    }),
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(`Bland returned HTTP ${response.status} ${response.statusText}: ${responseText}`);
  }
}
