/**
 * UN COLOR PROPIO PARA CADA CONTACTO.
 *
 * En la bandeja todos los avatares eran del mismo gris, así que para encontrar
 * a alguien había que leer nombre por nombre. Ahora cada contacto tiene su
 * color, y es SIEMPRE el mismo porque sale de su propio id de canal.
 */
import { describe, it, expect } from "vitest";
import {
  initialsOf,
  colorDeContacto,
  avatarContacto,
} from "../../src/admin/views/avatarContacto";

describe("iniciales", () => {
  it("saca dos letras de un nombre normal", () => {
    expect(initialsOf("Rosa Quispe")).toBe("RQ");
  });

  it("con una sola palabra usa las dos primeras letras", () => {
    expect(initialsOf("Rosa")).toBe("RO");
  });

  // La trampa: un contacto guardado como "Ana - Tienda Central" daba "A-".
  it("se salta los guiones y los signos", () => {
    expect(initialsOf("Ana - Tienda Central")).toBe("AT");
    expect(initialsOf("Ana — Tienda")).toBe("AT");
    expect(initialsOf("Ana_Tienda")).toBe("AT");
  });

  it("aguanta lo vacío y lo raro", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
    expect(initialsOf("···")).toBe("?");
  });
});

describe("color", () => {
  it("el mismo contacto SIEMPRE recibe el mismo color", () => {
    expect(colorDeContacto("51999888777")).toEqual(colorDeContacto("51999888777"));
  });

  it("contactos distintos reciben colores distintos", () => {
    const a = colorDeContacto("51999888777").fondo;
    const b = colorDeContacto("51911222333").fondo;
    expect(a).not.toBe(b);
  });

  it("la saturación y la luz son fijas: ningún color chillón ni ilegible", () => {
    for (const semilla of ["a", "51999888777", "telegram:42", "x".repeat(50)]) {
      expect(colorDeContacto(semilla).fondo).toMatch(/^hsl\(\d{1,3} 42% 42%\)$/);
    }
  });
});

describe("el avatar", () => {
  it("trae las iniciales, el color y el tamaño pedido", () => {
    const html = avatarContacto("Rosa Quispe", "51999888777", 34);
    expect(html).toContain(">RQ<");
    expect(html).toContain(colorDeContacto("51999888777").fondo);
    expect(html).toContain("width:34px");
  });

  it("escapa el nombre: no se puede colar HTML por ahí", () => {
    const html = avatarContacto('<img src=x onerror=alert(1)>', "s", 30);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
