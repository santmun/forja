/**
 * LA ETIQUETA "NEUTRAL" NO SE MUESTRA.
 *
 * El analizador clasifica cómo quedó el cliente en cuatro casillas, y "neutral"
 * es la de "no detecté nada": es la enorme mayoría de las conversaciones. Una
 * etiqueta que sale casi siempre y no dice nada solo roba sitio y le quita
 * fuerza a las que sí importan.
 *
 * La lista de conversaciones ya filtraba así (solo frustrated/angry); esto lo
 * alinea en la cabecera del chat.
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
let db: Db;
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
  db = new Db(d1);
  convs = new ConversationsRepo(db);
});

async function hiloCon(sentimiento: string) {
  const conv = await convs.getOrCreate("whatsapp", `51${sentimiento}`, "Cliente");
  await db.run(
    "INSERT OR REPLACE INTO conversation_insights (conversation_id, analyzed_at, sentiment) VALUES (?, ?, ?)",
    [conv.id, Date.now(), sentimiento],
  );
  return (
    await adminApp.request(
      `/conversations/thread/${encodeURIComponent(conv.id)}`,
      { headers: AUTH },
      env,
    )
  ).text();
}

describe("etiqueta de cómo quedó el cliente", () => {
  it("«Neutral» no se muestra: no dice nada", async () => {
    expect(await hiloCon("neutral")).not.toContain("Neutral");
  });

  it("las que sí dicen algo se siguen mostrando", async () => {
    expect(await hiloCon("frustrated")).toContain("Frustrado");
    expect(await hiloCon("angry")).toContain("Enojado");
    expect(await hiloCon("positive")).toContain("Contento");
  });

  it("una conversación sin analizar tampoco muestra nada", async () => {
    const conv = await convs.getOrCreate("whatsapp", "51000", "Cliente");
    const html = await (
      await adminApp.request(
        `/conversations/thread/${encodeURIComponent(conv.id)}`,
        { headers: AUTH },
        env,
      )
    ).text();
    for (const t of ["Neutral", "Frustrado", "Enojado", "Contento"]) {
      expect(html).not.toContain(t);
    }
  });
});
