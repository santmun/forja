import { describe, it, expect, vi, beforeEach } from "vitest";

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

import { joinStepTexts, runLlmTurn } from "../../src/llm/runTurn";

function streamOk(text: string) {
  async function* gen() {
    yield text;
  }
  return {
    textStream: gen(),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 0 }),
    steps: Promise.resolve([{ toolCalls: [] }]),
  };
}

const ARGS = {
  model: { id: "gpt-4o" },
  system: [{ role: "system" as const, content: "hola" }],
  messages: [{ role: "user" as const, content: "hola" }],
  tools: { searchKb: {} },
  stopWhen: ({ steps }: { steps: any[] }) => steps.length >= 6,
};

describe("runLlmTurn", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
  });

  it("usa streamText cuando el stream produce texto", async () => {
    streamTextMock.mockImplementation(() => streamOk("buen día"));
    const r = await runLlmTurn(ARGS);
    expect(r.text).toBe("buen día");
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(streamTextMock.mock.calls[0][0].tools).toEqual({ searchKb: {} });
  });

  it("si streamText da 400 / NoOutput, reintenta con generateText (sin SSE)", async () => {
    const streamErr = Object.assign(new Error("No output generated. Check the stream for errors."), {
      name: "AI_NoOutputGeneratedError",
      cause: Object.assign(new Error("Bad Request"), {
        name: "AI_APICallError",
        statusCode: 400,
        url: "https://api.openai.com/v1/responses",
        responseBody: '{"error":{"message":"Invalid schema"}}',
      }),
    });
    streamTextMock.mockImplementation(() => {
      throw streamErr;
    });
    generateTextMock.mockResolvedValue({
      text: "hola, ¿en qué te ayudo?",
      usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 0 },
      steps: [{ toolCalls: [{ toolName: "searchKb", input: { query: "hola" } }] }],
    });

    const r = await runLlmTurn(ARGS);
    expect(r.text).toBe("hola, ¿en qué te ayudo?");
    expect(r.toolCallCount).toBe(1);
    expect(r.toolCallsMade).toEqual([{ toolName: "searchKb", input: { query: "hola" } }]);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0][0].messages).toEqual(ARGS.messages);
  });

  it("separa con una línea en blanco el texto de antes y después de una tool", async () => {
    async function* gen() {
      yield "…el nuevo horario 💛";
      yield "Ya quedó anotado";
    }
    streamTextMock.mockImplementation(() => ({
      textStream: gen(),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 0 }),
      steps: Promise.resolve([
        { text: "…el nuevo horario 💛", toolCalls: [{ toolName: "captureLead", input: {} }] },
        { text: "Ya quedó anotado", toolCalls: [] },
      ]),
    }));
    const r = await runLlmTurn(ARGS);
    expect(r.text).toBe("…el nuevo horario 💛\n\nYa quedó anotado");
    expect(r.text).not.toContain("💛Ya");
  });

  it("un solo paso de texto se deja igual", async () => {
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () {
        yield "buen día";
      })(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }),
      steps: Promise.resolve([{ text: "buen día", toolCalls: [] }]),
    }));
    const r = await runLlmTurn(ARGS);
    expect(r.text).toBe("buen día");
  });

  it("no usa generateText en un 429 — eso es failover de proveedor", async () => {
    streamTextMock.mockImplementation(() => {
      throw Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    });
    await expect(runLlmTurn(ARGS)).rejects.toThrow(/Too Many Requests/);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("joinStepTexts", () => {
  it("separa texto que quedó a los dos lados de una tool en el mismo paso", () => {
    const joined = joinStepTexts([
      {
        content: [
          { type: "text", text: "…el nuevo horario 💛" },
          { type: "tool-call", toolName: "captureLead" },
          { type: "text", text: "Ya quedó anotado" },
        ],
      },
    ]);
    expect(joined).toBe("…el nuevo horario 💛\n\nYa quedó anotado");
  });

  it("ignora pasos que solo ejecutaron una tool", () => {
    expect(
      joinStepTexts([
        { text: "listo" },
        { text: "   ", toolCalls: [{ toolName: "searchKb" }] },
      ]),
    ).toBeNull();
  });
});
