import type { Env } from "../env";
import { fetchInboundMedia, type ZernioEnv } from "./zernio";

export interface CapturedMedia {
  bytes: Uint8Array;
  contentType: string;
}

export class MediaFetchError extends Error {
  constructor(readonly status: number) {
    super(`media fetch failed: ${status}`);
    this.name = "MediaFetchError";
  }
}

/**
 * Baja los bytes de un adjunto entrante (nota de voz, foto).
 * Zernio exige Authorization; fetchInboundMedia la pone solo en su host.
 */
export async function captureIncomingMedia(url: string, env: ZernioEnv & Partial<Env>): Promise<CapturedMedia> {
  const res = await fetchInboundMedia(url, env);
  if (!res.ok) throw new MediaFetchError(res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = (res.headers.get("content-type") || "application/octet-stream")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return { bytes, contentType: contentType || "application/octet-stream" };
}
