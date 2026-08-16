/**
 * DEVOLVER EL BOT EN UN SOLO CLIC.
 *
 * Antes hacían falta dos: uno para abrir el cuadro y otro para confirmar. Y si
 * no escribías nada, el sistema metía en el chat una nota de oficio que nadie
 * había escrito.
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
const FORM = { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" };

let env: Env;
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
  const db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
});

describe("un solo clic", () => {
  it("el primer clic devuelve el bot, sin escribir ni enviar nada", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51999", "Rosa");
    await convs.setPausedUntil(conv.id, Date.now() + 60_000);

    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/resume`,
      { method: "POST", headers: { ...AUTH, "HX-Request": "true" } },
      env,
    );

    expect(await convs.isPaused(conv.id)).toBe(false);
    // sin redibujar el hilo, que cerraría el cuadro a media frase
    expect(res.status).toBe(204);
    // y sin ensuciar el chat con una nota de oficio
    expect(await msgs.lastN(conv.id, 10)).toHaveLength(0);
  });

  it("el chip de la barra lo hace en el mismo clic", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51888", "Rosa");
    await convs.setPausedUntil(conv.id, Date.now() + 60_000);
    const html = await (
      await adminApp.request(
        `/conversations/thread/${encodeURIComponent(conv.id)}`,
        { headers: AUTH },
        env,
      )
    ).text();
    expect(html).toMatch(/<summary[^>]*hx-post="[^"]+\/resume"[^>]*hx-swap="none"/);
    // el botón de dentro ya no dice "devolver": solo manda la nota
    expect(html).toContain("Enviar al bot");
  });

  it("si escribes una nota, se guarda y el bot vuelve igual", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51777", "Rosa");
    await convs.setPausedUntil(conv.id, Date.now() + 60_000);
    await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/resume`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ summary: "le confirmé el pago" }) },
      env,
    );
    const historia = await msgs.lastN(conv.id, 5);
    expect(historia).toHaveLength(1);
    expect(historia[0].content).toContain("le confirmé el pago");
    expect(await convs.isPaused(conv.id)).toBe(false);
  });
});
