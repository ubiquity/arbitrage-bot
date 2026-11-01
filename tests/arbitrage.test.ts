import { afterEach, describe, expect, it, jest } from "@jest/globals";
import worker from "../src/worker";

const corsOriginHeader = "Access-Control-Allow-Origin";

function createEnvironment(): Parameters<typeof worker.fetch>[1] {
  return {
    ASSETS: { fetch: jest.fn<(request: Request) => Promise<Response>>().mockResolvedValue(new Response("static asset")) },
    ARBITRAGE_BOT_URL: "https://bot.example.com/run",
    ARBITRAGE_BOT_TOKEN: "test-only-token",
  };
}

function createRequest(method = "POST", origin = "https://uusd.ubq.fi"): Request {
  return new Request("https://arbitrage.example.com/api/arbitrage", { method, headers: { Origin: origin } });
}

function mockBot() {
  return jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
}

afterEach(() => jest.restoreAllMocks());

describe("Arbitrage endpoint", () => {
  it("triggers the configured bot once and returns an uncached JSON response", async () => {
    const bot = mockBot();
    const env = createEnvironment();
    const response = await worker.fetch(createRequest(), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "triggered" });
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get(corsOriginHeader)).toBe("https://uusd.ubq.fi");
    expect(bot).toHaveBeenCalledTimes(1);
    expect(bot).toHaveBeenCalledWith(new URL(env.ARBITRAGE_BOT_URL ?? ""), {
      method: "POST",
      headers: new Headers({ Accept: "application/json", Authorization: "Bearer test-only-token" }),
      redirect: "error",
    });
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("allows same-origin UI requests and an upstream without authentication", async () => {
    const bot = mockBot();
    const env = createEnvironment();
    delete env.ARBITRAGE_BOT_TOKEN;
    const response = await worker.fetch(createRequest("POST", "https://arbitrage.example.com"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get(corsOriginHeader)).toBe("https://arbitrage.example.com");
    expect(new Headers(bot.mock.calls[0][1]?.headers).has("Authorization")).toBe(false);
  });

  it("accepts non-browser POST requests", async () => {
    const bot = mockBot();
    const request = new Request("https://arbitrage.example.com/api/arbitrage", { method: "POST" });
    const response = await worker.fetch(request, createEnvironment());

    expect(response.status).toBe(200);
    expect(response.headers.has(corsOriginHeader)).toBe(false);
    expect(bot).toHaveBeenCalledTimes(1);
  });

  it.each(["GET", "HEAD", "PUT", "DELETE"])("rejects %s without triggering the bot", async (method) => {
    const bot = mockBot();
    const response = await worker.fetch(createRequest(method), createEnvironment());

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
    expect(bot).not.toHaveBeenCalled();
  });

  it("handles browser preflight without requiring configuration or triggering the bot", async () => {
    const bot = mockBot();
    const env = createEnvironment();
    delete env.ARBITRAGE_BOT_URL;
    const response = await worker.fetch(createRequest("OPTIONS"), env);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(await response.text()).toBe("");
    expect(bot).not.toHaveBeenCalled();
  });

  it("rejects other browser origins before triggering the bot", async () => {
    const bot = mockBot();
    const response = await worker.fetch(createRequest("POST", "https://other.example.com"), createEnvironment());

    expect(response.status).toBe(403);
    expect(response.headers.has(corsOriginHeader)).toBe(false);
    expect(bot).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "invalid-url", "http://bot.example.com/run"])("fails closed for invalid bot configuration: %s", async (url) => {
    const bot = mockBot();
    const env = createEnvironment();
    env.ARBITRAGE_BOT_URL = url;
    const response = await worker.fetch(createRequest(), env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Arbitrage bot is not configured" });
    expect(bot).not.toHaveBeenCalled();
  });

  it.each([400, 429, 500])("reports upstream HTTP %s as a gateway error", async (status) => {
    mockBot().mockResolvedValue(new Response("private upstream details", { status }));
    const response = await worker.fetch(createRequest(), createEnvironment());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Unable to trigger arbitrage bot" });
  });

  it("handles network failures without leaking details or retrying the trade", async () => {
    const bot = mockBot().mockRejectedValue(new Error("private upstream details"));
    const response = await worker.fetch(createRequest(), createEnvironment());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Unable to trigger arbitrage bot" });
    expect(bot).toHaveBeenCalledTimes(1);
  });

  it("serves static pages without triggering the bot", async () => {
    const bot = mockBot();
    const env = createEnvironment();
    const request = new Request("https://arbitrage.example.com/");
    const response = await worker.fetch(request, env);

    expect(await response.text()).toBe("static asset");
    expect(env.ASSETS.fetch).toHaveBeenCalledWith(request);
    expect(bot).not.toHaveBeenCalled();
  });
});
