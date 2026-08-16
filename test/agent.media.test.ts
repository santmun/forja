import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `SupportAgent` extends `Agent` from the `agents` SDK, which (via
// `partyserver`) imports the virtual `cloudflare:workers` module at load time —
// Node's ESM loader can't resolve the `cloudflare:` scheme outside workerd.
// Mock the `agents` package (same pattern as test/index.test.ts) so the import
// graph stays in Node-land. The base class accepts (ctx, env) and stashes them,
// so we can instantiate SupportAgent via `new` — this runs the class field
// initializers, including the arrow-function `alarm` field (which is NOT on the
// prototype and would be undefined under Object.create()).
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
    // Tagged-template stub: ingest() upserts into cf_agents_schedules via this.sql
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

// resolveAgentConfig() (used by both ingest() and alarm()) reads the D1
// `settings` table via SettingsRepo. These tests run against a fake env.DB ({}),
// so stub the repo to return no overrides → all config falls back to env/defaults
// (bot not paused, BUFFER_SECONDS-derived buffer, maxChunks=3, delay=1000ms,
// modelOverride="auto"). Call AFTER vi.restoreAllMocks() in each beforeEach.
function stubSettings(overrides: Record<string, string> = {}) {
  vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue(overrides);
}

// Task 6.3: voice transcription + image input wired into ingest()/alarm().
// All media + LLM calls are mocked — no real network to Workers AI or Anthropic.
// Audio: the REAL transcribeAudio runs but hits a fake env.AI + stubbed fetch
// (same no-network pattern as test/media/transcribe.test.ts), so the dynamic
// import("./media/transcribe") inside ingest() resolves to the real module.

const streamTextMock = vi.fn();

vi.mock("ai", () => ({
  streamText: (...args: any[]) => streamTextMock(...args),
  tool: (def: any) => def,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

function makeStreamResult(text: string) {
  async function* gen() {
    yield text;
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

function makeAgent(opts?: { tier?: "free" | "pro"; aiText?: string }) {
  const storage = { setAlarm: vi.fn(), getAlarm: vi.fn() };

  const env: any = {
    DB: {},
    AI: { run: vi.fn(async () => ({ text: opts?.aiText ?? "" })) },
    ANTHROPIC_API_KEY: "sk-test",
    BOT_TIER: opts?.tier ?? "free",
    BOT_LANGUAGE: "es",
    BUFFER_SECONDS: "8",
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "TestCo",
  };

  // Instantiate via the constructor so class field initializers run — this is
  // what makes the arrow-function `alarm` field exist on the instance.
  // `setState` lives on the mocked base `Agent` prototype.
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

function stubConversations(opts?: { paused?: boolean }) {
  vi.spyOn(ConversationsRepo.prototype, "getOrCreate").mockResolvedValue({
    id: "conv-1",
    paused_until: null,
  } as any);
  vi.spyOn(ConversationsRepo.prototype, "isPaused").mockResolvedValue(
    opts?.paused ?? false,
  );
}

describe("SupportAgent.ingest — media (Task 6.3)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    stubSettings();
    originalFetch = globalThis.fetch;
    // Audio download is stubbed: transcribeAudio fetches the audioUrl then
    // hands bytes to env.AI.run — neither touches the real network.
    globalThis.fetch = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3])),
    ) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("transcribes audio and buffers it as text", async () => {
    const { agent } = makeAgent({ aiText: "hola desde un audio" });
    stubConversations();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      audioUrl: "https://example.com/voice.ogg",
    });

    expect(agent.env.AI.run).toHaveBeenCalled();
    expect(agent.state.pendingMessages).toHaveLength(1);
    expect(agent.state.pendingMessages[0].text).toBe("hola desde un audio");
  });

  it("falls back to a friendly message when transcription throws", async () => {
    const { agent } = makeAgent();
    stubConversations();
    // Make the audio fetch fail → transcribeAudio throws → ingest catches it.
    (globalThis.fetch as any).mockRejectedValueOnce(new Error("network down"));

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      audioUrl: "https://example.com/voice.ogg",
    });

    expect(agent.state.pendingMessages[0].text).toBe(
      "(no pude entender el audio)",
    );
  });

  it("free tier: strips the image and informs the bot it's unsupported", async () => {
    const { agent } = makeAgent({ tier: "free" });
    stubConversations();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "mira esto",
      imageUrl: "https://example.com/pic.png",
    });

    const buffered = agent.state.pendingMessages[0].text;
    expect(buffered).toContain("mira esto");
    expect(buffered).toContain("no soporta análisis de imágenes");
    expect(buffered).not.toContain("IMAGE_URL");
  });

  it("pro tier: keeps the image as an [IMAGE_URL] marker in the buffer", async () => {
    const { agent } = makeAgent({ tier: "pro" });
    stubConversations();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "describe esta foto",
      imageUrl: "https://example.com/pic.png",
    });

    const buffered = agent.state.pendingMessages[0].text;
    expect(buffered).toContain("describe esta foto");
    expect(buffered).toContain("[IMAGE_URL: https://example.com/pic.png]");
    expect(agent.state.imageRetryCount).toBe(0);
  });
});

