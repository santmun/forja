/**
 * NOTAS DE VOZ DEL EQUIPO — grabar desde el panel y mandarlo por WhatsApp.
 *
 * Para qué sirve: en mitad de una conversación con el bot, una persona del
 * equipo graba diez segundos con su voz. Quien está del otro lado deja de
 * hablarle a un sistema y oye a alguien. Después el bot sigue.
 *
 * El envío va por la Cloud API de Meta, que es la que ya usa `channels/whatsapp`.
 *
 * EL FORMATO ES TODO EL PROBLEMA, y no es evidente:
 *  · WhatsApp solo trata como NOTA DE VOZ el audio **Opus dentro de un OGG**.
 *  · El navegador no sabe grabar eso. Chrome graba `audio/mp4` —que Meta acepta
 *    al subir, NO entrega (error 131053) y el celular tampoco reproduce— o
 *    `audio/webm`, que WhatsApp ni admite.
 *  · Pero el webm de Chrome YA lleva Opus dentro. Solo hay que cambiarle la
 *    caja, y eso lo hace `media/oggOpus` sin recomprimir ni depender de nada.
 */
import type { Env } from "../env";
import { webmOpusAOgg } from "./oggOpus";

const GRAPH_VERSION = "v21.0";

/** Formatos de audio que WhatsApp acepta. `audio/webm` NO está: se convierte. */
export const FORMATOS_WHATSAPP = [
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/mpeg",
  "audio/amr",
] as const;

/** Tope de WhatsApp para audio. */
export const MAX_BYTES_AUDIO = 16 * 1024 * 1024;

/** `audio/ogg;codecs=opus` → `audio/ogg` (Meta rechaza el tipo con parámetros). */
export function tipoBase(mime: string): string {
  return (mime || "").split(";")[0].trim().toLowerCase();
}

export function formatoAceptado(mime: string): boolean {
  return (FORMATOS_WHATSAPP as readonly string[]).includes(tipoBase(mime));
}

/** Lo que el panel acepta del navegador: lo de WhatsApp más el webm que se convierte. */
export function formatoGrabable(mime: string): boolean {
  const t = tipoBase(mime);
  return formatoAceptado(t) || t === "audio/webm";
}

/**
 * ¿Este identificador de conversación es un teléfono al que se pueda mandar?
 * No todos lo son aunque el canal sea WhatsApp: hay proveedores que identifican
 * al contacto con algo que no es un número. Antes que mandarle la voz de
 * alguien a un número equivocado, no se manda. E.164: de 8 a 15 dígitos.
 */
export function telefonoDe(channelUserId: string): string | null {
  const crudo = (channelUserId || "").trim();
  if (/[a-z]/i.test(crudo)) return null;
  const digitos = crudo.replace(/\D/g, "");
  return digitos.length >= 8 && digitos.length <= 15 ? digitos : null;
}

/**
 * ¿Este MP4 es de los "fragmentados"?
 *
 * 🪤 Meta ACEPTA la subida y ACEPTA el envío —devuelve su id de mensaje— de un
 * audio que después no puede procesar, y el fallo solo aparece más tarde por el
 * webhook de estados: `131053 … uploaded with mimetype as audio/mp4, however on
 * processing it is of type application/octet-stream`. El archivo es un MP4
 * legítimo (empieza por `ftyp`), pero es *fragmentado* —lo que graba
 * `MediaRecorder`— y su analizador no lo reconoce.
 *
 * 🚫 Preguntarle a Meta `GET /<media_id>` NO sirve: devuelve el mime que le
 * declaraste tú, no el que detecta. Probado y descartado. Lo que sí distingue el
 * archivo es su estructura: los fragmentados llevan cajas `moof`.
 */
export function mp4EsFragmentado(bytes: ArrayBuffer): boolean {
  const vista = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1_000_000));
  for (let i = 0; i + 3 < vista.length; i++) {
    if (vista[i] === 0x6d && vista[i + 1] === 0x6f && vista[i + 2] === 0x6f && vista[i + 3] === 0x66) {
      return true;
    }
  }
  return false;
}

/** ¿Puede viajar como nota de voz, o hay que mandarlo como adjunto? */
export function vaComoNotaDeVoz(tipo: string, bytes: ArrayBuffer): boolean {
  if (tipo === "audio/mp4") return !mp4EsFragmentado(bytes);
  return (FORMATOS_WHATSAPP as readonly string[]).includes(tipo);
}

