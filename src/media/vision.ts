import type { ModelMessage } from "ai";
import type { Env } from "../env";
import { captureIncomingMedia } from "./boveda";
import { isZernioMediaUrl } from "./zernio";

/** URL pública (el modelo la baja) o bytes ya descargados (Zernio, que exige Bearer). */
export type ModelImageInput = string | { bytes: Uint8Array; mediaType: string };

export function buildMultimodalUserMessage(
  text: string | undefined,
  image?: ModelImageInput,
): ModelMessage {
  if (!image) {
    return { role: "user", content: text ?? "" };
  }
  const imagePart =
    typeof image === "string"
      ? { type: "image" as const, image: new URL(image) }
      : { type: "image" as const, image: image.bytes, mediaType: image.mediaType };
  return {
    role: "user",
    content: [imagePart, ...(text ? [{ type: "text" as const, text }] : [])],
  };
}

/**
 * Prepara la foto para el modelo. Las URLs de Zernio no son públicas: hay que
 * bajar los bytes con el Bearer y pasarlos como imagen. Una URL de Telegram,
 * Meta o el proxy firmado de WhatsApp Cloud se deja como URL.
 */
export async function describeImage(imageUrl: string, env: Env): Promise<ModelImageInput> {
  if (!isZernioMediaUrl(imageUrl, env)) return imageUrl;
  const captured = await captureIncomingMedia(imageUrl, env);
  const mediaType = captured.contentType.startsWith("image/") ? captured.contentType : "image/jpeg";
  return { bytes: captured.bytes, mediaType };
}
