/**
 * CADA CHAT SE VE COMO LA APP DE LA QUE VIENE.
 *
 * No es decoración. Cuando conectas el número oficial de WhatsApp, deja de
 * funcionar en la app normal y tu equipo tiene que atender desde el panel. Si
 * ahí se ve como una terminal, el cambio se siente brusco y se cometen errores.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { temaDelCanal, estiloDelTema, colorDeMarca } from "../../src/admin/views/temaCanal";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const b64 = (s: string) =>
  typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf-8").toString("base64");
const AUTH = { Authorization: `Basic ${b64(`admin:${PASSWORD}`)}` };

let env: Env;
let convs: ConversationsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "Negocio de Prueba",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    DASHBOARD_PASSWORD: PASSWORD,
  } as unknown as Env;
  convs = new ConversationsRepo(new Db(d1));
});

describe("el tema de cada canal", () => {
  it("WhatsApp, Telegram e Instagram tienen el suyo", () => {
    const wa = temaDelCanal("whatsapp");
    const tg = temaDelCanal("telegram");
    expect(wa.nombre).toBe("WhatsApp");
    expect(tg.nombre).toBe("Telegram");
    expect(wa.fondo).not.toBe(tg.fondo);
  });

  it("un canal sin app propia se queda con el tema del panel", () => {
    const g = temaDelCanal("web");
    expect(g.fuente).toBe("inherit");
    expect(colorDeMarca("web")).toBe("var(--accent-2)");
  });

  // Un WhatsApp que entra por un proveedor intermedio se lee WhatsApp: al equipo
  // le importa POR DÓNDE le escribió el cliente, no con qué integración.
  it("el tema sale de la plataforma REAL, no del proveedor", () => {
    expect(temaDelCanal("zernio", "whatsapp").nombre).toBe("WhatsApp");
    expect(temaDelCanal("zernio", "telegram").nombre).toBe("Telegram");
    expect(temaDelCanal("zernio", null).fuente).toBe("inherit");
  });

  // La cadena de fuentes acaba DENTRO de un atributo style="…": con comillas
  // dobles el navegador corta el atributo ahí mismo y la fuente nunca se aplica.
  it("la pila de fuentes usa comillas simples", () => {
    const estilo = estiloDelTema(temaDelCanal("whatsapp"));
    expect(estilo).not.toContain('"');
    expect(estilo).toContain("font-family:");
  });

  it("el estilo trae todas las variables que usa el hilo", () => {
    const estilo = estiloDelTema(temaDelCanal("whatsapp"));
    for (const v of ["--ch-fondo", "--ch-barra", "--ch-propia", "--ch-ajena", "--ch-texto", "--ch-suave", "--ch-marca", "--ch-radio"]) {
      expect(estilo).toContain(v);
    }
  });
});

describe("el hilo se viste con él", () => {
  it("un chat de WhatsApp trae las variables del tema", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51999888777", "Rosa");
    const html = await (
      await adminApp.request(
        `/conversations/thread/${encodeURIComponent(conv.id)}`,
        { headers: AUTH },
        env,
      )
    ).text();
    expect(html).toContain("--ch-fondo");
    expect(html).toContain("background:var(--ch-fondo)");
  });

  // Alcance deliberado: la lista y los filtros conservan la identidad del panel.
  it("solo se viste el HILO, no el resto del panel", async () => {
    const conv = await convs.getOrCreate("telegram", "42", "Cliente");
    const pagina = await (
      await adminApp.request(`/conversations?c=${encodeURIComponent(conv.id)}`, { headers: AUTH }, env)
    ).text();
    const iHilo = pagina.indexOf("--ch-fondo");
    expect(iHilo).toBeGreaterThan(-1);
    // los filtros de la bandeja siguen con el color del panel
    expect(pagina).toContain("var(--accent)");
  });
});
