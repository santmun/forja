import { describe, it, expect } from "vitest";
import { chunkReply, stripMarkdown } from "../../src/replies/chunker";

describe("chunkReply", () => {
  it("returns single chunk for short text", () => {
    expect(chunkReply("Hola María, qué tal")).toEqual(["Hola María, qué tal"]);
  });

  it("splits by paragraph breaks first", () => {
    const text = "Hola María.\n\n¿Te agendo hoy?\n\nTengo 5pm o 7pm.";
    const chunks = chunkReply(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("Hola María.");
    expect(chunks[1]).toBe("¿Te agendo hoy?");
    expect(chunks[2]).toBe("Tengo 5pm o 7pm.");
  });

  it("falls back to sentence split when no paragraphs", () => {
    const text = "Hola María. ¿Te agendo hoy? Tengo 5pm o 7pm.";
    const chunks = chunkReply(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(3);
  });

  it("caps at 3 chunks even for long content", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Oración ${i}.`).join(" ");
    const chunks = chunkReply(text);
    expect(chunks.length).toBeLessThanOrEqual(3);
  });

  it("preserves total content (no characters lost)", () => {
    const text = "Hola María.\n\n¿Te agendo hoy?\n\nTengo 5pm o 7pm.";
    const chunks = chunkReply(text);
    const joined = chunks.join(" ").replace(/\s+/g, " ");
    const original = text.replace(/\s+/g, " ");
    expect(joined).toBe(original);
  });

  it("strips Markdown before sending (no channel renders it)", () => {
    expect(stripMarkdown("**PAQUETE BASE**")).toBe("PAQUETE BASE");
    expect(stripMarkdown("hola __mundo__")).toBe("hola mundo");
    expect(stripMarkdown("usa `codigo` aquí")).toBe("usa codigo aquí");
    expect(stripMarkdown("# Título")).toBe("Título");
    expect(stripMarkdown("- uno\n- dos")).toBe("• uno\n• dos");
    expect(stripMarkdown("* item")).toBe("• item");
  });

  it("leaves plain text and numbered lists untouched", () => {
    expect(stripMarkdown("Precio: $250 (2 x $125)")).toBe("Precio: $250 (2 x $125)");
    expect(stripMarkdown("1. Primero\n2. Segundo")).toBe("1. Primero\n2. Segundo");
  });

  it("chunkReply sanitizes Markdown in its output", () => {
    expect(chunkReply("**Hola** María")).toEqual(["Hola María"]);
  });
});
