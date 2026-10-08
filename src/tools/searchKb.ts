import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";

export interface SearchKbResult {
  title: string;
  content: string;
  score: number;
}

/** El agente guarda los pasajes del turno para el Blindaje. */
export type SearchKbOnResults = (results: SearchKbResult[]) => void;

export function searchKbTool(env: Env, onResults?: SearchKbOnResults) {
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
        // Sin returnMetadata:"all", Vectorize devuelve el score pero title y
        // content vacíos. El modelo (y el Blindaje) no pueden usar el texto.
        const matches = await env.KB.query(vec, { topK: 5, returnMetadata: "all" });
        const results: SearchKbResult[] = (matches.matches ?? []).map((m: any) => ({
          title: (m.metadata?.title as string) ?? "",
          content: (m.metadata?.content as string) ?? "",
          score: m.score ?? 0,
        }));
        try {
          onResults?.(results);
        } catch {
          /* el callback no puede tumbar la búsqueda */
        }
        return { results };
      } catch (e: any) {
        return { error: "transient" as const, message: String(e?.message ?? e) };
      }
    },
  });
}
