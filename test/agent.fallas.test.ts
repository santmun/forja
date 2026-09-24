import { describe, it, expect, vi, beforeEach } from "vitest";

// Cuando la IA falla, el bot no deja al cliente en seco:
//  1. Turno con FOTO que ningún modelo pudo abrir → reintento con puro texto.
//  2. Falla total → respuesta con tono humano (no "Algo falló de mi lado") y
//     aviso INMEDIATO al dueño con quién se quedó esperando.
// Mismo harness que test/agent.media.test.ts (agents/ai mockeados, sin red).

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

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  streamText: (...args: any[]) => streamTextMock(...args),
  generateText: (...args: any[]) => generateTextMock(...args),
  tool: (def: any) => def,
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

const notifyOwnerMock = vi.fn(async () => {});
vi.mock("../src/tools/handoffHuman", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/handoffHuman")>()),
  notifyOwner: (...args: any[]) => (notifyOwnerMock as any)(...args),
}));

import { SupportAgent } from "../src/agent";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";
import { SettingsRepo } from "../src/db/settings";
import * as senderMod from "../src/replies/sender";
import { LLM_FAILURE_REPLIES } from "../src/failureReply";

function okResult(text: string) {
  async function* gen() {
    yield text;
  }
  return {
    textStream: gen(),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }),
    steps: Promise.resolve([{ toolCalls: [] }]),
  };
}

const lastIsImage = (args: any) => Array.isArray(args?.messages?.at(-1)?.content);

function makeAgent() {
  const env: any = {
    DB: {},
    AI: { run: vi.fn(async () => ({ text: "" })) },
    ANTHROPIC_API_KEY: "sk-test",
    BOT_TIER: "pro",
    BOT_LANGUAGE: "es",
    BUFFER_SECONDS: "8",
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "TestCo",
  };
  const agent: any = new (SupportAgent as any)({ storage: { setAlarm: vi.fn(), getAlarm: vi.fn() } }, env);
  agent.setState({
    conversationId: "conv-1",
    channel: "telegram",
    channelUserId: "5215512345678",
    pendingMessages: [],
    lastAlarmAt: 0,
    lastUserLang: "es",
    toolCallsInLast2Turns: 0,
    lastSearchKbScore: 1,
    imageRetryCount: 0,
  });
  return agent;
}

function stubTurn(lastUserContent: string) {
  const sendReply = vi.fn(async () => {});
  vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
  vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue(undefined as any);
  vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
    { role: "user", content: lastUserContent },
  ] as any);
  vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(undefined as any);
  vi.spyOn(senderMod, "pickAdapter").mockReturnValue({ sendReply } as any);
  return sendReply;
}

const sentText = (sendReply: any) =>
  ((sendReply.mock.calls.at(-1)?.at(0) as { chunks: string[] } | undefined)?.chunks ?? []).join(" ").replace(/\s+/g, " ");

describe("el bot no deja al cliente en seco cuando la IA falla", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    streamTextMock.mockReset();
    generateTextMock.mockReset();
    notifyOwnerMock.mockClear();
  });

  it("foto que ningún modelo pudo abrir → sigue la conversación con puro texto", async () => {
    const agent = makeAgent();
    const sendReply = stubTurn(
      "Me gustaría información de esta propiedad\n[IMAGE_URL: https://example.com/lona.jpg]",
    );
    // Con la foto adjunta todo revienta (p. ej. la imagen no se pudo descargar);
    // con puro texto el modelo contesta normal.
    const fail = () => {
      throw Object.assign(new Error("Error while downloading https://example.com/lona.jpg"), {
        name: "AI_APICallError",
        statusCode: 400,
      });
    };
    streamTextMock.mockImplementation((args: any) =>
      lastIsImage(args) ? fail() : okResult("¡Claro! ¿Me dices dónde viste el anuncio?"),
    );
    generateTextMock.mockImplementation(async (args: any) =>
      lastIsImage(args) ? fail() : { text: "¡Claro! ¿Me dices dónde viste el anuncio?", usage: {}, steps: [] },
    );

    agent.state.pendingMessages = [{ text: "Me gustaría información", receivedAt: Date.now() }];
    await agent.processBuffer();

    const reintento = [...streamTextMock.mock.calls, ...generateTextMock.mock.calls]
      .map((c) => c[0])
      .find((a) => !lastIsImage(a));
    expect(reintento.messages.at(-1).content).toContain("Me gustaría información de esta propiedad");
    expect(reintento.messages.at(-1).content).toContain("FOTO que no pudiste abrir");
    expect(sentText(sendReply)).toContain("¿Me dices dónde viste el anuncio?");
    expect(notifyOwnerMock).not.toHaveBeenCalled();
  }, 20_000);

  it("falla total → respuesta humana + aviso inmediato al dueño", async () => {
    const agent = makeAgent();
    const sendReply = stubTurn("Hola, ¿cuánto cuesta?");
    const boom = () => {
      throw Object.assign(new Error("rate limit"), { name: "AI_APICallError", statusCode: 429 });
    };
    streamTextMock.mockImplementation(boom);
    generateTextMock.mockImplementation(async () => boom());

    agent.state.pendingMessages = [{ text: "Hola, ¿cuánto cuesta?", receivedAt: Date.now() }];
    await agent.processBuffer();

    expect(sentText(sendReply)).toBe(LLM_FAILURE_REPLIES.es);
    expect(sentText(sendReply)).not.toMatch(/Algo falló/);
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
    const [, notice] = notifyOwnerMock.mock.calls[0] as unknown as [unknown, { reason: string; summary: string }];
    expect(notice.reason).toBe("el bot no pudo responder");
    expect(notice.summary).toContain("5215512345678");
    expect(notice.summary).toContain("Hola, ¿cuánto cuesta?");
  }, 20_000);
});
