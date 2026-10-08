/**
 * Tests for the Conocimiento (KB) tab routes + the budget save route.
 * Vectorize/AI stubbed; D1 real via miniflare.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { KbDocsRepo } from "../../src/kb/docs";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";

function basicAuthHeader(user: string, pass: string): string {
  const raw = `${user}:${pass}`;
  const b64 =
    typeof btoa === "function"
      ? btoa(raw)
      : Buffer.from(raw, "utf-8").toString("base64");
  return `Basic ${b64}`;
}

const AUTH = { Authorization: basicAuthHeader("admin", PASSWORD) };
const FORM = { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" };

let env: Env;
let repo: KbDocsRepo;
let kbUpsert: ReturnType<typeof vi.fn>;
let kbDelete: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  kbUpsert = vi.fn(async () => ({}));
  kbDelete = vi.fn(async () => ({}));
  env = {
    DB: d1,
    KB: { upsert: kbUpsert, deleteByIds: kbDelete },
    AI: {
      run: vi.fn(async (_m: string, input: { text: string[] }) => ({
        data: input.text.map(() => [0.1, 0.2]),
      })),
    },
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "Negocio de Prueba",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    DASHBOARD_PASSWORD: PASSWORD,
  } as unknown as Env;
  repo = new KbDocsRepo(new Db(d1));
});

describe("KB tab", () => {
  it("renders the list (empty state)", async () => {
    const res = await adminApp.request("/kb", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Conocimiento del bot");
    expect(html).toContain("Nuevo documento");
  });

  it("save persists the doc AND indexes it into Vectorize", async () => {
    const res = await adminApp.request(
      "/kb/save",
      {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({ title: "Horarios", content: "Abrimos 9-7 de lunes a sábado." }),
      },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/kb?saved=1");

    const docs = await repo.list();
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("Horarios");

    // Indexed on save: stale range deleted + fresh vector upserted.
    expect(kbDelete).toHaveBeenCalledTimes(1);
    expect(kbUpsert).toHaveBeenCalledTimes(1);
    const vectors = kbUpsert.mock.calls[0][0] as any[];
    expect(vectors[0].metadata.content).toContain("Abrimos 9-7");
  });

  it("editing keeps the same id (hidden field) and re-indexes", async () => {
    await adminApp.request(
      "/kb/save",
      { method: "POST", headers: FORM, body: new URLSearchParams({ title: "T", content: "v1" }) },
      env,
    );
    const [doc] = await repo.list();

    await adminApp.request(
      "/kb/save",
      { method: "POST", headers: FORM, body: new URLSearchParams({ id: doc.id, title: "T", content: "v2" }) },
      env,
    );
    const docs = await repo.list();
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("v2");
    expect(kbUpsert).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty save without touching the index", async () => {
    const res = await adminApp.request(
      "/kb/save",
      { method: "POST", headers: FORM, body: new URLSearchParams({ title: "", content: "" }) },
      env,
    );
    expect(res.status).toBe(302);
    expect(await repo.list()).toHaveLength(0);
    expect(kbUpsert).not.toHaveBeenCalled();
  });

  it("delete removes the doc and its vectors", async () => {
    await adminApp.request(
      "/kb/save",
      { method: "POST", headers: FORM, body: new URLSearchParams({ title: "T", content: "C" }) },
      env,
    );
    const [doc] = await repo.list();
    kbDelete.mockClear();

    const res = await adminApp.request(
      `/kb/${encodeURIComponent(doc.id)}/delete`,
      { method: "POST", headers: AUTH },
      env,
    );
    expect(res.status).toBe(302);
    expect(await repo.list()).toHaveLength(0);
    expect(kbDelete).toHaveBeenCalledTimes(1);
    expect((kbDelete.mock.calls[0][0] as string[])[0]).toBe(`dash:${doc.id}#0`);
  });

  it("requires auth", async () => {
    const res = await adminApp.request("/kb", {}, env);
    expect(res.status).toBe(401);
  });

  it("reindex tells you to recreate the index when the dimension does not match", async () => {
    await adminApp.request(
      "/kb/save",
      { method: "POST", headers: FORM, body: new URLSearchParams({ title: "Horarios", content: "Abrimos 9 a 7." }) },
      env,
    );
    kbUpsert.mockRejectedValueOnce(new Error("Vector dimension mismatch: expected 768, got 1024"));

    const res = await adminApp.request("/kb/reindex", { method: "POST", headers: AUTH }, env);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("768");
    expect(text).toContain("--dimensions=1024 --metric=cosine");
    expect(text).not.toContain("Internal Server Error");
  });
});

describe("budget save route", () => {
  it("stores a valid budget and clears it when empty", async () => {
    const settings = new SettingsRepo(new Db(env.DB));

    let res = await adminApp.request(
      "/costs/budget",
      { method: "POST", headers: FORM, body: new URLSearchParams({ monthly_budget: "25" }) },
      env,
    );
    expect(res.status).toBe(302);
    expect(await settings.get(SETTING_KEYS.monthlyBudget)).toBe("25");

    res = await adminApp.request(
      "/costs/budget",
      { method: "POST", headers: FORM, body: new URLSearchParams({ monthly_budget: "" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.monthlyBudget)).toBe("");
  });

  it("ignores garbage values (clears the cap)", async () => {
    const settings = new SettingsRepo(new Db(env.DB));
    await adminApp.request(
      "/costs/budget",
      { method: "POST", headers: FORM, body: new URLSearchParams({ monthly_budget: "mucho" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.monthlyBudget)).toBe("");
  });
});
