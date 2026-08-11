/**
 * UN COLOR PROPIO PARA CADA CONTACTO.
 *
 * En la lista de conversaciones todos los contactos se veían igual, y para
 * encontrar a alguien había que leer nombre por nombre. Ahora cada uno tiene su
 * cuadradito de color con sus iniciales — y es SIEMPRE el mismo color, porque
 * sale de su propio número (o su id de canal), no de un aleatorio ni del orden
 * en la lista. El mismo color en la bandeja y dentro del chat.
 *
 * ¿Y la foto de perfil de verdad? NO SE PUEDE, y no es culpa del panel:
 * WhatsApp Cloud API entrega por mensaje el nombre que la persona se puso y su
 * número (`contacts[].profile.name` y `wa_id`), nada más. Meta no expone la foto
 * de quien te escribe, ni con la cuenta verificada. Telegram sí tendría, pero
 * casi nadie atiende clientes por ahí. Así que esto es lo más cerca que se
 * llega, y funciona igual de bien para reconocer a alguien de un vistazo.
 *
 * ⚠️ LA TRAMPA DE LAS INICIALES: hay que saltarse los guiones y los signos. Un
 * contacto guardado como "Ana - Tienda Central" daba "A-" en vez de "AT",
 * porque el guion contaba como palabra.
 */

/** Escapa texto que va dentro de HTML. Usa el de tu proyecto si ya tienes uno. */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

/** Las dos primeras letras útiles. Ignora guiones, signos y espacios de más. */
export function initialsOf(label: string): string {
  const palabras = (label ?? "")
    .split(/[\s\-–—_·|]+/)
    .map((p) => p.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (!palabras.length) return "?";
  if (palabras.length === 1) return palabras[0].slice(0, 2).toUpperCase();
  return (palabras[0][0] + palabras[1][0]).toUpperCase();
}

/**
 * Color estable a partir de una semilla (el número o el id del contacto).
 *
 * Saturación y luz FIJAS a propósito: solo se mueve el tono. Así ningún
 * contacto sale de un color chillón ni de uno tan pálido que no se lea, y
 * ninguno compite con el color de marca del panel.
 */
export function colorDeContacto(semilla: string): { fondo: string; texto: string } {
  let h = 0;
  for (let i = 0; i < semilla.length; i++) h = (h * 31 + semilla.charCodeAt(i)) % 360;
  return { fondo: `hsl(${h} 42% 42%)`, texto: "#fff" };
}

/** El cuadradito listo para pegar en la lista o en la cabecera del chat. */
export function avatarContacto(etiqueta: string, semilla: string, tamano: number): string {
  const c = colorDeContacto(semilla);
  return (
    `<div title="${escapeHtml(etiqueta)}" style="width:${tamano}px;height:${tamano}px;flex:none;` +
    `background:${c.fondo};color:${c.texto};border:1px solid rgba(0,0,0,.18);` +
    `display:flex;align-items:center;justify-content:center;` +
    `font-size:${Math.round(tamano * 0.38)}px;font-weight:700;letter-spacing:.02em">` +
    `${escapeHtml(initialsOf(etiqueta))}</div>`
  );
}
