import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("agents", () => ({ Agent: class {} }));

import worker from "../src/index";
import { demoClientScript, demoEnabled, demoOverLimit, DEMO_FOLLOW_MS, DEMO_GIVE_UP_MS } from "../src/demo";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";

const baseEnv = {
  BOT_NAME: "Fer",
  BUSINESS_NAME: "Barbería Atlas",
  BOT_LANGUAGE: "es",
  BOT_TIER: "pro",
  BUFFER_SECONDS: "15",
  DASHBOARD_BASE_URL: "https://test.workers.dev",
} as any;

const on = { ...baseEnv, DEMO_MODE: "on" };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("modo demo — interruptor", () => {
  it("apagado por defecto", () => {
    expect(demoEnabled(baseEnv)).toBe(false);
    expect(demoEnabled({ ...baseEnv, DEMO_MODE: "off" })).toBe(false);
  });

  it("se enciende con DEMO_MODE=on, sin importar mayúsculas", () => {
    expect(demoEnabled(on)).toBe(true);
    expect(demoEnabled({ ...baseEnv, DEMO_MODE: "ON" })).toBe(true);
  });

  it("corta la sesión al llegar al tope de turnos", () => {
    expect(demoOverLimit(39)).toBe(false);
    expect(demoOverLimit(40)).toBe(true);
  });
});

describe("modo demo — rutas", () => {
  it("/demo da 404 cuando está apagado", async () => {
    const res = await worker.fetch(new Request("https://test/demo"), baseEnv, {} as any);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("/demo/send da 404 cuando está apagado", async () => {
    const res = await worker.fetch(
      new Request("https://test/demo/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", text: "hola" }),
      }),
      baseEnv,
      {} as any,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "demo_off" });
  });

  it("sirve la página con la marca y sin el cursor del reloj del navegador", async () => {
    const res = await worker.fetch(new Request("https://test/demo"), on, {} as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Barbería Atlas");
    expect(html).toContain("/demo/send");
    expect(html).toContain("/demo/poll");
    expect(html).toContain("after=0");
    expect(html).not.toMatch(/since\s*=\s*Date\.now\(\)/);
    expect(html).toContain(String(DEMO_FOLLOW_MS));
    expect(html).toContain(String(DEMO_GIVE_UP_MS));
  });

  it("escapa el nombre del negocio", async () => {
    const res = await worker.fetch(
      new Request("https://test/demo"),
      { ...on, BUSINESS_NAME: "<script>alert(1)</script>" } as any,
      {} as any,
    );
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("/demo/poll exige sesión", async () => {
    const res = await worker.fetch(new Request("https://test/demo/poll"), on, {} as any);
    expect(res.status).toBe(400);
  });

  it("/demo/poll filtra por created_at del servidor y no devuelve al visitante", async () => {
    const mf = await createTestMiniflare();
    const db = new Db((await mf.getD1Database("DB")) as any);
    const conv = await new ConversationsRepo(db).getOrCreate("web", "sesion-1");
    const msgs = new MessagesRepo(db);
    await msgs.append(conv.id, "user", "hola", { createdAt: 1000 });
    await msgs.append(conv.id, "assistant", "primera", { createdAt: 1500 });
    await msgs.append(conv.id, "assistant", "segunda", { createdAt: 3000 });

    const env = { ...on, DB: db.d1 };
    const pedir = (after: number) =>
      worker.fetch(new Request(`https://test/demo/poll?session=sesion-1&after=${after}`), env, {} as any);

    const todo = await (await pedir(0)).json() as { messages: { id: string; text: string; at: number }[] };
    expect(todo.messages.map((m) => m.text)).toEqual(["primera", "segunda"]);
    expect(todo.messages[0].at).toBe(1500);
    expect(todo.messages[0].id).toBeTruthy();

    const solo = await (await pedir(1500)).json() as { messages: { text: string }[] };
    expect(solo.messages.map((m) => m.text)).toEqual(["segunda"]);

    const nada = await (await pedir(3000)).json() as { messages: unknown[] };
    expect(nada.messages).toEqual([]);
  });

  it("/demo/poll devuelve lista vacía si la sesión no existe", async () => {
    const mf = await createTestMiniflare();
    const env = { ...on, DB: await mf.getD1Database("DB") };
    const res = await worker.fetch(
      new Request("https://test/demo/poll?session=nueva&after=0"),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messages: [] });
  });

  it("rechaza el turno 41 sin llamar al agente", async () => {
    const env = {
      ...on,
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () => (sql.includes("COUNT") ? { n: 40 } : null),
            all: async () => ({ results: [] }),
          }),
        }),
      },
    };
    const res = await worker.fetch(
      new Request("https://test/demo/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", text: "otra" }),
      }),
      env,
      {} as any,
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "limit" });
  });
});

