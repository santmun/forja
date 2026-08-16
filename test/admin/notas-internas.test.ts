/**
 * LO QUE LE ESCRIBES AL BOT NO PUEDE PARECER UN MENSAJE AL CLIENTE.
 *
 * Al devolverle una conversación al bot puedes dejarle una nota. Esa nota NO se
 * le envía a nadie — pero el panel la dibujaba igual que un mensaje enviado, con
 * el mismo pie, así que es facilísimo escribir algo ahí y quedarte con la duda
 * de si le llegó a la persona.
 *
 * Lo que se cuida aquí:
 *   · que la nota se guarde marcada y se dibuje como nota;
 *   · que NO se invente una nota cuando no escribiste nada;
 *   · y lo que de verdad importa: que los CUATRO consumidores de ese texto la
 *     traten como nota y no como algo que el bot dijo.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import {
  MessagesRepo,
  MARCA_NOTA,
  esNotaInterna,
  sinMarcaNota,
} from "../../src/db/messages";
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

describe("la marca", () => {
  it("reconoce y limpia una nota interna", () => {
    expect(esNotaInterna(`${MARCA_NOTA} ya le confirmé el pago`)).toBe(true);
    expect(sinMarcaNota(`${MARCA_NOTA} ya le confirmé el pago`)).toBe("ya le confirmé el pago");
  });

  it("un mensaje normal del dueño no es una nota", () => {
    expect(esNotaInterna("Buenas, ya le respondo")).toBe(false);
    expect(sinMarcaNota("Buenas, ya le respondo")).toBe("Buenas, ya le respondo");
  });
});

describe("devolver la conversación al bot", () => {
  it("guarda la nota MARCADA cuando escribiste algo", async () => {
    const conv = await convs.getOrCreate("telegram", "u1");
    await convs.setPausedUntil(conv.id, Date.now() + 60_000);
    await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/resume`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ summary: "le confirmé el pago" }) },
      env,
    );
    const historia = await msgs.lastN(conv.id, 5);
    const ultimo = historia[historia.length - 1];
    expect(esNotaInterna(ultimo.content)).toBe(true);
    expect(sinMarcaNota(ultimo.content)).toBe("le confirmé el pago");
    expect(await convs.isPaused(conv.id)).toBe(false);
  });

  it("NO inventa una nota si no escribiste nada", async () => {
    const conv = await convs.getOrCreate("telegram", "u2");
    await convs.setPausedUntil(conv.id, Date.now() + 60_000);
    await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/resume`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ summary: "   " }) },
      env,
    );
    expect(await msgs.lastN(conv.id, 5)).toHaveLength(0);
    // pero el bot sí vuelve
    expect(await convs.isPaused(conv.id)).toBe(false);
  });
});

describe("cómo se ve en el hilo", () => {
  it("la nota se dibuja como nota, y NO como un mensaje enviado", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51999", "Rosa");
    await msgs.append(conv.id, "owner", `${MARCA_NOTA} le confirmé el pago`);
    const html = await (
      await adminApp.request(
        `/conversations/thread/${encodeURIComponent(conv.id)}`,
        { headers: AUTH },
        env,
      )
    ).text();
    expect(html).toContain("Nota para el bot");
    expect(html).toContain("la persona no la vio");
    expect(html).toContain("le confirmé el pago");
    // la marca es de uso interno: no se le enseña a nadie
    expect(html).not.toContain(MARCA_NOTA);
    // y no lleva el pie de los mensajes que sí salieron
    expect(html).not.toContain("Tú · enviado");
  });

  it("un mensaje del dueño que SÍ se envió se sigue viendo como enviado", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51888", "Rosa");
    await msgs.append(conv.id, "owner", "Buenas, le respondo yo");
    const html = await (
      await adminApp.request(
        `/conversations/thread/${encodeURIComponent(conv.id)}`,
        { headers: AUTH },
        env,
      )
    ).text();
    expect(html).toContain("Tú · enviado");
    expect(html).not.toContain("Nota para el bot");
  });
});
