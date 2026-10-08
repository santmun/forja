/** "on" oculta la marca Forja en el panel (white-label / Modo Agencia). */
export function hidesForja(env?: { BRAND_HIDE_FORJA?: string } | null): boolean {
  return (env?.BRAND_HIDE_FORJA ?? "").trim().toLowerCase() === "on";
}
