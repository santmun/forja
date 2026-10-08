/**
 * Texto de un mensaje del hilo, listo para meter en HTML.
 *
 * El bot guarda la foto dentro del texto (`[IMAGE_URL: https://…]` en este
 * repo, o `[[media: img_xxx]]` cuando viene de la galería). Sin este paso el
 * panel enseña el marcador tal cual, aunque al cliente sí le haya llegado la foto.
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const MARKER_RE = /\[\[media:\s*([A-Za-z0-9_-]{1,80})\]\]|\[IMAGE_URL:\s*(https?:\/\/[^\s\]]+)\]/g;

function imgTag(src: string): string {
  return `<img src="${escapeHtml(src)}" alt="imagen" style="max-width:100%;max-height:240px;height:auto;display:block;margin-top:6px">`;
}

export function renderMessageHtml(content: string): string {
  let html = "";
  let last = 0;
  for (const match of content.matchAll(MARKER_RE)) {
    const index = match.index ?? 0;
    html += escapeHtml(content.slice(last, index));
    const galleryId = match[1];
    const imageUrl = match[2];
    if (galleryId) html += imgTag(`/media/${galleryId}`);
    else if (imageUrl) html += imgTag(imageUrl);
    last = index + match[0].length;
  }
  html += escapeHtml(content.slice(last));
  return html;
}
