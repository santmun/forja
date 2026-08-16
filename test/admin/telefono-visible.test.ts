/**
 * EL TELÉFONO DEL CLIENTE, SIEMPRE VISIBLE Y COPIABLE.
 *
 * En cuanto alguien le ponía nombre a un contacto, el número desaparecía del
 * panel — y es lo único con lo que el equipo puede contactar a esa persona
 * desde otro celular, o pasárselo a alguien que no tiene acceso al panel.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
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

const hilo = async (id: string) =>
  (await adminApp.request(`/conversations/thread/${encodeURIComponent(id)}`, { headers: AUTH }, env)).text();

describe("el contacto en la cabecera", () => {
  it("el número se ve AUNQUE el contacto ya tenga nombre", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51999888777", "Rosa Quispe");
    const html = await hilo(conv.id);
    expect(html).toContain("Rosa Quispe");
    expect(html).toContain("+51 999 888 777");
  });

  it("se puede copiar de un clic", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51999888777", "Rosa");
    expect(await hilo(conv.id)).toContain("clipboard.writeText");
  });

  it("lleva al chat de WhatsApp", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51999888777", "Rosa");
    expect(await hilo(conv.id)).toContain("api.whatsapp.com/send?phone=51999888777");
  });

  it("sin nombre, la cabecera lo dice y el número NO se repite dos veces", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51999888777");
    const html = await hilo(conv.id);
    expect(html).toContain("Sin nombre");
    expect(html.match(/\+51 999 888 777/g) ?? []).toHaveLength(1);
  });

  // Telegram no finge ser un teléfono: escribir "+42" sería mentir.
  it("Telegram muestra su id tal cual, sin disfrazarlo de teléfono", async () => {
    const conv = await convs.getOrCreate("telegram", "42", "Cliente");
    const html = await hilo(conv.id);
    // el id va suelto dentro del bloque de contacto, sin enlace ni formato
    expect(html).toMatch(/Copiar el contacto/);
    expect(html).toMatch(/>\s*42\s*</);
    expect(html).not.toContain("api.whatsapp.com");
    expect(html).not.toContain("+42");
  });
});
