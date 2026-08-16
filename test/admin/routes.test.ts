import { describe, it, expect } from "vitest";
import { adminApp } from "../../src/admin/routes";
import { ADMIN_USERNAME } from "../../src/admin/auth";
import { SETTING_KEYS } from "../../src/db/settings";
import type { Env } from "../../src/env";

type Row = Record<string, unknown>;

/**
 * Minimal in-memory D1 stub: returns canned results based on a matcher list.
 * Each query is matched in order; the first matching SQL fragment wins.
 * `run` records executed SQL + bound params for assertions.
 */
function makeStubDb(
  matchers: Array<{ frag: string; first?: Row; all?: Row[] }> = [],
  runLog?: Array<{ sql: string; params: unknown[] }>,
): D1Database {
  const handler = (sql: string) => {
    for (const m of matchers) {
      if (sql.includes(m.frag)) return m;
    }
    return { first: undefined, all: [] as Row[] };
  };
  const makeStmt = (sql: string) => {
    const matched = handler(sql);
    let bound: unknown[] = [];
    const stmt: any = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt;
      },
      first: async () => matched.first ?? null,
      all: async () => ({ results: matched.all ?? [] }),
      run: async () => {
        runLog?.push({ sql, params: bound });
        return {};
      },
    };
    return stmt;
  };
  return {
    prepare: (sql: string) => makeStmt(sql),
  } as unknown as D1Database;
}

const PASSWORD = "secret123";

function makeEnv(db: D1Database = makeStubDb()): Env {
  return {
    DB: db,
    DASHBOARD_PASSWORD: PASSWORD,
    BUSINESS_NAME: "Test Biz",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    OWNER_EMAIL: "owner@example.com",
  } as unknown as Env;
}

function basicHeader(user: string, pass: string): string {
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return `Basic ${token}`;
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://bot.test${path}`, init);
}

describe("admin routes — auth", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await adminApp.fetch(req("/overview"), makeEnv());
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong credentials", async () => {
    const res = await adminApp.fetch(
      req("/overview", { headers: { Authorization: basicHeader(ADMIN_USERNAME, "wrong") } }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct credentials", async () => {
    const env = makeEnv(
      makeStubDb([
        { frag: "FROM messages WHERE created_at", first: { n: 3 } },
        { frag: "FROM leads WHERE created_at", first: { n: 1 } },
        { frag: "GROUP BY model_used", all: [] },
        { frag: "FROM tickets", first: { n: 0 } },
      ]),
    );
    const res = await adminApp.fetch(
      req("/overview", { headers: { Authorization: basicHeader(ADMIN_USERNAME, PASSWORD) } }),
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("mensajes");
  });
});

