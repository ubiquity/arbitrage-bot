interface Environment {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ARBITRAGE_BOT_URL?: string;
  ARBITRAGE_BOT_TOKEN?: string;
}

function jsonResponse(body: Record<string, string>, status: number, headers: Headers): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/arbitrage") {
      return env.ASSETS.fetch(request);
    }

    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin && origin !== "https://uusd.ubq.fi") {
      return jsonResponse({ error: "Origin not allowed" }, 403, headers);
    }
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
    }

    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      headers.set("Allow", "POST, OPTIONS");
      return jsonResponse({ error: "Method not allowed" }, 405, headers);
    }

    let botUrl: URL;
    try {
      botUrl = new URL(env.ARBITRAGE_BOT_URL ?? "");
      if (botUrl.protocol !== "https:") {
        throw new Error("The bot URL must use HTTPS");
      }
    } catch {
      return jsonResponse({ error: "Arbitrage bot is not configured" }, 503, headers);
    }

    const botHeaders = new Headers({ Accept: "application/json" });
    if (env.ARBITRAGE_BOT_TOKEN) {
      botHeaders.set("Authorization", `Bearer ${env.ARBITRAGE_BOT_TOKEN}`);
    }
    try {
      const result = await fetch(botUrl, { method: "POST", headers: botHeaders, redirect: "error" });
      if (!result.ok) {
        throw new Error("Bot trigger failed");
      }
      return jsonResponse({ status: "triggered" }, 200, headers);
    } catch {
      return jsonResponse({ error: "Unable to trigger arbitrage bot" }, 502, headers);
    }
  },
};
