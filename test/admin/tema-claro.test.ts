/**
 * TEMA CLARO DEL PANEL.
 *
 * Lo que se cuida aquí es que sea SEGURO de aplicar:
 *   · sin la variable, el panel sale byte por byte como siempre;
 *   · con ella, solo cambian color y tipografía — ninguna regla mueve, quita ni
 *     reordena nada de la pantalla.
 */
import { describe, it, expect } from "vitest";
import { temaClaro } from "../../src/admin/views/temaClaro";
import { layout } from "../../src/admin/views/layout";
import type { Env } from "../../src/env";

const env = (extra: Partial<Env> = {}) =>
  ({ BOT_NAME: "Bot", BUSINESS_NAME: "Negocio", BOT_TIER: "pro", ...extra }) as unknown as Env;

describe("temaClaro", () => {
  it("no devuelve nada si el tema no está encendido", () => {
    expect(temaClaro(undefined)).toBe("");
    expect(temaClaro(env())).toBe("");
    expect(temaClaro(env({ PANEL_TEMA: "otro" } as Partial<Env>))).toBe("");
  });

  it("el panel queda IDÉNTICO sin la variable", () => {
    const args = { title: "T", activeTab: "overview", body: "<p>hola</p>" };
    expect(layout({ ...args, env: env() })).toBe(layout({ ...args, env: env() }));
    // y no se cuela ni un rastro del tema
    expect(layout({ ...args, env: env() })).not.toContain("PANEL_TEMA");
    expect(layout({ ...args, env: env() })).not.toContain("fonts.googleapis.com/css2?family=Fira");
  });

  it("con la variable, se aplica al panel", () => {
    const html = layout({
      title: "T",
      activeTab: "overview",
      body: "<p>hola</p>",
      env: env({ PANEL_TEMA: "claro" } as Partial<Env>),
    });
    expect(html).toContain("--panel:#ffffff");
    expect(html).toContain("font-size:15px");
  });

  it("usa la fuente y los colores de la marca, y cae a un valor por defecto", () => {
    const conMarca = temaClaro(
      env({
        PANEL_TEMA: "claro",
        TEMA_FUENTE: "Fira Sans",
        TEMA_COLOR: "#01aeab",
        TEMA_COLOR2: "#a2670a",
      } as Partial<Env>),
    );
    expect(conMarca).toContain("family=Fira+Sans");
    expect(conMarca).toContain("--accent:#01aeab");
    expect(conMarca).toContain("--accent-2:#a2670a");

    const sinMarca = temaClaro(env({ PANEL_TEMA: "claro" } as Partial<Env>));
    expect(sinMarca).toContain("family=Inter");
    expect(sinMarca).toContain("--accent:#2f7fbf");
  });

  it("solo toca color y tipografía: nada mueve ni redimensiona cajas", () => {
    // `line-height` es tipografía, no caja: se saca antes de mirar.
    const css = temaClaro(env({ PANEL_TEMA: "claro" } as Partial<Env>)).replace(
      /line-height:[^;}]+/g,
      "",
    );
    for (const prohibida of [
      "position:",
      "width:",
      "height:",
      "margin:",
      "padding:",
      "flex",
      "grid",
      "top:",
      "left:",
      "float:",
    ]) {
      expect(css).not.toContain(prohibida);
    }
    // La ÚNICA excepción: se apaga la decoración de rayas del fondo, que no
    // ocupa sitio ni empuja nada.
    const displays = [...css.matchAll(/display:[^;!]+/g)].map((m) => m[0].trim());
    expect(displays).toEqual(["display:none"]);
  });

  it("sube los tamaños chicos, que son los que obligan a acercarse", () => {
    const css = temaClaro(env({ PANEL_TEMA: "claro" } as Partial<Env>));
    // 11px es el tamaño más usado del panel
    expect(css).toContain('[style*="font-size:11px"]');
    // y con espacio después de los dos puntos, que también aparece en el código
    expect(css).toContain('[style*="font-size: 11px"]');
    // La regla de oro del re-mapeo: NINGÚN tamaño se hace más chico, y los
    // más chiquitos son los que más suben (son los que obligan a acercarse).
    const pares = [...css.matchAll(/font-size:([\d.]+)px"\][^{]*\{font-size:([\d.]+)px/g)].map(
      (m) => ({ antes: Number(m[1]), despues: Number(m[2]) }),
    );
    expect(pares.length).toBeGreaterThan(10);
    for (const { antes, despues } of pares) expect(despues).toBeGreaterThan(antes);
    const masChico = pares.reduce((a, b) => (a.antes <= b.antes ? a : b));
    const masGrande = pares.reduce((a, b) => (a.antes >= b.antes ? a : b));
    expect(masChico.despues - masChico.antes).toBeGreaterThan(masGrande.despues - masGrande.antes);
  });
});