describe("cliente de /demo", () => {
  it("no arma el cursor con el reloj y no corta el sondeo en la primera burbuja", () => {
    const script = demoClientScript();
    expect(script).not.toMatch(/since\s*=\s*Date\.now\(\)/);
    expect(script).toContain("&after=0");
    expect(script).toContain("seen[");
    const pollFn = script.slice(script.indexOf("function poll("), script.indexOf("var listo"));
    // pararSondeo solo corre dentro del timeout de gracia, no al pintar la primera burbuja.
    const antesDelTimeout = pollFn.slice(0, pollFn.indexOf("setTimeout"));
    expect(antesDelTimeout).not.toContain("pararSondeo");
    expect(pollFn).toContain("pararSondeo()");
    expect(pollFn).toContain("followTimer");
    expect(pollFn).toContain(String(DEMO_FOLLOW_MS));
  });

  it("pinta la respuesta aunque el reloj del visitante vaya adelantado, y la burbuja siguiente", async () => {
    vi.useFakeTimers();
    const serverNow = 1_700_000_000_000;
    vi.setSystemTime(serverNow + 3 * 60_000);

    const stored: { id: string; text: string; at: number }[] = [
      { id: "old", text: "historial", at: serverNow - 10_000 },
    ];
    const polls: number[] = [];

    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url, "https://test");
      if (u.pathname === "/demo/poll") {
        const after = Number(u.searchParams.get("after") ?? 0);
        polls.push(after);
        return new Response(JSON.stringify({
          ok: true,
          messages: stored.filter((m) => m.at > after),
        }));
      }
      stored.push({ id: "a", text: "primera burbuja", at: serverNow });
      return new Response("ok", { status: 200 });
    });

    const bubbles: string[] = [];
    const nodes = new Map<string, any>();
    function makeEl() {
      const node: any = {
        style: {},
        children: [] as any[],
        className: "",
        textContent: "",
        innerHTML: "",
        _id: "",
        listeners: {} as Record<string, Function>,
        appendChild(child: any) {
          this.children.push(child);
          if (this._id === "chat" && child.textContent) bubbles.push(child.textContent);
          // el texto vive en .bub, no en el row
          if (child.className?.startsWith?.("bub") && this.className?.includes?.("row")) {
            bubbles.push(child.textContent);
          }
          return child;
        },
        addEventListener(ev: string, fn: Function) { this.listeners[ev] = fn; },
        remove() {},
      };
      Object.defineProperty(node, "id", {
        get: () => node._id,
        set: (v: string) => { node._id = v; nodes.set(v, node); },
      });
      return node;
    }

    const chat = makeEl();
    chat.id = "chat";
    const ta = makeEl();
    ta.id = "t";
    ta.value = "";
    const btn = makeEl();
    btn.id = "s";
    btn.disabled = false;
    const document = {
      getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: () => makeEl(),
    };
    const localStorage = {
      getItem: () => "sesion-prueba",
      setItem: () => {},
    };

    const runner = new Function(
      "document", "localStorage", "crypto", "fetch",
      "setInterval", "clearInterval", "setTimeout", "clearTimeout",
      "encodeURIComponent",
      demoClientScript(),
    );
    runner(
      document, localStorage,
      { randomUUID: () => "uuid-fijo" },
      fetchMock,
      globalThis.setInterval,
      globalThis.clearInterval,
      globalThis.setTimeout,
      globalThis.clearTimeout,
      encodeURIComponent,
    );

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(bubbles).not.toContain("historial");
    expect(polls[0]).toBe(0);

    ta.value = "hola";
    btn.listeners.click();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // El primer sondeo del turno pide desde el cursor del servidor (el historial),
    // no desde el reloj adelantado.
    await vi.advanceTimersByTimeAsync(1200);
    expect(polls.some((n) => n >= serverNow + 60_000)).toBe(false);
    expect(bubbles).toContain("primera burbuja");

    stored.push({ id: "b", text: "segunda burbuja", at: serverNow + 1500 });
    await vi.advanceTimersByTimeAsync(1200);
    expect(bubbles).toContain("segunda burbuja");
  });
});
