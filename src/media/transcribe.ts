import type { Env } from "../env";
import { captureIncomingMedia, MediaFetchError } from "./boveda";

export interface TranscriptionResult {
  text: string;
  durationSeconds?: number;
}

export async function transcribeAudio(
  audioUrl: string,
  env: Env,
): Promise<TranscriptionResult> {
  let bytes: Uint8Array;
  try {
    ({ bytes } = await captureIncomingMedia(audioUrl, env));
  } catch (e) {
    if (e instanceof MediaFetchError) throw new Error(`audio fetch failed: ${e.status}`);
    throw e;
  }
  // whisper-large-v3-turbo expects a base64-encoded string in `audio` (per the
  // Cloudflare Workers AI docs), NOT a raw byte array. nodejs_compat is enabled
  // (see wrangler.toml) so Buffer is available, matching the official example.
  const base64 = Buffer.from(bytes).toString("base64");
  const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo" as any, {
    audio: base64,
  } as any);
  return {
    text: (result as any).text ?? "",
  };
}
