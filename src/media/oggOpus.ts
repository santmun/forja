/**
 * DE WEBM A OGG — para que una nota de voz grabada en el navegador llegue a
 * WhatsApp como NOTA DE VOZ de verdad, con su ondita, y no como un archivo.
 *
 * POR QUÉ HACE FALTA (11/08/2026, tras una tarde de intentos):
 * WhatsApp solo trata como nota de voz el audio **Opus dentro de un OGG**.
 * Chrome no sabe grabar eso: graba `audio/mp4` (que Meta acepta al subir y
 * luego NO entrega, error 131053, y que el celular tampoco reproduce) o
 * `audio/webm`, que WhatsApp ni acepta.
 *
 * La clave: **el `webm` de Chrome YA lleva Opus dentro**. Es el mismo sonido
 * que quiere WhatsApp, solo que envuelto en otra caja. Aquí se cambia la caja,
 * sin tocar ni recomprimir el audio — así que no se pierde calidad y no hace
 * falta ningún conversor.
 *
 * Si algo no cuadra, TODAS las funciones devuelven null en vez de inventarse un
 * archivo: quien llama manda entonces el original como adjunto. Un audio que se
 * oye mal sería peor que un archivo que se abre aparte.
 */

// ── lectura de WebM (Matroska) ────────────────────────────────────────────────
// Un WebM es un árbol de elementos: cada uno lleva su identificador y su
// tamaño, ambos en longitud variable (el primer bit marcado dice cuántos bytes
// ocupa). Solo se buscan tres cosas: la cabecera de Opus, la pista de audio y
// los trozos de sonido.

interface Lector {
  datos: Uint8Array;
  pos: number;
}

/** Lee un número de longitud variable. `conMarca` conserva el bit indicador
 *  (los identificadores lo llevan; los tamaños, no). */
function leerVint(l: Lector, conMarca: boolean): number | null {
  if (l.pos >= l.datos.length) return null;
  const primero = l.datos[l.pos];
  if (primero === 0) return null;
  let largo = 1;
  while (largo <= 8 && !(primero & (0x80 >> (largo - 1)))) largo++;
  if (largo > 8 || l.pos + largo > l.datos.length) return null;
  let valor = conMarca ? primero : primero & (0xff >> largo);
  for (let i = 1; i < largo; i++) valor = valor * 256 + l.datos[l.pos + i];
  l.pos += largo;
  return valor;
}

const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_CLUSTER = 0x1f43b675;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;

// Los contenedores se recorren por dentro; el resto se salta entero.
const CONTENEDORES = new Set([ID_SEGMENT, ID_TRACKS, ID_TRACK_ENTRY, ID_CLUSTER, ID_BLOCK_GROUP]);

export interface AudioWebm {
  /** La cabecera OpusHead que el propio navegador escribió. */
  cabecera: Uint8Array;
  /** Cada paquete de sonido, en orden. */
  paquetes: Uint8Array[];
}

/** ¿Esto es un WebM? Empieza por la firma EBML `1A 45 DF A3`. */
export function esWebm(bytes: ArrayBuffer): boolean {
  const b = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return b.length === 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

/** Saca de un WebM la cabecera de Opus y sus paquetes de sonido. */
export function leerWebmOpus(bytes: ArrayBuffer): AudioWebm | null {
  const datos = new Uint8Array(bytes);
  if (!esWebm(bytes)) return null;

  let cabecera: Uint8Array | null = null;
  const paquetes: Uint8Array[] = [];

  const recorrer = (desde: number, hasta: number): void => {
    const l: Lector = { datos, pos: desde };
    while (l.pos < hasta) {
      const id = leerVint(l, true);
      if (id === null) return;
      const tam = leerVint(l, false);
      if (tam === null) return;
      const fin = Math.min(l.pos + tam, hasta);

      if (id === ID_CODEC_PRIVATE) {
        cabecera = datos.subarray(l.pos, fin);
      } else if (id === ID_SIMPLE_BLOCK || id === ID_BLOCK) {
        // número de pista (variable) + 2 bytes de tiempo + 1 de banderas
        const b: Lector = { datos, pos: l.pos };
        if (leerVint(b, false) !== null) {
          const inicio = b.pos + 3;
          if (inicio < fin) paquetes.push(datos.subarray(inicio, fin));
        }
      } else if (CONTENEDORES.has(id)) {
        recorrer(l.pos, fin);
      }
      l.pos = fin;
    }
  };

  recorrer(0, datos.length);
  // La cabecera de Opus siempre empieza por "OpusHead"; sin ella no hay audio.
  if (!cabecera || paquetes.length === 0) return null;
  const c = cabecera as Uint8Array;
  const firma = String.fromCharCode(...c.subarray(0, 8));
  if (firma !== "OpusHead") return null;
  return { cabecera: c, paquetes };
}

// ── escritura de OGG ──────────────────────────────────────────────────────────

// CRC de las páginas OGG. No es el CRC32 de siempre: va sin invertir la
// entrada ni la salida, y por eso se calcula a mano.
const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    t[i] = r >>> 0;
  }
  return t;
})();

