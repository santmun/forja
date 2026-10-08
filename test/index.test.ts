import { describe, it, expect, vi } from "vitest";

// `src/index.ts` re-exports `SupportAgent` from `./agent`, which imports the
// `agents` SDK. `agents` (via `partyserver`) imports the virtual
// `cloudflare:workers` module at load time, which Node's ESM loader can't
// resolve outside workerd. Mock the `agents` package so the import graph stays
// in Node-land — we only exercise the Hono router here. Tests that need real
// agent/runtime behavior use Miniflare instead.
vi.mock("agents", () => ({ Agent: class {} }));

import worker from "../src/index";
import { VectorizeDimensionError } from "../src/kb/reindex";

describe("Worker entry", () => {
  const env = {
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Test",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "15",
    DASHBOARD_BASE_URL: "https://test.workers.dev",
  } as any;

  it("returns 200 on /health", async () => {
    const res = await worker.fetch(new Request("https://test/health"), env, {} as any);
    expect(res.status).toBe(200);
  });

  it("returns 404 on unknown route", async () => {
    const res = await worker.fetch(new Request("https://test/nope"), env, {} as any);
    expect(res.status).toBe(404);
  });

  describe("POST /kb/reindex", () => {
    const pedir = (headers: Record<string, string>, entorno: any = env) =>
      worker.fetch(
        new Request("https://test/kb/reindex", { method: "POST", headers }),
        entorno,
        {} as any,
      );

    it("responde unauthorized cuando el secret no está configurado", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await pedir({ "X-Reindex-Token": "loquesea" });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });

      // El cuerpo no distingue este caso del token equivocado — a propósito, para
      // no regalarle a quien llama el estado del Worker. Pero el dueño tiene que
      // poder distinguirlo desde `wrangler tail`, y ahí es donde va el aviso.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("KB_REINDEX_TOKEN"));
      warn.mockRestore();
    });

    it("responde unauthorized cuando el token no coincide, sin avisar al log", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await pedir({ "X-Reindex-Token": "equivocado" }, {
        ...env,
        KB_REINDEX_TOKEN: "el-bueno",
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
      // Acá el Worker sí está configurado: no hay nada que avisarle al dueño.
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("devuelve un mensaje claro si el índice de Vectorize no es de 1024", async () => {
      const spy = vi.spyOn(await import("../src/kb/reindex"), "reindexKb").mockRejectedValueOnce(
        new VectorizeDimensionError(
          "El índice de Vectorize tiene 768 dimensiones y no coincide con las 1024 de bge-m3. Recréalo con --dimensions=1024 --metric=cosine.",
        ),
      );
      const res = await pedir(
        { "X-Reindex-Token": "el-bueno" },
        { ...env, KB_REINDEX_TOKEN: "el-bueno" },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string; message: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("dimension_mismatch");
      expect(body.message).toContain("1024");
      expect(body.message).toContain("--dimensions=1024 --metric=cosine");
      expect(body.message).not.toBe("Internal Server Error");
      spy.mockRestore();
    });

    it("sigue respondiendo 500 si el reindex falla por otra cosa", async () => {
      const spy = vi.spyOn(await import("../src/kb/reindex"), "reindexKb").mockRejectedValueOnce(
        new Error("network down"),
      );
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await pedir(
        { "X-Reindex-Token": "el-bueno" },
        { ...env, KB_REINDEX_TOKEN: "el-bueno" },
      );
      expect(res.status).toBe(500);
      spy.mockRestore();
      err.mockRestore();
    });
  });
});
