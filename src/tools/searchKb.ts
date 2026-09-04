import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";

export interface SearchKbResult {
  title: string;
  content: string;
  score: number;
}

export function searchKbTool(env: Env) {
  return tool({
    description:
      "Busca en el knowledge base del negocio. Devuelve top-5 chunks con score 0-1. Si top-1 score < 0.7 no hay match útil — escala.",
    inputSchema: z.object({
      query: z.string().min(2).describe("Pregunta o tema a buscar"),
    }),
    execute: async ({ query }) => {
      try {
        const embedding = await env.AI.run("@cf/baai/bge-m3", {
          text: query,
        });
        const vec = (embedding as any).data?.[0];
        if (!Array.isArray(vec)) {
          return { error: "transient" as const, message: "embedding shape unexpected" };
        }
        // returnMetadata defaults to "none" — without it Vectorize returns a
        // correct score but title/content are ALWAYS empty. The model sees a
        // "match" with a decent score but no actual text, and (correctly,
        // per its anti-hallucination instructions) refuses to use it. This
        // looks like a confidence-threshold problem but never is — the KB
        // content just never made it back from Vectorize in the first place.
        const matches = await env.KB.query(vec, { topK: 5, returnMetadata: "all" });
        const results: SearchKbResult[] = (matches.matches ?? []).map((m: any) => ({
          title: (m.metadata?.title as string) ?? "",
          content: (m.metadata?.content as string) ?? "",
          score: m.score ?? 0,
        }));
        return { results };
      } catch (e: any) {
        return { error: "transient" as const, message: String(e?.message ?? e) };
      }
    },
  });
}
