import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { adminAuth, checkBasicCredentials, ADMIN_USERNAME } from "../../src/admin/auth";
import type { Env } from "../../src/env";

const env = { DASHBOARD_PASSWORD: "secret123" } as unknown as Env;

/** base64("admin:secret123") === "YWRtaW46c2VjcmV0MTIz" */
const validHeader = "Basic YWRtaW46c2VjcmV0MTIz";

describe("checkBasicCredentials", () => {
  it("accepts the correct admin:secret123 header", () => {
    expect(checkBasicCredentials(validHeader, env)).toBe(true);
  });

  it("is case-insensitive on the Basic scheme keyword", () => {
    expect(checkBasicCredentials("basic YWRtaW46c2VjcmV0MTIz", env)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const header = `Basic ${btoa(`${ADMIN_USERNAME}:wrongpass`)}`;
    expect(checkBasicCredentials(header, env)).toBe(false);
  });

  it("rejects a wrong username", () => {
    const header = `Basic ${btoa("root:secret123")}`;
    expect(checkBasicCredentials(header, env)).toBe(false);
  });

  it("rejects an absent header", () => {
    expect(checkBasicCredentials(undefined, env)).toBe(false);
    expect(checkBasicCredentials(null, env)).toBe(false);
    expect(checkBasicCredentials("", env)).toBe(false);
  });

  it("rejects a malformed header (no Basic scheme)", () => {
    expect(checkBasicCredentials("Bearer YWRtaW46c2VjcmV0MTIz", env)).toBe(false);
    expect(checkBasicCredentials("YWRtaW46c2VjcmV0MTIz", env)).toBe(false);
  });

  it("rejects a payload that decodes without a colon separator", () => {
    const header = `Basic ${btoa("adminsecret123")}`;
    expect(checkBasicCredentials(header, env)).toBe(false);
  });

  it("uses the FIRST colon so passwords containing colons still work", () => {
    const colonEnv = { DASHBOARD_PASSWORD: "a:b:c" } as unknown as Env;
    const header = `Basic ${btoa("admin:a:b:c")}`;
    expect(checkBasicCredentials(header, colonEnv)).toBe(true);
  });
});

describe("adminAuth — sin DASHBOARD_PASSWORD el panel NO se abre", () => {
  /** Monta el guard igual que src/admin/routes.ts. */
  function appWith(dashboardPassword?: string) {
    const app = new Hono();
    const e = { DASHBOARD_PASSWORD: dashboardPassword } as unknown as Env;
    app.use("*", (c, next) => adminAuth(e)(c, next));
    app.get("/", (c) => c.text("panel"));
    return app;
  }

  it("responde 503 y no sirve el panel cuando falta el secret", async () => {
    const res = await appWith(undefined).request("/");
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("panel");
  });

  it("NO acepta admin:undefined cuando falta el secret", async () => {
    // Regresión: basicAuth compara contra sha256(String(password)), así que con
    // el secret ausente esta credencial literal entraba al panel.
    const res = await appWith(undefined).request("/", {
      headers: { Authorization: `Basic ${btoa("admin:undefined")}` },
    });
    expect(res.status).toBe(503);
  });

  it("trata un secret vacío igual que uno ausente", async () => {
    const res = await appWith("").request("/");
    expect(res.status).toBe(503);
  });

  it("con el secret configurado sigue pidiendo credenciales y acepta las buenas", async () => {
    const app = appWith("secret123");
    expect((await app.request("/")).status).toBe(401);
    const ok = await app.request("/", { headers: { Authorization: validHeader } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("panel");
  });
});

describe("checkBasicCredentials — sin secret configurado", () => {
  it("rechaza cualquier credencial, incluida la de password vacío", () => {
    const sinSecret = {} as unknown as Env;
    expect(checkBasicCredentials(`Basic ${btoa("admin:")}`, sinSecret)).toBe(false);
    expect(checkBasicCredentials(validHeader, sinSecret)).toBe(false);
  });
});
