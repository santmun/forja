import { describe, it, expect } from "vitest";
import { formatLlmError, isLikelyRequestOrStreamFailure } from "../../src/llm/errorDetail";

describe("formatLlmError", () => {
  it("incluye status, url y body (lo que wrangler tail suele omitir)", () => {
    const e = Object.assign(new Error("Bad Request"), {
      name: "AI_APICallError",
      statusCode: 400,
      url: "https://api.openai.com/v1/responses",
      responseBody: '{"error":{"message":"Invalid schema for function \\"agendarCita\\""}}',
    });
    const s = formatLlmError(e);
    expect(s).toContain("Bad Request");
    expect(s).toContain("status=400");
    expect(s).toContain("https://api.openai.com/v1/responses");
    expect(s).toContain("Invalid schema for function");
  });

  it("baja al cause cuando el stream envuelve el 400", () => {
    const cause = Object.assign(new Error("Bad Request"), {
      name: "AI_APICallError",
      statusCode: 400,
      responseBody: '{"error":{"message":"strict schema"}}',
    });
    const e = Object.assign(new Error("No output generated. Check the stream for errors."), {
      name: "AI_NoOutputGeneratedError",
      cause,
    });
    const s = formatLlmError(e);
    expect(s).toContain("No output generated");
    expect(s).toContain("status=400");
    expect(s).toContain("strict schema");
    expect(s).toContain("cause=Bad Request");
  });
});

describe("isLikelyRequestOrStreamFailure", () => {
  it("true para 400 y para NoOutputGeneratedError", () => {
    expect(
      isLikelyRequestOrStreamFailure(
        Object.assign(new Error("Bad Request"), { statusCode: 400 }),
      ),
    ).toBe(true);
    expect(
      isLikelyRequestOrStreamFailure(
        Object.assign(new Error("No output generated. Check the stream for errors."), {
          name: "AI_NoOutputGeneratedError",
        }),
      ),
    ).toBe(true);
  });

  it("false para rate-limit / 5xx (van al failover de proveedor)", () => {
    expect(
      isLikelyRequestOrStreamFailure(
        Object.assign(new Error("Too Many Requests"), { statusCode: 429 }),
      ),
    ).toBe(false);
    expect(
      isLikelyRequestOrStreamFailure(
        Object.assign(new Error("Internal Server Error"), { statusCode: 500 }),
      ),
    ).toBe(false);
  });
});
