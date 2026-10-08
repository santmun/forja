import { describe, it, expect } from "vitest";
import { parseVectorizeDimensions, vectorizeDimensionIssue } from "../../cli/bin/cli.js";

const INFO_JSON = JSON.stringify({
  dimensions: 768,
  processedUpToDatetime: "2024-07-19T13:11:44.064Z",
  processedUpToMutation: "7f11d6e5-d126-4f76-936e-fbfec079e0be",
  vectorCount: 12,
});

const INFO_TABLE = `
📋 Fetching index info...
┌────────────┬─────────────┬──────────────────────────────────────┬──────────────────────────┐
│ dimensions │ vectorCount │ processedUpToMutation                │ processedUpToDatetime    │
├────────────┼─────────────┼──────────────────────────────────────┼──────────────────────────┤
│ 768        │ 12          │ 7f11d6e5-d126-4f76-936e-fbfec079e0be │ 2024-07-19T13:11:44.064Z │
└────────────┴─────────────┴──────────────────────────────────────┴──────────────────────────┘
`;

describe("parseVectorizeDimensions", () => {
  it("reads dimensions from wrangler vectorize info --json", () => {
    expect(parseVectorizeDimensions(INFO_JSON, "horizontes_bot_kb")).toBe(768);
  });

  it("reads dimensions from the text table", () => {
    expect(parseVectorizeDimensions(INFO_TABLE)).toBe(768);
  });

  it("picks the named index from a list payload", () => {
    const list = JSON.stringify([
      { name: "otro", dimensions: 1536 },
      { name: "horizontes_bot_kb", dimensions: 1024 },
    ]);
    expect(parseVectorizeDimensions(list, "horizontes_bot_kb")).toBe(1024);
  });

  it("returns null when the output has no dimension", () => {
    expect(parseVectorizeDimensions("not logged in")).toBeNull();
  });
});

describe("vectorizeDimensionIssue", () => {
  it("warns when the index is not 1024 and says how to recreate it", () => {
    const issue = vectorizeDimensionIssue(768, "horizontes_bot_kb", "es");
    expect(issue?.message).toContain("768");
    expect(issue?.message).toContain("1024");
    expect(issue?.hint).toContain("--dimensions=1024 --metric=cosine");
    expect(issue?.hint).toContain("horizontes_bot_kb");
  });

  it("stays quiet when the index is already 1024", () => {
    expect(vectorizeDimensionIssue(1024, "horizontes_bot_kb", "es")).toBeNull();
  });

  it("stays quiet when the dimension is unknown", () => {
    expect(vectorizeDimensionIssue(null, "horizontes_bot_kb", "es")).toBeNull();
  });
});
