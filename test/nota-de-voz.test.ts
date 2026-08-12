/**
 * NOTAS DE VOZ DEL EQUIPO.
 *
 * Lo que se protege aquí, por orden de gravedad:
 *  1. Que el audio salga en el formato que WhatsApp SÍ entrega. Es donde está
 *     todo el problema: Meta acepta la subida y el envío de un archivo que
 *     después no puede procesar, y el fallo aparece más tarde y en otro sitio.
 *  2. Que no se le mande la voz de alguien a un número que no existe.
 *  3. Que los errores de Meta se traduzcan a algo que entienda quien atiende.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FORMATOS_WHATSAPP,
  cuerpoMultipart,
  enviarNotaDeVoz,
  formatoAceptado,
  formatoGrabable,
  motivoEntendible,
  mp4EsFragmentado,
  telefonoDe,
  tipoBase,
  vaComoNotaDeVoz,
} from "../src/media/notaDeVoz";

const env = {
  WHATSAPP_PHONE_NUMBER_ID: "123456",
  WHATSAPP_ACCESS_TOKEN: "EAA-token",
} as any;

/** Cabecera real del MP4 que graba Chrome, con su caja `moof` de fragmento. */
function mp4Fragmentado(): ArrayBuffer {
  return new TextEncoder().encode(
    "\0\0\0\x24ftypisom\0\0\x02\0isomiso6iso2vp09mp41\0\0\x02]moov" + "x".repeat(40) + "\0\0\0\x10moof",
  ).buffer as ArrayBuffer;
}
/** Un .m4a de toda la vida: mismo principio, sin fragmentos. */
function mp4Normal(): ArrayBuffer {
  return new TextEncoder().encode("\0\0\0\x20ftypM4A \0\0\0\0M4A mp42isom\0\0\x02]moov" + "x".repeat(60))
    .buffer as ArrayBuffer;
}

describe("qué formatos entran y cuáles no", () => {
  it("acepta los de WhatsApp aunque lleven el códec pegado", () => {
    expect(formatoAceptado("audio/ogg;codecs=opus")).toBe(true);
    expect(tipoBase("audio/ogg;codecs=opus")).toBe("audio/ogg");
    for (const f of FORMATOS_WHATSAPP) expect(formatoAceptado(f)).toBe(true);
  });

  it("el webm de Chrome se acepta en el panel aunque WhatsApp no lo admita", () => {
    // WhatsApp no admite webm, pero lleva Opus dentro y el worker le cambia la
    // caja. Si esto se cerrara, en Chrome no se podría grabar nada servible.
    expect(formatoAceptado("audio/webm")).toBe(false);
    expect(formatoGrabable("audio/webm;codecs=opus")).toBe(true);
    expect(formatoGrabable("audio/flac")).toBe(false);
  });
});

describe("el MP4 de Chrome frente al de una grabadora", () => {
  it("el de Chrome lleva caja moof y el normal no", () => {
    expect(mp4EsFragmentado(mp4Fragmentado())).toBe(true);
    expect(mp4EsFragmentado(mp4Normal())).toBe(false);
  });

  it("solo el que WhatsApp puede procesar va como nota de voz", () => {
    expect(vaComoNotaDeVoz("audio/mp4", mp4Fragmentado())).toBe(false);
    expect(vaComoNotaDeVoz("audio/mp4", mp4Normal())).toBe(true);
    expect(vaComoNotaDeVoz("audio/ogg", new ArrayBuffer(8))).toBe(true);
  });
});

describe("a quién se le puede mandar", () => {
  it("acepta un teléfono normal", () => {
    expect(telefonoDe("51992117242")).toBe("51992117242");
    expect(telefonoDe("+51 992 117 242")).toBe("51992117242");
  });

  it("rechaza los identificadores que NO son teléfonos", () => {
    // Hay proveedores que identifican al contacto con algo así; quitarle las
    // letras daría un número de 16 cifras que no existe.
    expect(telefonoDe("PE.1618339096292670")).toBeNull();
    expect(telefonoDe("1618339096292670")).toBeNull();
    expect(telefonoDe("12345")).toBeNull();
  });
});

describe("el cuerpo del archivo se arma a mano", () => {
  const { cuerpo, contentType } = cuerpoMultipart(
    new Uint8Array([1, 2, 3, 4, 5]).buffer as ArrayBuffer,
    "audio/ogg",
    "nota-de-voz.ogg",
  );
  const texto = new TextDecoder().decode(cuerpo);

  it("declara la frontera y lleva las tres partes que pide Meta", () => {
    const frontera = contentType.split("boundary=")[1];
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(texto).toContain('name="messaging_product"');
    expect(texto).toContain('name="file"; filename="nota-de-voz.ogg"');
    expect(texto.endsWith(`--${frontera}--\r\n`)).toBe(true);
  });

  it("los bytes del audio viajan intactos", () => {
    const marca = cuerpo.indexOf(1);
    expect([...cuerpo.slice(marca, marca + 5)]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("el envío", () => {
  afterEach(() => vi.unstubAllGlobals());

  function metaResponde() {
    const llamadas: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      llamadas.push({ url: String(url), body: init?.body });
      if (String(url).endsWith("/media")) {
        return new Response(JSON.stringify({ id: "media-99" }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    });
    return llamadas;
  }

  it("sube el audio y lo manda como nota de voz", async () => {
    const llamadas = metaResponde();
    const id = await enviarNotaDeVoz(env, "51992117242", new ArrayBuffer(64), "audio/ogg;codecs=opus");
    expect(id).toBe("wamid.1");
    expect(llamadas[0].url).toContain("/123456/media");
    const enviado = JSON.parse(String(llamadas[llamadas.length - 1].body));
    expect(enviado).toMatchObject({ to: "51992117242", type: "audio", audio: { id: "media-99" } });
  });

  it("el MP4 fragmentado va como adjunto en vez de perderse", async () => {
    // Mandarlo como audio acaba en un 131053 que aparece tarde y deja a la
    // persona sin nada. Como documento sí llega: WhatsApp no lo procesa.
    const llamadas = metaResponde();
    await enviarNotaDeVoz(env, "51992117242", mp4Fragmentado(), "audio/mp4");
    const enviado = JSON.parse(String(llamadas[llamadas.length - 1].body));
    expect(enviado.type).toBe("document");
    expect(enviado.document).toMatchObject({ id: "media-99", filename: "Nota de voz.m4a" });
  });

  it("si Meta rechaza la subida, NO se manda ningún mensaje", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response('{"error":{"message":"nope"}}', { status: 400 });
    });
    await expect(
      enviarNotaDeVoz(env, "51992117242", new ArrayBuffer(8), "audio/ogg"),
    ).rejects.toThrow(/rechazó el audio/i);
    expect(urls.filter((u) => u.includes("/messages"))).toHaveLength(0);
  });

  it("sin llaves de WhatsApp avisa en claro", async () => {
    await expect(
      enviarNotaDeVoz({} as any, "51992117242", new ArrayBuffer(8), "audio/ogg"),
    ).rejects.toThrow(/Falta configurar WhatsApp/);
  });
});

describe("los errores se traducen", () => {
  it("la ventana de 24 horas se explica sin tecnicismos", () => {
    const msg = motivoEntendible(new Error("(400): (#131047) Re-engagement message"));
    expect(msg).toMatch(/24 horas/);
    expect(msg).not.toMatch(/131047/);
  });

  it("una llave caducada se nombra como tal", () => {
    expect(motivoEntendible(new Error("(401) Error validating access token: expired"))).toMatch(
      /llave de WhatsApp caducó/i,
    );
  });
});
