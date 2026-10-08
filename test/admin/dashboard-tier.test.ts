import { describe, it, expect } from "vitest";
import { layout, renderUpgrade } from "../../src/admin/views/layout";
import type { Env } from "../../src/env";

const envOf = (tier: "free" | "pro") => ({ BOT_TIER: tier }) as unknown as Env;
const page = (tier: "free" | "pro") =>
  layout({ title: "Test", activeTab: "overview", body: "<p>body</p>", env: envOf(tier) });

describe("dashboard tier gating (nav)", () => {
  it("free: los tabs Pro salen bloqueados y apuntan a /admin/upgrade", () => {
    const html = page("free");
    // El item Pro (ej. Insights) no linkea a su vista real, sino al upgrade.
    expect(html).not.toContain('href="/admin/insights"');
    expect(html).toContain('href="/admin/upgrade"');
    expect(html).toContain("PRO"); // badge en el item bloqueado
    expect(html).toContain("Panel · Free");
  });

  it("free: los tabs básicos siguen accesibles", () => {
    const html = page("free");
    for (const href of ["/admin/conversations", "/admin/leads", "/admin/kb", "/admin/conexiones"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("pro: todos los tabs linkean a su vista real, sin badge PRO", () => {
    const html = page("pro");
    for (const href of ["/admin/insights", "/admin/stats", "/admin/costs", "/admin/mejoras", "/admin/campanas"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain("Panel · Pro");
    expect(html).not.toContain('href="/admin/upgrade"');
  });

  it("sin env (fallback) asume Pro — no oculta nada", () => {
    const html = layout({ title: "T", activeTab: "overview", body: "x" });
    expect(html).toContain('href="/admin/insights"');
  });

  it("renderUpgrade arma la página de venta con CTA a la comunidad", () => {
    const html = renderUpgrade(envOf("free"), "Insights");
    expect(html).toContain("Insights");
    expect(html).toContain("horizontesia.com");
    expect(html).toContain("Subir a Pro");
  });

  it("BRAND_HIDE_FORJA quita la marca Forja del sidebar y el enlace a la comunidad", () => {
    const env = { BOT_TIER: "pro", BRAND_HIDE_FORJA: "on", BUSINESS_NAME: "NatBell" } as unknown as Env;
    const html = layout({ title: "Test", activeTab: "overview", body: "<p>body</p>", env });
    expect(html).toContain("NatBell");
    expect(html).not.toContain(">Forja<");
    const upgrade = renderUpgrade(env, "Costos");
    expect(upgrade).not.toContain("horizontesia.com");
    expect(upgrade).toContain("quien administra el bot");
  });

  it("HIDDEN_TABS=costs saca Costos del menú", () => {
    const env = { BOT_TIER: "pro", HIDDEN_TABS: "costs, no-existe" } as unknown as Env;
    const html = layout({ title: "Test", activeTab: "overview", body: "<p>body</p>", env });
    expect(html).not.toContain('href="/admin/costs"');
    expect(html).toContain('href="/admin/conversations"');
    expect(html).toContain('href="/admin/insights"');
  });
});
