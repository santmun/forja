// Textos que el bot guarda cuando NO pudo leer el audio o la foto.
// No son palabras del cliente: un fallo de descarga (401 de Zernio, red, etc.)
// deja el mismo placeholder en cada intento. Si el anti-bot los cuenta como
// "el mismo mensaje repetido", 3 notas de voz pausan a una persona real.

export const AUDIO_NOT_UNDERSTOOD = "(no pude entender el audio)";
export const AUDIO_EMPTY = "(audio sin transcripción)";
export const IMAGE_NOT_SEEN = "(no pude ver la imagen)";
/** Lo que se guarda cuando la foto llega sin texto del cliente. No es un fallo. */
export const IMAGE_NO_CAPTION = "(imagen sin caption)";

const PLACEHOLDERS = new Set(
  [AUDIO_NOT_UNDERSTOOD, AUDIO_EMPTY, IMAGE_NOT_SEEN].map((s) => s.toLowerCase()),
);

/**
 * True cuando el texto guardado es solo avisos de fallo de media, no palabras
 * del cliente. Varios audios en el mismo buffer quedan en líneas separadas
 * con el mismo placeholder: eso también cuenta.
 */
export function isMediaFailurePlaceholder(text: string): boolean {
  const stripped = text.replace(/\n?\[IMAGE_URL: .+?\]/gi, "").trim();
  if (!stripped) return false;
  const parts = stripped
    .split(/\n+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => PLACEHOLDERS.has(p));
}

/**
 * Texto que queda guardado si la foto no se pudo bajar. Una foto sin texto
 * del cliente pasa a ser solo el aviso de fallo. Si el cliente sí escribió
 * algo, ese texto se conserva y el aviso va en otra línea: sigue contando
 * para la detección de bots.
 */
export function textAfterImageFetchFailure(cleanText: string): string {
  const caption = cleanText
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== IMAGE_NO_CAPTION.toLowerCase())
    .join("\n");
  return caption ? `${caption}\n${IMAGE_NOT_SEEN}` : IMAGE_NOT_SEEN;
}
