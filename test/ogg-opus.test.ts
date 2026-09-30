/**
 * DE WEBM A OGG — que la nota de voz llegue como NOTA DE VOZ, no como archivo.
 *
 * Historia (11/08/2026): Chrome graba `audio/mp4` "por trozos". Meta lo acepta
 * al subir, no lo entrega (error 131053) y, mandado como adjunto, el celular
 * tampoco lo reproduce. Pero el `webm` de Chrome ya lleva Opus dentro, que es
 * exactamente lo que WhatsApp quiere: solo hay que cambiarle la caja.
 *
 * Aquí se comprueba que la caja nueva está bien construida, porque un OGG mal
 * armado se oiría cortado o no se oiría — y eso sería peor que un archivo.
 */
import { describe, it, expect } from "vitest";
import { esWebm, leerWebmOpus, muestrasDelPaquete, webmOpusAOgg } from "../src/media/oggOpus";

// ── un WebM mínimo, escrito a mano ────────────────────────────────────────────

function vint(n: number): number[] {
  // Tamaños de hasta 2 bytes, suficiente para las pruebas.
  return n < 0x7f ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff];
}
function elemento(id: number[], carga: number[]): number[] {
  return [...id, ...vint(carga.length), ...carga];
}
const OPUS_HEAD = [...new TextEncoder().encode("OpusHead"), 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];

/** Un paquete de Opus de 20 ms: el primer byte manda (config 1, un marco). */
function paqueteOpus(relleno: number, largo = 40): number[] {
  return [0x08, ...Array(largo - 1).fill(relleno)];
}

function webmDePrueba(paquetes: number[][]): ArrayBuffer {
  const codecPrivate = elemento([0x63, 0xa2], OPUS_HEAD);
  const trackEntry = elemento([0xae], codecPrivate);
  const tracks = elemento([0x16, 0x54, 0xae, 0x6b], trackEntry);
  const bloques = paquetes.flatMap((p) =>
    // pista 1 + 2 bytes de tiempo + 1 de banderas + el paquete
    elemento([0xa3], [0x81, 0x00, 0x00, 0x00, ...p]),
  );
  const cluster = elemento([0x1f, 0x43, 0xb6, 0x75], bloques);
  const segment = elemento([0x18, 0x53, 0x80, 0x67], [...tracks, ...cluster]);
  const cabeceraEbml = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x01, 0x02, 0x03, 0x04];
  return new Uint8Array([...cabeceraEbml, ...segment]).buffer;
}

describe("leer el webm del navegador", () => {
  it("reconoce un webm por su firma", () => {
    expect(esWebm(webmDePrueba([paqueteOpus(1)]))).toBe(true);
    expect(esWebm(new Uint8Array([0, 0, 0, 0x24, 0x66, 0x74, 0x79, 0x70]).buffer)).toBe(false);
  });

  it("saca la cabecera de Opus y los paquetes de sonido", () => {
    const leido = leerWebmOpus(webmDePrueba([paqueteOpus(1), paqueteOpus(2), paqueteOpus(3)]));
    expect(leido).not.toBeNull();
    expect(String.fromCharCode(...leido!.cabecera.subarray(0, 8))).toBe("OpusHead");
    expect(leido!.paquetes).toHaveLength(3);
    expect(leido!.paquetes[1][1]).toBe(2);
  });

  it("ante un archivo que no es webm devuelve null en vez de inventarse algo", () => {
    expect(leerWebmOpus(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toBeNull();
    expect(webmOpusAOgg(new Uint8Array([1, 2, 3, 4]).buffer)).toBeNull();
  });
});

describe("la duración de cada paquete", () => {
  it("un paquete de 20 ms son 960 muestras a 48 kHz", () => {
    // Sin esto el reproductor enseña una duración inventada.
    expect(muestrasDelPaquete(new Uint8Array([0x08]))).toBe(960);
  });

  it("un paquete vacío no revienta", () => {
    expect(muestrasDelPaquete(new Uint8Array([]))).toBe(0);
  });
});

describe("el ogg que se manda a WhatsApp", () => {
  const ogg = webmOpusAOgg(webmDePrueba([paqueteOpus(1), paqueteOpus(2), paqueteOpus(3)]))!;

  it("se genera", () => {
    expect(ogg).toBeInstanceOf(Uint8Array);
    expect(ogg.length).toBeGreaterThan(60);
  });

  it("empieza por OggS y trae la cabecera y los comentarios", () => {
    const texto = new TextDecoder("latin1").decode(ogg);
    expect(texto.startsWith("OggS")).toBe(true);
    expect(texto).toContain("OpusHead");
    expect(texto).toContain("OpusTags");
  });

  it("la primera página se marca como principio de flujo", () => {
    expect(ogg[5]).toBe(2); // bandera de "primera página"
  });

  it("la última página se marca como final", () => {
    // Sin esta marca, algunos reproductores creen que el audio sigue.
    const texto = new TextDecoder("latin1").decode(ogg);
    const ultima = texto.lastIndexOf("OggS");
    expect(ogg[ultima + 5]).toBe(4);
  });

  it("el gránulo acumula la duración de los tres paquetes", () => {
    const texto = new TextDecoder("latin1").decode(ogg);
    const ultima = texto.lastIndexOf("OggS");
    const granulo = new DataView(ogg.buffer, ogg.byteOffset + ultima + 6, 4).getUint32(0, true);
    expect(granulo).toBe(960 * 3);
  });

  it("cada página lleva su CRC calculado, no en cero", () => {
    // El CRC de OGG no es el CRC32 normal; si se calcula mal, el reproductor
    // descarta la página entera y el audio llega mudo.
    const texto = new TextDecoder("latin1").decode(ogg);
    let i = -1;
    let paginas = 0;
    while ((i = texto.indexOf("OggS", i + 1)) !== -1) {
      const crc = new DataView(ogg.buffer, ogg.byteOffset + i + 22, 4).getUint32(0, true);
      expect(crc).not.toBe(0);
      paginas++;
    }
    expect(paginas).toBe(3); // cabecera + comentarios + sonido
  });

  it("el sonido viaja intacto, sin recomprimir", () => {
    const texto = new TextDecoder("latin1").decode(ogg);
    // El relleno de cada paquete de prueba tiene que seguir ahí.
    expect(texto).toContain(String.fromCharCode(1).repeat(39));
    expect(texto).toContain(String.fromCharCode(3).repeat(39));
  });
});
