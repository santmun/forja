/**
 * Los <script> del panel tienen que PARSEAR.
 *
 * El selector de proyectos armaba su HTML con comillas simples escapadas (\')
 * dentro de un template literal, así que la barra invertida se perdía y al
 * navegador le llegaba una cadena JS cortada por la mitad:
 *
 *   '<select onchange="if(this.value.indexOf('http')===0)…" '
 *
 * Resultado: "Uncaught SyntaxError: Unexpected identifier 'http'" en TODAS las
 * páginas del panel, y ese bloque entero no se ejecutaba nunca (el selector de
 * proyectos no aparecía aunque hubiera PEER_BOTS configurados).
 *
 * Un error de sintaxis solo se ve abriendo la consola del navegador, así que
 * esta prueba lo comprueba desde el servidor: coge cada script en línea del
 * HTML y lo pasa por el parser de JavaScript.
 */
import { describe, it, expect } from "vitest";
import { layout } from "../../src/admin/views/layout";

const RE_SCRIPT_EN_LINEA = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;

function scriptsDe(html: string): string[] {
  return [...html.matchAll(RE_SCRIPT_EN_LINEA)].map((m) => m[1]).filter((s) => s.trim());
}

describe("los scripts en línea del panel", () => {
  const html = layout({ title: "Prueba", activeTab: "overview", body: "<p>hola</p>" });

  it("hay scripts que revisar (si no, la prueba no probaría nada)", () => {
    expect(scriptsDe(html).length).toBeGreaterThan(0);
  });

  it("todos parsean como JavaScript válido", () => {
    for (const script of scriptsDe(html)) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it("el selector de proyectos escapa sus comillas como &#39;", () => {
    // Si vuelven los \' del código fuente, el navegador recibe 'http' suelto
    // dentro de una cadena ya delimitada por comillas simples.
    expect(html).toContain("indexOf(&#39;http&#39;)");
    expect(html).not.toContain("indexOf('http')");
  });
});
