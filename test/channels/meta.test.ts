import { describe, it, expect } from "vitest";
import { parseMetaEvents } from "../../src/channels/meta";

function igBody(attachments: { type: string; payload?: Record<string, unknown> }[], text?: string) {
  return {
    object: "instagram",
    entry: [{ messaging: [{ sender: { id: "17841400000000000" }, message: { mid: "m1", text, attachments } }] }],
  };
}
function fbBody(attachments: { type: string; payload?: Record<string, unknown> }[], text?: string) {
  return {
    object: "page",
    entry: [{ messaging: [{ sender: { id: "PSID123" }, message: { mid: "m1", text, attachments } }] }],
  };
}

describe("parseMetaEvents · Instagram shares (antes se perdían)", () => {
  it("un reel compartido llega como texto con el permalink (no se descarta)", () => {
    const url = "https://www.instagram.com/reel/ABC123/";
    const [msg] = parseMetaEvents(igBody([{ type: "ig_reel", payload: { url, title: "mira esto" } }]));
    expect(msg).toBeDefined();
    expect(msg.channel).toBe("instagram");
    expect(msg.text).toContain("mira esto");
    expect(msg.text).toContain(url);
  });

  it("un post compartido muestra su imagen del CDN (sin permalink, es lo único que da Meta)", () => {
    const url = "https://lookaside.fbsbx.com/ig_messaging_cdn/foto.jpg";
    const [msg] = parseMetaEvents(igBody([{ type: "ig_post", payload: { url } }]));
    expect(msg).toBeDefined();
    expect(msg.imageUrl).toBe(url);
    expect(msg.text).toContain("Publicación");
  });

  it("un video llega como texto con su url", () => {
    const url = "https://cdn.example/video.mp4";
    const [msg] = parseMetaEvents(igBody([{ type: "video", payload: { url } }]));
    expect(msg).toBeDefined();
    expect(msg.text).toContain(url);
  });

  it("imagen y audio siguen mapeando a imageUrl/audioUrl", () => {
    const [img] = parseMetaEvents(igBody([{ type: "image", payload: { url: "https://x/i.jpg" } }]));
    expect(img.imageUrl).toBe("https://x/i.jpg");
    const [aud] = parseMetaEvents(igBody([{ type: "audio", payload: { url: "https://x/a.mp3" } }]));
    expect(aud.audioUrl).toBe("https://x/a.mp3");
  });
});

describe("parseMetaEvents · Messenger sin cambios (solo IG se enriquece)", () => {
  it("un share por Messenger se sigue descartando (no hay contenido de texto/imagen/audio)", () => {
    const out = parseMetaEvents(fbBody([{ type: "ig_reel", payload: { url: "https://instagram.com/reel/X/" } }]));
    expect(out).toHaveLength(0);
  });

  it("texto por Messenger pasa igual que siempre", () => {
    const [msg] = parseMetaEvents(fbBody([], "hola"));
    expect(msg.channel).toBe("messenger");
    expect(msg.text).toBe("hola");
  });
});
