import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mismo patrón que test/agent.media.test.ts: `SupportAgent` extiende `Agent` del
// SDK `agents`, que importa el módulo virtual `cloudflare:workers` al cargarse y
// Node no sabe resolver fuera de workerd. Se mockea para que el grafo de imports
// se quede en Node-land.
vi.mock("agents", () => ({
  Agent: class {
    ctx: any;
    env: any;
    state: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    setState(s: any) {
      this.state = s;
    }
    sql(..._args: any[]) {
      return undefined;
    }
  },
}));

import { SupportAgent } from "../src/agent";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";
import { SettingsRepo } from "../src/db/settings";
import * as senderMod from "../src/replies/sender";

const FALLBACK = "Algo falló de mi lado, intenta de nuevo en un momento.";

const streamTextMock = vi.fn();

vi.mock("ai", () => ({
  streamText: (...args: any[]) => streamTextMock(...args),
  tool: (def: any) => def,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

/** Resultado de streamText que emite `text` (cadena vacía = error a mitad del stream). */
function makeStreamResult(text: string) {
  async function* gen() {
    if (text) yield text;
  }
  return {
    textStream: gen(),
    usage: Promise.resolve({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
    }),
    steps: Promise.resolve([{ toolCalls: [] }]),
  };
}

function makeAgent() {
  const storage = { setAlarm: vi.fn(), getAlarm: vi.fn() };

  const env: any = {
    DB: {},
    AI: { run: vi.fn(async () => ({ text: "" })) },
    ANTHROPIC_API_KEY: "sk-test",
    BOT_TIER: "free",
    BOT_LANGUAGE: "es",
    BUFFER_SECONDS: "8",
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "TestCo",
  };

  const agent: any = new (SupportAgent as any)({ storage }, env);
  agent.setState({
    conversationId: "conv-1",
    channel: "telegram",
    channelUserId: "u1",
    pendingMessages: [],
    lastAlarmAt: 0,
    lastUserLang: "es",
    toolCallsInLast2Turns: 0,
    lastSearchKbScore: 1,
    imageRetryCount: 0,
  });

  return { agent, env, storage };
}

/**
 * Regresión: un error del proveedor a MITAD del stream no llega como excepción —
 * `textStream` simplemente termina vacío. Antes del fix, el turno se daba por
 * bueno y el cliente recibía un mensaje EN BLANCO.
 */
describe("SupportAgent.processBuffer — stream sin texto", () => {
  let appendSpy: any;
  let sendReply: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});

    appendSpy = vi
      .spyOn(MessagesRepo.prototype, "append")
      .mockResolvedValue(undefined as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "¿cuánto cuesta el servicio?" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "getOrCreate").mockResolvedValue({
      id: "conv-1",
      paused_until: null,
    } as any);
    vi.spyOn(ConversationsRepo.prototype, "isPaused").mockResolvedValue(false);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );

    sendReply = vi.fn(async () => {});
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({ sendReply } as any);

    streamTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function correrTurno() {
    const { agent } = makeAgent();
    agent.state.pendingMessages = [
      { text: "¿cuánto cuesta el servicio?", receivedAt: Date.now() },
    ];
    await agent.processBuffer();
    return agent;
  }

  it("no persiste un mensaje vacío cuando el stream termina sin texto", async () => {
    // Todos los intentos (primario, reintento y alterno) devuelven vacío.
    streamTextMock.mockImplementation(() => makeStreamResult(""));

    await correrTurno();

    expect(appendSpy).toHaveBeenCalled();
    const guardados = appendSpy.mock.calls
      .filter((c: any[]) => c[1] === "assistant")
      .map((c: any[]) => c[2] as string);

    expect(guardados.length).toBeGreaterThan(0);
    for (const texto of guardados) {
      expect(texto.trim()).not.toBe("");
    }
    expect(guardados[guardados.length - 1]).toBe(FALLBACK);
  });

  it("no envía un mensaje vacío al cliente", async () => {
    streamTextMock.mockImplementation(() => makeStreamResult(""));

    await correrTurno();

    expect(sendReply).toHaveBeenCalled();
    for (const call of sendReply.mock.calls) {
      const enviado = JSON.stringify(call);
      expect(enviado).not.toMatch(/"\s*"/);
    }
  });

  it("el guard activa el failover: se reintenta en vez de darse por bueno", async () => {
    streamTextMock.mockImplementation(() => makeStreamResult(""));

    await correrTurno();

    // Sin el guard, streamText se llamaba UNA vez y el turno terminaba feliz.
    expect(streamTextMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("un turno normal con texto no se ve afectado", async () => {
    streamTextMock.mockImplementation(() => makeStreamResult("claro, con gusto"));

    await correrTurno();

    const guardados = appendSpy.mock.calls
      .filter((c: any[]) => c[1] === "assistant")
      .map((c: any[]) => c[2] as string);

    expect(guardados).toContain("claro, con gusto");
    expect(streamTextMock.mock.calls.length).toBe(1);
  });
});
