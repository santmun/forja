import type { Env } from "../env";
import kbChunks from "../../scripts/kb-fixtures.json";

/**
 * KB → Vectorize ingestion pipeline.
 *
 * Reads the build-time manifest produced by `scripts/generate-fixtures.ts`
 * (`scripts/kb-fixtures.json`), embeds every chunk's `content` with the
 * multilingual `@cf/baai/bge-m3` model (1024-dim — the SAME model `searchKb`
 * uses for queries, so vectors actually match), and upserts the results into
 * the Vectorize index bound as `KB`.
 *
 * `upsert` overwrites by `id`, so re-running this is idempotent: a redeploy +
 * reindex safely replaces the index contents.
 *
 * searchKb reads `m.metadata.title` and `m.metadata.content` from results, so
 * each upserted vector carries `metadata: { title, content }`.
 */

export interface KbChunk {
  id: string;
  title?: string;
  content: string;
  source?: string;
}

const BATCH_SIZE = 100;

/** bge-m3 (`@cf/baai/bge-m3`) siempre devuelve vectores de este largo. */
export const EMBEDDING_DIMENSIONS = 1024;

export class VectorizeDimensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorizeDimensionError";
  }
}

/** Junta message/cause para reconocer el error aunque Vectorize lo anide. */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur != null && !seen.has(cur) && parts.length < 6) {
    seen.add(cur);
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
      continue;
    }
    if (typeof cur === "object") {
      const o = cur as { message?: unknown; error?: unknown; cause?: unknown };
      if (typeof o.message === "string") parts.push(o.message);
      else if (typeof o.error === "string") parts.push(o.error);
      cur = o.cause;
      continue;
    }
    parts.push(String(cur));
    break;
  }
  return parts.join(" ");
}

export function isVectorizeDimensionMismatch(err: unknown): boolean {
  const msg = errorText(err);
  if (!/dimension/i.test(msg)) return false;
  return /mismatch|do not match|does not match|don't match|no coincide|expected\s+\d+|got\s+\d+/i.test(msg);
}

/** Mensaje accionable: la dimensión del índice no es la de bge-m3. */
export function dimensionMismatchMessage(err?: unknown): string {
  const raw = err == null ? "" : errorText(err);
  const expected = raw.match(/expected\s+(\d+)/i)?.[1];
  const detail =
    expected && expected !== String(EMBEDDING_DIMENSIONS)
      ? `tiene ${expected} dimensiones y no coincide con las ${EMBEDDING_DIMENSIONS} de bge-m3`
      : `no coincide con las ${EMBEDDING_DIMENSIONS} dimensiones de bge-m3`;
  return `El índice de Vectorize ${detail}. Recréalo con --dimensions=${EMBEDDING_DIMENSIONS} --metric=cosine.`;
}

type IndexDetails = { dimensions?: number; config?: { dimensions?: number } };

/** `describe()` existe en el binding de Vectorize; los mocks de test no siempre. */
async function readIndexDimensions(kb: Env["KB"]): Promise<number | null> {
  const describe = (kb as Env["KB"] & { describe?: () => Promise<IndexDetails> }).describe;
  if (typeof describe !== "function") return null;
  try {
    const info = await describe.call(kb);
    const raw = info?.dimensions ?? info?.config?.dimensions;
    return typeof raw === "number" ? raw : null;
  } catch {
    return null;
  }
}

export async function reindexKb(
  env: Env,
  chunks: KbChunk[] = kbChunks as KbChunk[],
): Promise<{ indexed: number }> {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { indexed: 0 };
  }

  let indexed = 0;

  const dim = await readIndexDimensions(env.KB);
  if (dim != null && dim !== EMBEDDING_DIMENSIONS) {
    throw new VectorizeDimensionError(dimensionMismatchMessage(`expected ${dim}`));
  }

  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    const batch = chunks.slice(start, start + BATCH_SIZE);
    try {
      const embeddings = await env.AI.run("@cf/baai/bge-m3", {
        text: batch.map((c) => c.content),
      });
      const data = (embeddings as { data: number[][] }).data;

      const vectors: VectorizeVector[] = batch.map((c, i) => ({
        id: c.id,
        values: data[i],
        metadata: { title: c.title ?? "", content: c.content },
      }));

      await env.KB.upsert(vectors);
      indexed += vectors.length;
    } catch (e: unknown) {
      const msg = errorText(e);
      console.error(
        `reindexKb: batch at offset ${start} (size ${batch.length}) failed: ${msg}`,
      );
      if (isVectorizeDimensionMismatch(e)) {
        throw new VectorizeDimensionError(dimensionMismatchMessage(e));
      }
      throw e;
    }
  }

  return { indexed };
}