describe("admin routes — navigation", () => {
  const authHeaders = { Authorization: basicHeader(ADMIN_USERNAME, PASSWORD) };

  it("redirects / to /admin/overview", async () => {
    const res = await adminApp.fetch(req("/", { headers: authHeaders }), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/overview");
  });

  it("renders leads tab", async () => {
    const res = await adminApp.fetch(req("/leads", { headers: authHeaders }), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Leads");
  });

  it("renders tickets tab", async () => {
    const res = await adminApp.fetch(req("/tickets", { headers: authHeaders }), makeEnv());
    expect(res.status).toBe(200);
  });

  it("renders config tab", async () => {
    const res = await adminApp.fetch(req("/config", { headers: authHeaders }), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Test Biz");
  });

  // El campo escribe system_prompt_override: lo que se escriba ahí sustituye al
  // prompt completo. Con la etiqueta anterior ("Instrucciones personalizadas")
  // y su ejemplo de una sola regla, era razonable creer que se sumaba.
  it("warns that the prompt field replaces the whole prompt when it is empty", async () => {
    const res = await adminApp.fetch(req("/config", { headers: authHeaders }), makeEnv());
    const html = await res.text();
    expect(html).toContain("REEMPLAZA el prompt completo");
    expect(html).toContain("Mi Agente → Flujo");
    // El ejemplo viejo invitaba justo al error que este aviso evita.
    expect(html).not.toContain("Ej. Siempre ofrece agendar una cita al final.");
  });

  it("shows manual mode when a prompt override is already saved", async () => {
    const env = makeEnv(
      makeStubDb([
        {
          frag: "SELECT key, value FROM settings",
          all: [{ key: SETTING_KEYS.systemPromptOverride, value: "Responde siempre en verso." }],
        },
      ]),
    );
    const res = await adminApp.fetch(req("/config", { headers: authHeaders }), env);
    const html = await res.text();
    expect(html).toContain("Modo manual");
    expect(html).toContain("Responde siempre en verso.");
  });

  it("exports leads as CSV", async () => {
    const res = await adminApp.fetch(req("/leads/export.csv", { headers: authHeaders }), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });
});

describe("admin routes — mutations", () => {
  const authHeaders = { Authorization: basicHeader(ADMIN_USERNAME, PASSWORD) };

  it("sets a lead status and redirects back to /admin/leads", async () => {
    const runLog: Array<{ sql: string; params: unknown[] }> = [];
    const env = makeEnv(makeStubDb([], runLog));
    const body = new URLSearchParams({ status: "sold" });
    const res = await adminApp.fetch(
      req("/leads/lead-1/status", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/leads");
    const update = runLog.find((r) => r.sql.includes("UPDATE leads SET status"));
    expect(update).toBeTruthy();
    expect(update!.params).toContain("sold");
    expect(update!.params).toContain("lead-1");
  });

  it("falls back to status 'new' for an invalid status", async () => {
    const runLog: Array<{ sql: string; params: unknown[] }> = [];
    const env = makeEnv(makeStubDb([], runLog));
    const body = new URLSearchParams({ status: "bogus" });
    await adminApp.fetch(
      req("/leads/lead-2/status", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
    );
    const update = runLog.find((r) => r.sql.includes("UPDATE leads SET status"));
    expect(update!.params).toContain("new");
  });

  it("resolves a ticket and redirects back to /admin/tickets", async () => {
    const runLog: Array<{ sql: string; params: unknown[] }> = [];
    const env = makeEnv(makeStubDb([], runLog));
    const body = new URLSearchParams({ resolved_by: "me@example.com" });
    const res = await adminApp.fetch(
      req("/tickets/ticket-1/resolve", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/tickets");
    const update = runLog.find((r) => r.sql.includes("UPDATE tickets SET status"));
    expect(update).toBeTruthy();
    expect(update!.params).toContain("me@example.com");
    expect(update!.params).toContain("ticket-1");
  });

  it("returns a conversation back to the bot (clears paused_until)", async () => {
    const runLog: Array<{ sql: string; params: unknown[] }> = [];
    const env = makeEnv(makeStubDb([], runLog));
    const res = await adminApp.fetch(
      req("/conversations/telegram:42/resume", { method: "POST", headers: authHeaders }),
      env,
    );
    expect(res.status).toBe(302);
    const update = runLog.find((r) => r.sql.includes("UPDATE conversations SET paused_until"));
    expect(update).toBeTruthy();
    expect(update!.params).toContain(null);
    expect(update!.params).toContain("telegram:42");
  });

  it("blocks a mutation without auth (401)", async () => {
    const env = makeEnv();
    const res = await adminApp.fetch(
      req("/leads/lead-1/status", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ status: "sold" }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("admin routes — config save (POST /config)", () => {
  const authHeaders = { Authorization: basicHeader(ADMIN_USERNAME, PASSWORD) };

  /** Collect every settings UPSERT as a key -> value map from the run log. */
  function settingsWrites(runLog: Array<{ sql: string; params: unknown[] }>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of runLog) {
      if (r.sql.includes("INSERT INTO settings")) {
        const [key, value] = r.params as [string, string];
        out[key] = value;
      }
    }
    return out;
  }

  it("maps card selections (labels and values) to persisted values", async () => {
    const runLog: Array<{ sql: string; params: unknown[] }> = [];
    const env = makeEnv(makeStubDb([], runLog));
    const body = new URLSearchParams({
      [SETTING_KEYS.tone]: "Formal", // label -> "formal y profesional"
      [SETTING_KEYS.bufferSeconds]: "Rápido", // label -> "5"
      [SETTING_KEYS.maxChunks]: "3", // raw value -> "3"
      [SETTING_KEYS.modelOverride]: "sonnet", // raw value -> "sonnet"
      [SETTING_KEYS.botPaused]: "1", // raw value -> "1"
    });
    const res = await adminApp.fetch(
      req("/config", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/config?saved=1");

    const writes = settingsWrites(runLog);
    expect(writes[SETTING_KEYS.tone]).toBe("formal y profesional");
    expect(writes[SETTING_KEYS.bufferSeconds]).toBe("5");
    expect(writes[SETTING_KEYS.maxChunks]).toBe("3");
    expect(writes[SETTING_KEYS.modelOverride]).toBe("sonnet");
    expect(writes[SETTING_KEYS.botPaused]).toBe("1");
  });

  it("stores free-text fields verbatim (trimmed)", async () => {
    const runLog: Array<{ sql: string; params: unknown[] }> = [];
    const env = makeEnv(makeStubDb([], runLog));
    const body = new URLSearchParams({
      [SETTING_KEYS.botName]: "  Barbería Pro  ",
      [SETTING_KEYS.businessContext]: "Abrimos 9-7. Corte $150.",
      [SETTING_KEYS.systemPromptOverride]: "",
      [SETTING_KEYS.escalationKeywords]: "queja, reembolso",
    });
    await adminApp.fetch(
      req("/config", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
    );

    const writes = settingsWrites(runLog);
    expect(writes[SETTING_KEYS.botName]).toBe("Barbería Pro");
    expect(writes[SETTING_KEYS.businessContext]).toBe("Abrimos 9-7. Corte $150.");
    expect(writes[SETTING_KEYS.systemPromptOverride]).toBe("");
    expect(writes[SETTING_KEYS.escalationKeywords]).toBe("queja, reembolso");
  });

  it("falls back to the first option for an unknown card value", async () => {
    const runLog: Array<{ sql: string; params: unknown[] }> = [];
    const env = makeEnv(makeStubDb([], runLog));
    const body = new URLSearchParams({ [SETTING_KEYS.tone]: "bogus" });
    await adminApp.fetch(
      req("/config", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
    );
    const writes = settingsWrites(runLog);
    // First TONE option value is "cálido y cercano".
    expect(writes[SETTING_KEYS.tone]).toBe("cálido y cercano");
  });

  it("blocks saving config without auth (401)", async () => {
    const runLog: Array<{ sql: string; params: unknown[] }> = [];
    const env = makeEnv(makeStubDb([], runLog));
    const res = await adminApp.fetch(
      req("/config", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ [SETTING_KEYS.tone]: "Formal" }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(runLog.length).toBe(0); // nothing persisted
  });
});