describe("SupportAgent.alarm — multimodal last message (Task 6.3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubSettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runAlarm(opts: { tier: "free" | "pro"; lastContent: string }) {
    const { agent } = makeAgent({ tier: opts.tier });

    // Fresh stream result per call (the async generator is one-shot).
    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => makeStreamResult("ok"));

    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "mensaje previo" },
      { role: "assistant", content: "respuesta previa" },
      { role: "user", content: opts.lastContent },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: vi.fn(async () => {}),
    } as any);

    // Seed buffer so alarm processes
    agent.state.pendingMessages = [
      { text: opts.lastContent, receivedAt: Date.now() },
    ];

    await agent.processBuffer();
    return streamTextMock.mock.calls[0][0].messages;
  }

  it("pro tier: builds a multimodal message from the [IMAGE_URL] marker", async () => {
    const messages = await runAlarm({
      tier: "pro",
      lastContent: "describe esto\n[IMAGE_URL: https://example.com/pic.png]",
    });

    const last = messages[messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content).toEqual([
      { type: "image", image: new URL("https://example.com/pic.png") },
      { type: "text", text: "describe esto" },
    ]);
  });

  it("free tier: leaves the last message as plain text (no multimodal build)", async () => {
    const messages = await runAlarm({
      tier: "free",
      lastContent: "hola normal",
    });

    const last = messages[messages.length - 1];
    expect(last).toEqual({ role: "user", content: "hola normal" });
  });

  it("caches the system prompt as a SystemModelMessage with an ephemeral breakpoint", async () => {
    const { agent } = makeAgent({ tier: "free" });

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => makeStreamResult("ok"));

    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "hola" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: vi.fn(async () => {}),
    } as any);

    agent.state.pendingMessages = [{ text: "hola", receivedAt: Date.now() }];
    await agent.processBuffer();

    const arg = streamTextMock.mock.calls[0][0];
    expect(Array.isArray(arg.system)).toBe(true);
    expect(arg.system).toHaveLength(1);
    expect(arg.system[0].role).toBe("system");
    expect(typeof arg.system[0].content).toBe("string");
    expect(arg.system[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("honors model_override=sonnet from settings", async () => {
    stubSettings({ model_override: "sonnet" });
    const { agent } = makeAgent({ tier: "free" });

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => makeStreamResult("ok"));

    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "hola" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: vi.fn(async () => {}),
    } as any);

    agent.state.pendingMessages = [{ text: "hola", receivedAt: Date.now() }];
    await agent.processBuffer();

    const arg = streamTextMock.mock.calls[0][0];
    expect(arg.model).toEqual({ modelId: "claude-sonnet-4-5-20250929" });
  });
});

describe("SupportAgent.ingest — bot_paused (settings)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("buffers the client message but does NOT arm the alarm when bot_paused=1", async () => {
    stubSettings({ bot_paused: "1" });
    const { agent, storage } = makeAgent({ tier: "free" });
    stubConversations();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "hola, estoy pausado?",
    });

    // Message is persisted in the buffer …
    expect(agent.state.pendingMessages).toHaveLength(1);
    expect(agent.state.pendingMessages[0].text).toBe("hola, estoy pausado?");
    // … but the bot stays silent: no alarm scheduled.
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("arms the alarm when bot is not paused", async () => {
    stubSettings();
    const { agent, storage } = makeAgent({ tier: "free" });
    stubConversations();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "hola",
    });

    expect(storage.setAlarm).toHaveBeenCalledTimes(1);
  });

  it("re-arms the alarm when it did not get registered", async () => {
    stubSettings();
    const { agent, storage } = makeAgent({ tier: "free" });
    stubConversations();
    // The platform silently dropped the alarm: nothing is armed afterwards.
    storage.getAlarm.mockResolvedValue(null);

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "hola",
    });

    expect(storage.setAlarm).toHaveBeenCalledTimes(2);
  });

  it("processes almost immediately when a buffered message is stranded", async () => {
    stubSettings();
    const { agent, storage } = makeAgent({ tier: "free" });
    stubConversations();
    // A previous message never got processed because its alarm was lost.
    agent.setState({
      ...agent.state,
      pendingMessages: [{ text: "hola", receivedAt: Date.now() - 600_000 }],
    });

    const before = Date.now();
    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "hola?",
    });

    const alarmAt = storage.setAlarm.mock.calls[0][0];
    expect(alarmAt - before).toBeLessThan(2_000);
  });
});
