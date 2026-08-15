/**
 * BUZÓN DE REPORTES DEL EQUIPO.
 *
 * Quien atiende ve una respuesta mala del bot y la reporta ahí mismo. Lo que se
 * cuida aquí:
 *   · que se pueda reportar desde la pestaña y desde el hilo de un chat;
 *   · que listar, resolver y reabrir funcionen;
 *   · LA REGRESIÓN QUE IMPORTA: reportar desde una conversación NO puede
 *     ponerle el 🔔 de "necesita humano" a ese chat. Ese 🔔 es de los tickets
 *     que abre el BOT, y si el buzón lo enciende, la bandeja empieza a mentir.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { ReportesRepo } from "../../src/db/reportes";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const b64 = (s: string) =>
  typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf-8").toString("base64");
const AUTH = { Authorization: `Basic ${b64(`admin:${PASSWORD}`)}` };
const FORM = { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" };
const FORM_HTMX = { ...FORM, "HX-Request": "true" };

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let reportes: ReportesRepo;

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
  reportes = new ReportesRepo(db);
});

describe("el buzón", () => {
  it("guarda un reporte desde la pestaña", async () => {
    const res = await adminApp.request(
      "/reportes",
      {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({ texto: "contestó mal el horario", reportado_por: "Ana" }),
      },
      env,
    );
    expect(res.status).toBe(302);
    const lista = await reportes.listar();
    expect(lista).toHaveLength(1);
    expect(lista[0].texto).toBe("contestó mal el horario");
    expect(lista[0].reportado_por).toBe("Ana");
    expect(lista[0].estado).toBe("abierto");
  });

  it("ignora un reporte vacío", async () => {
    await adminApp.request(
      "/reportes",
      { method: "POST", headers: FORM, body: new URLSearchParams({ texto: "   " }) },
      env,
    );
    expect(await reportes.listar()).toHaveLength(0);
  });

  it("resolver y reabrir", async () => {
    const id = await reportes.crear({ tipo: "error", texto: "algo falló" });
    await adminApp.request(
      `/reportes/${id}/resolver`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ respuesta: "ya está" }) },
      env,
    );
    expect((await reportes.listar())[0].estado).toBe("resuelto");

    await adminApp.request(`/reportes/${id}/reabrir`, { method: "POST", headers: FORM }, env);
    expect((await reportes.listar())[0].estado).toBe("abierto");
  });

  it("la pestaña se abre y muestra lo reportado", async () => {
    await reportes.crear({ tipo: "error", texto: "se inventó un precio" });
    const html = await (await adminApp.request("/reportes", { headers: AUTH }, env)).text();
    expect(html).toContain("se inventó un precio");
  });
});

describe("reportar desde el chat", () => {
  it("el hilo trae el botón ⚑ con el formulario y el chat enganchado", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51999888777", "Rosa");
    const html = await (
      await adminApp.request(
        `/conversations/thread/${encodeURIComponent(conv.id)}`,
        { headers: AUTH },
        env,
      )
    ).text();
    expect(html).toContain("⚑ Reportar");
    expect(html).toContain('hx-post="/admin/reportes"');
    // sin esto, el reporte no diría de qué conversación habla
    expect(html).toContain(`name="conversation_id" value="${conv.id}"`);
  });

  it("desde el hilo responde un fragmento, sin sacarte del chat", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51999888777", "Rosa");
    const res = await adminApp.request(
      "/reportes",
      {
        method: "POST",
        headers: FORM_HTMX,
        body: new URLSearchParams({ texto: "respondió cualquier cosa", conversation_id: conv.id }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Reporte")).toBe("1");
    const lista = await reportes.listar();
    expect(lista[0].conversation_id).toBe(conv.id);
  });

  // LA REGRESIÓN QUE IMPORTA.
  it("reportar NO le pone el 🔔 de «necesita humano» a la conversación", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51999888777", "Rosa");
    await adminApp.request(
      "/reportes",
      {
        method: "POST",
        headers: FORM_HTMX,
        body: new URLSearchParams({ texto: "mal", conversation_id: conv.id }),
      },
      env,
    );
    const tickets = await db.all<any>("SELECT * FROM tickets WHERE conversation_id = ?", [conv.id]);
    expect(tickets).toHaveLength(0);

    const hilo = await (
      await adminApp.request(
        `/conversations/thread/${encodeURIComponent(conv.id)}`,
        { headers: AUTH },
        env,
      )
    ).text();
    expect(hilo).not.toContain("ticket abierto");
  });
});
