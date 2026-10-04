import { describe, it, expect } from "vitest";
import { webAdapter } from "../../src/channels/web";

function req(body: unknown): Request {
  return new Request("https://bot.test/demo/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("webAdapter", () => {
  it("normaliza sessionId y texto", async () => {
    const msg = await webAdapter.parseIncoming(
      req({ sessionId: "abc-123", text: "  hola  ", name: "Ana" }),
      {} as any,
    );
    expect(msg.channel).toBe("web");
    expect(msg.channelUserId).toBe("abc-123");
    expect(msg.text).toBe("hola");
    expect(msg.displayName).toBe("Ana");
  });

  it("rechaza un envío vacío", async () => {
    await expect(webAdapter.parseIncoming(req({ sessionId: "", text: "hola" }), {} as any))
      .rejects.toThrow(/sessionId/);
  });

  it("sendReply no llama a nadie", async () => {
    await expect(webAdapter.sendReply({
      channel: "web",
      channelUserId: "s",
      chunks: ["uno", "dos"],
    }, {} as any)).resolves.toBeUndefined();
  });
});
