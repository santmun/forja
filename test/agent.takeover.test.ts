import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const notifyOwnerMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../src/tools/handoffHuman", () => ({
  notifyOwner: (...args: unknown[]) => notifyOwnerMock(...args),
}));

import { SupportAgent } from "../src/agent";
import { ConversationsRepo, OWNER_TAKEOVER_MS } from "../src/db/conversations";
import { SettingsRepo } from "../src/db/settings";

function stubSettings() {
  vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
}

function makeAgent() {
  const storage = { setAlarm: vi.fn(), getAlarm: vi.fn() };
  const env: any = {
    DB: {},
    BOT_TIER: "free",
    BOT_LANGUAGE: "es",
    BUFFER_SECONDS: "8",
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "TestCo",
    DASHBOARD_BASE_URL: "https://dash.test",
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
  return { agent, storage };
}

function stubConversations() {
  let pausedUntil: number | null = null;
  vi.spyOn(ConversationsRepo.prototype, "getOrCreate").mockResolvedValue({
    id: "conv-1",
    paused_until: null,
  } as any);
  vi.spyOn(ConversationsRepo.prototype, "isPaused").mockImplementation(async () => {
    return pausedUntil != null && pausedUntil > Date.now();
  });
  const setPausedUntil = vi
    .spyOn(ConversationsRepo.prototype, "setPausedUntil")
    .mockImplementation(async (_id: string, until: number | null) => {
      pausedUntil = until;
    });
  return {
    setPausedUntil,
    expire: () => {
      pausedUntil = Date.now() - 1;
    },
    getPausedUntil: () => pausedUntil,
  };
}

describe("SupportAgent.ingest — owner takeover cap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    notifyOwnerMock.mockClear();
    stubSettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("first owner message pauses 20 minutes and notifies once", async () => {
    const { agent, storage } = makeAgent();
    const convs = stubConversations();
    const before = Date.now();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "yo lo atiendo",
      isOwnerMessage: true,
    });

    expect(convs.setPausedUntil).toHaveBeenCalledTimes(1);
    const until = convs.setPausedUntil.mock.calls[0][1] as number;
    expect(until).toBeGreaterThanOrEqual(before + OWNER_TAKEOVER_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + OWNER_TAKEOVER_MS);
    expect(until - before).toBeLessThan(60 * 60 * 1000);
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
    const notice = notifyOwnerMock.mock.calls[0][1] as { reason: string; text?: string };
    expect(notice.reason).toBe("dueño en el chat");
    expect(notice.text).toContain("20 minutos");
    expect(storage.setAlarm).not.toHaveBeenCalled();
    expect(agent.state.pendingMessages).toHaveLength(0);
  });

  it("later owner messages extend the 20-min window without a second notify", async () => {
    const { agent, storage } = makeAgent();
    const convs = stubConversations();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "echo 1",
      isOwnerMessage: true,
    });
    const firstUntil = convs.getPausedUntil() ?? 0;

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "echo 2",
      isOwnerMessage: true,
    });

    expect(convs.setPausedUntil).toHaveBeenCalledTimes(2);
    const secondUntil = convs.getPausedUntil() ?? 0;
    expect(secondUntil).toBeGreaterThanOrEqual(firstUntil);
    expect(secondUntil - Date.now()).toBeLessThanOrEqual(OWNER_TAKEOVER_MS);
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("customer messages while paused do not arm the alarm", async () => {
    const { agent, storage } = makeAgent();
    stubConversations();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      isOwnerMessage: true,
    });
    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "hola, ¿siguen ahí?",
    });

    expect(storage.setAlarm).not.toHaveBeenCalled();
    expect(agent.state.pendingMessages).toHaveLength(0);
  });

  it("after the cap expires, a customer message wakes the bot", async () => {
    const { agent, storage } = makeAgent();
    const convs = stubConversations();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      isOwnerMessage: true,
    });
    convs.expire();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "¿hay alguien?",
    });

    expect(storage.setAlarm).toHaveBeenCalled();
    expect(agent.state.pendingMessages).toHaveLength(1);
    expect(agent.state.pendingMessages[0].text).toBe("¿hay alguien?");
  });

  it("a new owner message after expiry is a new takeover and notifies again", async () => {
    const { agent } = makeAgent();
    const convs = stubConversations();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      isOwnerMessage: true,
    });
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
    convs.expire();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u1",
      text: "vuelvo a entrar",
      isOwnerMessage: true,
    });
    expect(notifyOwnerMock).toHaveBeenCalledTimes(2);
    expect(convs.setPausedUntil).toHaveBeenCalledTimes(2);
  });
});