function crcOgg(pagina: Uint8Array): number {
  let crc = 0;
  for (const b of pagina) crc = ((crc << 8) ^ TABLA_CRC[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc >>> 0;
}

/**
 * Cuántas muestras dura un paquete de Opus, leyendo su primer byte (el "TOC").
 * Hace falta para que el reproductor enseñe bien la duración: sin esto, la
 * nota de voz aparece con un tiempo inventado.
 */
export function muestrasDelPaquete(paquete: Uint8Array): number {
  if (!paquete.length) return 0;
  const toc = paquete[0];
  const config = toc >> 3;
  const ms =
    config < 12
      ? [10, 20, 40, 60][config % 4]
      : config < 16
        ? [10, 20][config % 2]
        : [2.5, 5, 10, 20][config % 4];
  // Todo se cuenta a 48 kHz, que es lo que exige OGG/Opus.
  const marcos = (toc & 0x03) === 0 ? 1 : (toc & 0x03) === 3 ? (paquete[1] ?? 1) & 0x3f : 2;
  return Math.round(ms * 48) * Math.max(1, marcos);
}

function pagina(
  datos: Uint8Array[],
  granulo: number,
  serie: number,
  secuencia: number,
  tipo: number,
): Uint8Array {
  // Cada paquete se parte en tramos de 255 bytes: así lo describe la tabla.
  const tramos: number[] = [];
  for (const d of datos) {
    let queda = d.length;
    while (queda >= 255) {
      tramos.push(255);
      queda -= 255;
    }
    tramos.push(queda);
  }
  const cuerpo = datos.reduce((n, d) => n + d.length, 0);
  const salida = new Uint8Array(27 + tramos.length + cuerpo);
  const vista = new DataView(salida.buffer);

  salida.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  salida[4] = 0; // versión
  salida[5] = tipo; // 2 = primera página, 4 = última, 0 = normal
  // El gránulo es de 64 bits; con notas de voz nunca pasa de 32, así que la
  // parte alta va en cero.
  vista.setUint32(6, granulo >>> 0, true);
  vista.setUint32(10, 0, true);
  vista.setUint32(14, serie, true);
  vista.setUint32(18, secuencia, true);
  vista.setUint32(22, 0, true); // el CRC se rellena al final
  salida[26] = tramos.length;
  salida.set(tramos, 27);
  let off = 27 + tramos.length;
  for (const d of datos) {
    salida.set(d, off);
    off += d.length;
  }
  vista.setUint32(22, crcOgg(salida), true);
  return salida;
}

/**
 * Convierte el WebM del navegador en un OGG/Opus que WhatsApp trata como nota
 * de voz. Devuelve null si el archivo no es lo que esperamos.
 *
 * `serie` es el identificador del flujo; se puede fijar para que el resultado
 * sea idéntico en cada corrida (las pruebas lo agradecen).
 */
export function webmOpusAOgg(bytes: ArrayBuffer, serie = 0x45434320): Uint8Array | null {
  const leido = leerWebmOpus(bytes);
  if (!leido) return null;

  const paginas: Uint8Array[] = [];
  let secuencia = 0;

  // 1) La cabecera, sola en su página (así lo pide el formato).
  paginas.push(pagina([leido.cabecera], 0, serie, secuencia++, 2));

  // 2) Los "comentarios": obligatorios aunque vayan vacíos.
  const etiquetas = new TextEncoder().encode("OpusTags");
  const proveedor = new TextEncoder().encode("Escuela Con Confianza");
  const tags = new Uint8Array(8 + 4 + proveedor.length + 4);
  tags.set(etiquetas, 0);
  new DataView(tags.buffer).setUint32(8, proveedor.length, true);
  tags.set(proveedor, 12);
  new DataView(tags.buffer).setUint32(12 + proveedor.length, 0, true);
  paginas.push(pagina([tags], 0, serie, secuencia++, 0));

  // 3) El sonido. Se agrupan paquetes por página (tope de 255 tramos) y el
  //    gránulo acumula las muestras, que es como el reproductor sabe la
  //    duración y puede moverse por el audio.
  let granulo = 0;
  let grupo: Uint8Array[] = [];
  let tramosDelGrupo = 0;
  const cerrarGrupo = (ultima: boolean) => {
    if (!grupo.length) return;
    paginas.push(pagina(grupo, granulo, serie, secuencia++, ultima ? 4 : 0));
    grupo = [];
    tramosDelGrupo = 0;
  };

  for (let i = 0; i < leido.paquetes.length; i++) {
    const p = leido.paquetes[i];
    const tramos = Math.floor(p.length / 255) + 1;
    if (tramosDelGrupo + tramos > 255) cerrarGrupo(false);
    grupo.push(p);
    tramosDelGrupo += tramos;
    granulo += muestrasDelPaquete(p);
    if (i === leido.paquetes.length - 1) cerrarGrupo(true);
  }
  if (grupo.length) cerrarGrupo(true);

  const total = paginas.reduce((n, p) => n + p.length, 0);
  const salida = new Uint8Array(total);
  let off = 0;
  for (const p of paginas) {
    salida.set(p, off);
    off += p.length;
  }
  return salida;
}
