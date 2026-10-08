import { describe, expect, it } from "vitest";
import { renderMessageHtml } from "../../src/admin/messageHtml";

describe("hilo del panel — marcadores de media", () => {
  it("pinta [[media: id]] como imagen y no como texto", () => {
    const html = renderMessageHtml("Mira\n[[media: img_abc]]");
    expect(html).toContain('<img src="/media/img_abc"');
    expect(html).toContain("Mira");
    expect(html).not.toContain("[[media:");
  });

  it("pinta [IMAGE_URL: https://…] como imagen", () => {
    const html = renderMessageHtml("foto\n[IMAGE_URL: https://cdn.example/a.png]");
    expect(html).toContain('<img src="https://cdn.example/a.png"');
    expect(html).not.toContain("IMAGE_URL");
  });

  it("escapa HTML y no usa una URL que no sea http(s)", () => {
    const html = renderMessageHtml('<script>alert(1)</script> [[media: img_"onclick]] [IMAGE_URL: javascript:alert(1)]');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    // Una URL que no es http(s) no se vuelve imagen: queda texto escapado.
    expect(html).not.toContain("<img");
    expect(html).toContain("IMAGE_URL");
  });
});
