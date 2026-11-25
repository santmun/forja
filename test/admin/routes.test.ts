import { describe, it, expect } from "vitest";
import { adminApp } from "../../src/admin/routes";
import { ADMIN_USERNAME } from "../../src/admin/auth";
import { SETTING_KEYS } from "../../src/db/settings";
import type { Env } from "../../src/env";
import type { Lead } from "../../src/db/leads";
import { buildLeadsCsv } from "../../src/admin/views/leads";
import { todayInTz } from "../../src/time/resolveDate";

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
    const filename = `prospectos-${todayInTz("America/Mexico_City")}.csv`;
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${filename}"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Excel en Windows solo respeta el UTF-8 si los bytes empiezan con EF BB BF.
    // res.text() se los come al decodificar, así que se miran crudos.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder("utf-8").decode(bytes);
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
    expect(parseCsv(csv)).toEqual([["Fecha", "Hora", "Nombre", "Contacto", "Resumen", "Notas", "Estado"]]);
  });

  it("exports prospectos readable in Excel: labels, timezone, metadata columns, formula guard", async () => {
    const created = Date.parse("2026-01-15T18:45:00.000Z");
    const env = makeEnv(
      makeStubDb([
        {
          frag: "FROM leads",
          all: [
            leadRow({
              name: "Moisés",
              contact: "+52 81 0000",
              intent: "Quiere \"cotización\"\nurgente",
              notes: "=HYPERLINK(\"http://evil\")",
              status: "contacted",
              metadata: JSON.stringify({
                empresa: "Café",
                necesidad: "CRM",
                presupuesto: "10k",
                extra_nota: "hola, mundo",
              }),
              created_at: created,
            }) as unknown as Row,
          ],
        },
      ]),
    );
    env.BOT_TIMEZONE = "No/Existe";
    env.CALCOM_TIMEZONE = "America/Mexico_City";
    const res = await adminApp.fetch(req("/leads/export.csv", { headers: authHeaders }), env);
    const csv = await res.text();
    expect(parseCsv(csv)).toEqual([
      ["Fecha", "Hora", "Nombre", "Contacto", "Empresa", "Necesidad", "Presupuesto", "Extra Nota", "Resumen", "Notas", "Estado"],
      [
        "2026-01-15",
        "12:45",
        "Moisés",
        "'+52 81 0000",
        "Café",
        "CRM",
        "10k",
        "hola, mundo",
        "Quiere \"cotización\" urgente",
        "'=HYPERLINK(\"http://evil\")",
        "Contactado",
      ],
    ]);
    expect(csv).not.toContain("metadata");
    expect(csv).not.toContain("contacted");
  });

  it("uses BOT_TIMEZONE before CALCOM_TIMEZONE for the file date and the hour", async () => {
    const created = Date.parse("2026-01-15T18:45:00.000Z");
    const env = makeEnv(
      makeStubDb([
        {
          frag: "FROM leads",
          all: [leadRow({ name: "Ana", status: "new", created_at: created }) as unknown as Row],
        },
      ]),
    );
    env.BOT_TIMEZONE = "America/Bogota";
    env.CALCOM_TIMEZONE = "Europe/Madrid";
    const res = await adminApp.fetch(req("/leads/export.csv", { headers: authHeaders }), env);
    expect(res.headers.get("content-disposition")).toContain(
      `filename="prospectos-${todayInTz("America/Bogota")}.csv"`,
    );
    const [, row] = parseCsv(await res.text());
    expect(row[0]).toBe("2026-01-15");
    expect(row[1]).toBe("13:45");
    expect(row[row.length - 1]).toBe("Nuevo");
  });
});

function leadRow(partial: Partial<Lead> & Pick<Lead, "name" | "status" | "created_at">): Lead {
  return {
    id: "lead-1",
    conversation_id: null,
    contact: null,
    channel_user_id: null,
    intent: "",
    notes: null,
    exported_to: null,
    external_id: null,
    metadata: null,
    updated_at: partial.created_at,
    ...partial,
  };
}

/** Lee el CSV del export (BOM, comillas y CRLF) a filas. */
function parseCsv(body: string): string[][] {
  const text = body.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\r") {
      // CRLF lo cierra el \n
    } else if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else {
      cur += ch;
    }
  }
  return rows;
}

describe("leads CSV — columnas del nicho", () => {
  it("reparte metadata en las columnas del nicho, traduce el estado y aplana extras", () => {
    const created = Date.parse("2026-06-02T04:00:00.000Z");
    const csv = buildLeadsCsv(
      [
        leadRow({
          name: "Moisés",
          contact: "-interno",
          intent: "linea1\r\nlinea2",
          notes: "@suma",
          status: "contacted",
          metadata: JSON.stringify({
            empresa: "Horizonte",
            necesidad: "Pipeline",
            presupuesto: "50k",
            origen_lead: "Referido",
          }),
          created_at: created,
        }),
      ],
      {
        columns: [
          { key: "empresa", label: "Empresa" },
          { key: "necesidad", label: "Necesidad" },
          { key: "presupuesto", label: "Presupuesto" },
        ],
        statusLabels: { new: "Nuevo", contacted: "Calificado", sold: "Ganado", lost: "Perdido" },
      },
      "America/Mexico_City",
    );
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(parseCsv(csv)).toEqual([
      ["Fecha", "Hora", "Nombre", "Contacto", "Empresa", "Necesidad", "Presupuesto", "Origen Lead", "Resumen", "Notas", "Estado"],
      [
        "2026-06-01",
        "22:00",
        "Moisés",
        "'-interno",
        "Horizonte",
        "Pipeline",
        "50k",
        "Referido",
        "linea1 linea2",
        "'@suma",
        "Calificado",
      ],
    ]);
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