function credenciales(env: Env): { phoneId: string; token: string } {
  const phoneId = (env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const token = (env.WHATSAPP_ACCESS_TOKEN || "").trim();
  if (!phoneId || !token) {
    throw new Error("Falta configurar WhatsApp (WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN).");
  }
  return { phoneId, token };
}

/**
 * Arma el multipart A MANO, en un solo bloque de bytes.
 *
 * Con `FormData` el cuerpo puede irse en *chunked* y la subida morir con un
 * "Network connection lost" que parece un problema de red y no lo es. Con el
 * cuerpo montado, la petición lleva su tamaño exacto.
 */
export function cuerpoMultipart(
  bytes: ArrayBuffer,
  tipo: string,
  nombreArchivo: string,
): { cuerpo: Uint8Array; contentType: string } {
  const frontera = `----forja${crypto.randomUUID().replace(/-/g, "")}`;
  const enc = new TextEncoder();
  const campo = (nombre: string, valor: string) =>
    `--${frontera}\r\nContent-Disposition: form-data; name="${nombre}"\r\n\r\n${valor}\r\n`;

  const inicio = enc.encode(
    campo("messaging_product", "whatsapp") +
      campo("type", tipo) +
      `--${frontera}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${nombreArchivo}"\r\n` +
      `Content-Type: ${tipo}\r\n\r\n`,
  );
  const fin = enc.encode(`\r\n--${frontera}--\r\n`);
  const archivo = new Uint8Array(bytes);

  const cuerpo = new Uint8Array(inicio.length + archivo.length + fin.length);
  cuerpo.set(inicio, 0);
  cuerpo.set(archivo, inicio.length);
  cuerpo.set(fin, inicio.length + archivo.length);
  return { cuerpo, contentType: `multipart/form-data; boundary=${frontera}` };
}

/** Sube los bytes a Meta y devuelve el id del media. */
export async function subirAudioAMeta(env: Env, bytes: ArrayBuffer, mime: string): Promise<string> {
  const { phoneId, token } = credenciales(env);
  const tipo = tipoBase(mime);
  const ext = tipo === "audio/mpeg" ? "mp3" : tipo === "audio/mp4" ? "m4a" : tipo.split("/")[1];
  const { cuerpo, contentType } = cuerpoMultipart(bytes, tipo, `nota-de-voz.${ext}`);

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body: cuerpo,
  });
  const respuesta = await res.text();
  if (!res.ok) throw new Error(`Meta rechazó el audio (${res.status}): ${respuesta.slice(0, 300)}`);
  const id = (JSON.parse(respuesta) as { id?: string }).id;
  if (!id) throw new Error("Meta no devolvió el identificador del audio.");
  return id;
}

/**
 * Manda la nota de voz a un teléfono. Devuelve el id del mensaje en Meta.
 *
 * ⏰ Aplica la ventana de 24 horas de WhatsApp: fuera de ella Meta rechaza
 * cualquier mensaje que no sea una plantilla, y una plantilla no lleva audio.
 */
export async function enviarNotaDeVoz(
  env: Env,
  telefono: string,
  bytes: ArrayBuffer,
  mime: string,
): Promise<string> {
  const { phoneId, token } = credenciales(env);
  let tipo = tipoBase(mime);
  let contenidoAudio = bytes;

  // El webm del navegador ya lleva Opus: se le cambia la caja a OGG y entonces
  // WhatsApp lo trata como NOTA DE VOZ, con su ondita.
  if (tipo === "audio/webm") {
    const ogg = webmOpusAOgg(bytes);
    if (ogg) {
      contenidoAudio = ogg.buffer.slice(ogg.byteOffset, ogg.byteOffset + ogg.byteLength) as ArrayBuffer;
      tipo = "audio/ogg";
    } else {
      console.warn("[nota-de-voz] no se pudo convertir el webm — va como adjunto");
    }
  }

  const mediaId = await subirAudioAMeta(env, contenidoAudio, tipo);

  // Si el archivo no es de los que WhatsApp procesa, mandarlo como audio acaba
  // en un 131053 que aparece tarde y deja a la persona sin nada. Como adjunto
  // sí llega: WhatsApp no procesa los documentos, los entrega.
  const reconocido = vaComoNotaDeVoz(tipo, contenidoAudio);
  const ext = tipo === "audio/mpeg" ? "mp3" : tipo === "audio/mp4" ? "m4a" : tipo.split("/")[1];
  const contenido = reconocido
    ? { type: "audio", audio: { id: mediaId } }
    : { type: "document", document: { id: mediaId, filename: `Nota de voz.${ext}` } };

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: telefono,
      ...contenido,
    }),
  });
  const cuerpo = await res.text();
  if (!res.ok) throw new Error(`Meta no entregó la nota de voz (${res.status}): ${cuerpo.slice(0, 300)}`);
  const j = JSON.parse(cuerpo) as { messages?: { id?: string }[] };
  return j.messages?.[0]?.id ?? mediaId;
}

/** Traduce el error de Meta a algo que entienda quien atiende, no un JSON. */
export function motivoEntendible(e: unknown): string {
  const texto = e instanceof Error ? e.message : String(e);
  if (/24|re-?engagement|outside.*window|131047/i.test(texto)) {
    return "Pasaron más de 24 horas desde el último mensaje de la persona y WhatsApp ya no deja mandar audios. Escríbele un texto primero y espera su respuesta.";
  }
  if (/190|expired|invalid.*token|401/i.test(texto)) {
    return "La llave de WhatsApp caducó. Hay que renovarla.";
  }
  if (/Falta configurar WhatsApp/i.test(texto)) return texto;
  if (/network connection lost|connection.*(closed|reset)/i.test(texto)) {
    return "Se cortó la conexión con WhatsApp al subir el audio. Vuelve a intentarlo.";
  }
  if (/rechazó el audio/i.test(texto)) {
    return "WhatsApp no aceptó el formato del audio. Prueba a grabar desde el celular.";
  }
  return `No se pudo enviar la nota de voz. ${texto}`;
}
