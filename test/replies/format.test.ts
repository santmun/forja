import { describe, it, expect } from "vitest";
import { toTelegramHtml, hasBalancedTags } from "../../src/replies/format";

describe("toTelegramHtml", () => {
  it("converts **bold** to <b>", () => {
    expect(toTelegramHtml("esto es **importante**")).toBe("esto es <b>importante</b>");
  });

  it("converts __underline__ to <u>", () => {
    expect(toTelegramHtml("no puede faltar __esto__")).toBe("no puede faltar <u>esto</u>");
  });

  it("converts *italic* and _italic_ to <i>", () => {
    expect(toTelegramHtml("un *matiz* y otro _matiz_")).toBe("un <i>matiz</i> y otro <i>matiz</i>");
  });

  it("handles bold and underline together without leaking asterisks", () => {
    expect(toTelegramHtml("**Ojo:** falta __la conclusión__.")).toBe(
      "<b>Ojo:</b> falta <u>la conclusión</u>.",
    );
  });

  it("escapes raw HTML special chars from the model/user before adding tags", () => {
    expect(toTelegramHtml("5 < 10 & **ok**")).toBe("5 &lt; 10 &amp; <b>ok</b>");
  });

  it("leaves plain text without markers untouched (aside from HTML escaping)", () => {
    expect(toTelegramHtml("hola, todo normal")).toBe("hola, todo normal");
  });

  it("does not treat an underscore inside a word as italic", () => {
    expect(toTelegramHtml("nombre_de_variable sin cambios")).toBe(
      "nombre_de_variable sin cambios",
    );
  });

  // Casos encontrados por la revisión de Opus (2026-09-03): con las 4 pasadas
  // secuenciales viejas, estos producían HTML mal anidado → Telegram
  // rechazaba el mensaje ENTERO con 400 y se perdía en silencio.
  describe("regresión — HTML mal anidado (revisión Opus 2026-09-03)", () => {
    it("***texto*** (negrita+cursiva) no deja un asterisco suelto", () => {
      const out = toTelegramHtml("esto es ***muy importante***");
      expect(out).toBe("esto es <b><i>muy importante</i></b>");
      expect(hasBalancedTags(out)).toBe(true);
    });

    it("___texto___ (subrayado+cursiva) no deja un guion bajo suelto", () => {
      const out = toTelegramHtml("___esto no puedes dejarlo pasar___");
      expect(out).toBe("<u><i>esto no puedes dejarlo pasar</i></u>");
      expect(hasBalancedTags(out)).toBe(true);
    });

    it("marcadores cruzados producen HTML válido (aunque no el énfasis 'intentado')", () => {
      const out = toTelegramHtml("**Nota _importante** sigue_");
      expect(hasBalancedTags(out)).toBe(true);
    });

    it("otro caso de marcadores cruzados también queda balanceado", () => {
      const out = toTelegramHtml("**bold _mixed** italic_");
      expect(hasBalancedTags(out)).toBe(true);
    });
  });

  describe("no confunde viñetas ni aritmética con énfasis (revisión Opus 2026-09-03)", () => {
    it("una viñeta con '* ' al inicio de línea queda intacta", () => {
      const out = toTelegramHtml("* Punto uno\n* Punto dos\n* Punto tres");
      expect(out).toBe("* Punto uno\n* Punto dos\n* Punto tres");
    });

    it("aritmética con espacios alrededor del asterisco queda intacta", () => {
      expect(toTelegramHtml("5 * 3 y 4 * 2")).toBe("5 * 3 y 4 * 2");
    });
  });
});

describe("hasBalancedTags", () => {
  it("true para texto sin tags", () => {
    expect(hasBalancedTags("hola")).toBe(true);
  });

  it("true para tags bien anidadas", () => {
    expect(hasBalancedTags("<b>hola <i>mundo</i></b>")).toBe(true);
  });

  it("false para una tag sin cerrar", () => {
    expect(hasBalancedTags("<b>hola")).toBe(false);
  });

  it("false para tags cruzadas", () => {
    expect(hasBalancedTags("<b>hola <i>mundo</b></i>")).toBe(false);
  });
});
