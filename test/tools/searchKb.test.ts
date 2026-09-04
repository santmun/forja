import { describe, it, expect, vi } from "vitest";
import { searchKbTool } from "../../src/tools/searchKb";

describe("searchKbTool", () => {
  it("returns top-k chunks with scores", async () => {
    const fakeEnv = {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      KB: { query: vi.fn(async () => ({ matches: [
        { id: "c1", score: 0.91, metadata: { title: "Embebar wall", content: "Pega <div data-tv-wall>...</div>" } },
        { id: "c2", score: 0.78, metadata: { title: "Generar carrusel", content: "Ir a Distribuir..." } },
      ] })) },
    } as any;
    const tool = searchKbTool(fakeEnv);
    const execute = tool.execute as (input: { query: string }) => Promise<any>;
    const result = await execute({ query: "como embebo wall" });
    expect(result.results).toHaveLength(2);
    expect(result.results[0].title).toBe("Embebar wall");
    expect(result.results[0].score).toBe(0.91);
  });

  it("requests returnMetadata — without it Vectorize returns a real score but empty title/content", async () => {
    const query = vi.fn(async () => ({ matches: [] }));
    const fakeEnv = {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      KB: { query },
    } as any;
    const tool = searchKbTool(fakeEnv);
    const execute = tool.execute as (input: { query: string }) => Promise<any>;
    await execute({ query: "como embebo wall" });
    expect(query).toHaveBeenCalledWith([0.1, 0.2, 0.3], { topK: 5, returnMetadata: "all" });
  });

  it("returns empty results when KB throws", async () => {
    const fakeEnv = {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) },
      KB: { query: vi.fn(async () => { throw new Error("boom"); }) },
    } as any;
    const tool = searchKbTool(fakeEnv);
    const execute = tool.execute as (input: { query: string }) => Promise<any>;
    const result = await execute({ query: "x" });
    expect(result.error).toBe("transient");
  });
});
