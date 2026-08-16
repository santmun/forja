/**
 * LA BARRA DE ARRIBA DEL CHAT.
 *
 * Lo que se cuida: que cada cosa esté SIEMPRE en el mismo sitio (antes los
 * botones se corrían según cuántas etiquetas tuviera ese chat) y que la fila
 * única se pida por el ancho REAL del chat, no por el de la ventana.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const b64 = (s: string) =>
  typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf-8").toString("base64");
const AUTH = { Authorization: `Basic ${b64(`admin:${PASSWORD}`)}` };

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;

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
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
});

const hilo = async (id: string) =>
  (await adminApp.request(`/conversations/thread/${encodeURIComponent(id)}`, { headers: AUTH }, env)).text();

const bloques = (html: string) => ({
  quien: html.indexOf('class="hilo-quien"'),
  marcas: html.indexOf('class="hilo-marcas"'),
  acciones: html.indexOf('class="hilo-acciones"'),
});

describe("los tres bloques", () => {
  it("van siempre en el mismo orden, haya o no etiquetas", async () => {
    const pelado = await convs.getOrCreate("whatsapp", "51900000001", "Sin nada");
    const cargado = await convs.getOrCreate("whatsapp", "51900000002", "Con todo");
    await db.run(
      "INSERT INTO tickets (id, conversation_id, category, summary, transcript, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["t-1", cargado.id, "duda", "necesita humano", "—", Date.now()],
    );
    await convs.setPausedUntil(cargado.id, Date.now() + 60_000);

    for (const conv of [pelado, cargado]) {
      const b = bloques(await hilo(conv.id));
      expect(b.quien).toBeGreaterThan(-1);
      expect(b.marcas).toBeGreaterThan(b.quien);
      expect(b.acciones).toBeGreaterThan(b.marcas);
    }
  });

  it("la forma de partida son DOS filas, que siempre caben", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51900000003", "Cliente");
    expect(await hilo(conv.id)).toContain("flex-wrap:wrap");
  });

  it("la fila única se pide por el ancho del CHAT, no el de la ventana", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51900000004", "Cliente");
    const html = await hilo(conv.id);
    expect(html).toContain("@container (min-width: 620px)");
    // y el nombre nunca puede encogerse hasta desaparecer
    expect(html).toContain("min-width:150px");
  });

  it("el chat declara container-type para que el container query mida", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51900000005", "Cliente");
    const pagina = await (
      await adminApp.request(`/conversations?c=${encodeURIComponent(conv.id)}`, { headers: AUTH }, env)
    ).text();
    expect(pagina).toContain("container-type:inline-size");
  });
});

describe("una URL larga no empuja el panel", () => {
  it("las burbujas parten las palabras que no caben", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51900000006", "Cliente");
    await msgs.append(conv.id, "user", "mira esto https://ejemplo.com/" + "x".repeat(200));
    const html = await hilo(conv.id);
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("min-width:0");
  });
});
