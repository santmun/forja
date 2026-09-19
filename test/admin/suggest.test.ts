/**
 * Tests for the co-pilot suggestion endpoint (Task 9.3).
 *
 * POST /conversations/:id/suggest returns an HTML fragment (HTMX) with a
 * suggested reply for the owner to copy/paste — it never sends anything to the
 * customer. The route is guarded by the admin Basic Auth wildcard middleware.
 *
 * No real network: the Anthropic provider (`@ai-sdk/anthropic`) and the AI SDK
 * `generateText` call are both mocked, as is the MessagesRepo (so no D1 needed)
 * and the business-context loader (so no `member/config.local` import chain).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks (must be declared before importing the route module) -------------

const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  // createAnthropic returns a factory; calling it with a model id returns an
  // opaque "model" object that generateText (mocked) never actually uses.
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

// Avoid the businessContext -> member/config.local import chain in tests.
vi.mock("../../src/businessContext", () => ({
  renderBusinessContext: () => "CONTEXTO DE NEGOCIO DE PRUEBA",
}));

// Mock the messages repo so we don't need a real D1 binding.
const lastNMock = vi.fn();
vi.mock("../../src/db/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/messages")>();
  return {
    ...actual,
    MessagesRepo: class {
      constructor(_db: unknown) {}
      lastN(id: string, n: number) {
        return lastNMock(id, n);
      }
    },
  };
});

import { adminApp } from "../../src/admin/routes";
import type { Env } from "../../src/env";

// --- Test env ---------------------------------------------------------------

const PASSWORD = "secret123";

function makeEnv(): Env {
  return {
    DB: {} as any, // unused: MessagesRepo is mocked, Db just stashes the binding
    ANTHROPIC_API_KEY: "sk-test",
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "Negocio de Prueba",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "5",
    DASHBOARD_BASE_URL: "https://example.com",
    DASHBOARD_PASSWORD: PASSWORD,
    OWNER_EMAIL: "owner@example.com",
  } as unknown as Env;
}

function basicAuthHeader(user: string, pass: string): string {
  const raw = `${user}:${pass}`;
  const b64 =
    typeof btoa === "function"
      ? btoa(raw)
      : Buffer.from(raw, "utf-8").toString("base64");
  return `Basic ${b64}`;
}

describe("admin co-pilot suggestion endpoint", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    lastNMock.mockReset();
    lastNMock.mockResolvedValue([
      { role: "user", content: "Hola, ¿tienen disponibilidad mañana?" },
      { role: "assistant", content: "Déjame revisar." },
    ]);
    generateTextMock.mockResolvedValue({
      text: "Claro, tenemos espacio mañana a las 3pm. ¿Te reservo?",
    });
  });

  it("returns 200 with the suggestion fragment when authenticated", async () => {
    const res = await adminApp.request(
      "/conversations/conv-1/suggest",
      { method: "POST", headers: { Authorization: basicAuthHeader("admin", PASSWORD) } },
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sugerencia del co-pilot");
    expect(html).toContain("Claro, tenemos espacio mañana a las 3pm. ¿Te reservo?");

    // It pulled the recent history and called the LLM exactly once.
    expect(lastNMock).toHaveBeenCalledWith("conv-1", 20);
    expect(generateTextMock).toHaveBeenCalledTimes(1);

    // The LLM call carried the conversation history plus the owner instruction,
    // and a non-empty system prompt.
    const callArg = generateTextMock.mock.calls[0][0] as {
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(typeof callArg.system).toBe("string");
    expect(callArg.system.length).toBeGreaterThan(0);
    const last = callArg.messages[callArg.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("asistente del dueño");
  });

  it("omite filas vacías del historial antes de llamar al LLM", async () => {
    lastNMock.mockResolvedValue([
      { role: "user", content: "Hola" },
      { role: "assistant", content: "" },
      { role: "user", content: "¿siguen ahí?" },
    ]);

    const res = await adminApp.request(
      "/conversations/conv-1/suggest",
      { method: "POST", headers: { Authorization: basicAuthHeader("admin", PASSWORD) } },
      makeEnv(),
    );
    expect(res.status).toBe(200);

    const callArg = generateTextMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(callArg.messages.map((m) => m.content)).toEqual([
      "Hola",
      "¿siguen ahí?",
      expect.stringContaining("asistente del dueño"),
    ]);
  });

  it("escapes HTML in the LLM output (no injection)", async () => {
    generateTextMock.mockResolvedValue({ text: "<script>alert(1)</script>" });
    const res = await adminApp.request(
      "/conversations/conv-2/suggest",
      { method: "POST", headers: { Authorization: basicAuthHeader("admin", PASSWORD) } },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns 401 without auth", async () => {
    const res = await adminApp.request(
      "/conversations/conv-1/suggest",
      { method: "POST" },
      makeEnv(),
    );
    expect(res.status).toBe(401);
    // The LLM is never reached when auth fails.
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("returns 401 with a wrong password", async () => {
    const res = await adminApp.request(
      "/conversations/conv-1/suggest",
      { method: "POST", headers: { Authorization: basicAuthHeader("admin", "wrong") } },
      makeEnv(),
    );
    expect(res.status).toBe(401);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
