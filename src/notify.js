async function postNtfy({ title, message, url }) {
  const topic = process.env.NTFY_TOPIC;

  if (!topic) {
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
    console.warn(
      "Skipping Telegram notification: TELEGRAM_BOT_TOKEN is unset or no TELEGRAM_CHAT_ID chat ids are configured",
    );
    return;
  }

  const text = `${title}\n\n${message}${url ? `\n${url}` : ""}`;
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
        console.error(
          `Telegram notification failed for chat_id ${chatId}: HTTP ${response.status} ${response.statusText}: ${responseText}`,
        );
      }
    } catch (error) {
      console.error(
        `Telegram notification failed for chat_id ${chatId}: ${error?.stack || error?.message || error}`,
      );
    }
  }
}

async function attempt(channelName, send) {
  try {
    await send();
  } catch (error) {
    console.error(
      `${channelName} notification failed: ${error?.stack || error?.message || error}`,
    );
  }
}

export async function notify({ title, message, url }) {
  await Promise.all([
    attempt("ntfy", () => postNtfy({ title, message, url })),
    attempt("Telegram", () => postTelegram({ title, message, url })),
  ]);
}
