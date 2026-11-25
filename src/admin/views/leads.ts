import type { Env } from "../../env";
import { Db } from "../../db/client";
import { LeadsRepo, leadMetadata, type Lead } from "../../db/leads";
import { getNiche, type NichePack } from "../../niches";
import { todayInTz } from "../../time/resolveDate";
import { memberConfig } from "../../../member/config.local";
import { layout } from "./layout";
import { fmtDate, fmtDateTime } from "../format";

// Mismas etiquetas que la tabla de Prospectos. El CSV las reutiliza para que
// Excel no muestre "intent" / "status" cuando el panel está en español.
const COL_FECHA = "Fecha";
const COL_HORA = "Hora";
const COL_NOMBRE = "Nombre";
const COL_CONTACTO = "Contacto";
const COL_RESUMEN = "Resumen";
const COL_NOTAS = "Notas";
const COL_ESTADO = "Estado";

// Escapa texto del LLM/cliente antes de meterlo en HTML (el intent y las notas
// pueden traer <, &, links pegados por el cliente, etc.).
function esc(v: string | null | undefined): string {
  return (v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface Col {
  h: string;
  w: string;
  cell: (l: Lead, meta: Record<string, string>) => string;
}

export async function renderLeads(env: Env): Promise<string> {
  const niche = getNiche(env);
  const leads = new LeadsRepo(new Db(env.DB));
  const list = await leads.list(100);

  const statusLabel = (s: Lead["status"]) => niche.statusLabels[s];

  // Columnas: núcleo (fecha, nombre, contacto) + o bien las columnas del nicho
  // (leídas de metadata) o bien el "Resumen" genérico + estado (re-etiquetado).
  const cols: Col[] = [
    { h: COL_FECHA, w: "94px", cell: (l) => `<span class="text-dim">${fmtDate(l.created_at)}</span>` },
    { h: COL_NOMBRE, w: "minmax(120px,1.1fr)", cell: (l) => `<span class="text-cream" style="display:flex;align-items:center;gap:7px"><i data-lucide="chevron-right" width="13" height="13" class="chev" style="flex:none;transition:transform .12s ease"></i>${esc(l.name) || "(sin nombre)"}</span>` },
    { h: COL_CONTACTO, w: "minmax(110px,1fr)", cell: (l) => `<span class="text-muted">${esc(l.contact) || "—"}</span>` },
  ];
  if (niche.columns.length) {
    for (const c of niche.columns) {
      cols.push({ h: c.label, w: "minmax(78px,.85fr)", cell: (_l, meta) => `<span class="text-muted truncate">${esc(meta[c.key]) || "—"}</span>` });
    }
  } else {
    cols.push({ h: `${COL_RESUMEN} · click para ver detalle`, w: "minmax(200px,1.8fr)", cell: (l) => `<span class="text-muted truncate">${esc(l.intent)}</span>` });
  }
  cols.push({
    h: COL_ESTADO,
    w: "132px",
    cell: (l) => `<form method="POST" action="/admin/leads/${l.id}/status" onclick="event.stopPropagation()">
      <select name="status" onchange="this.form.submit()"
              style="width:100%;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:6px 8px;font-size:11px;outline:none;cursor:pointer">
        ${(["new", "contacted", "sold", "lost"] as const)
          .map((s) => `<option ${l.status === s ? "selected" : ""} value="${s}">${esc(statusLabel(s))}</option>`)
          .join("")}
      </select>
    </form>`,
  });

  const gridCols = cols.map((c) => c.w).join(" ");
  const minWidth = 640 + niche.columns.length * 90; // asegura el scroll horizontal cuando hay muchas columnas

  const rows = list
    .map((l) => {
      const meta = leadMetadata(l);
      const fullDate = fmtDateTime(l.created_at);
      const convLink = l.conversation_id
        ? `<a href="/admin/conversations?c=${encodeURIComponent(l.conversation_id)}" class="text-accent" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;text-decoration:none">
             <i data-lucide="messages-square" width="13" height="13"></i> Ver conversación completa
           </a>`
        : `<span class="text-dim" style="font-size:11.5px">Sin conversación ligada</span>`;
      // Detalle: todos los campos del nicho (metadata) + resumen IA + notas.
      const metaRows = Object.entries(meta)
        .map(([k, v]) => `<span class="text-muted" style="font-size:12px"><span class="text-dim">${esc(k)}:</span> ${esc(v)}</span>`)
        .join("");
      return `<div class="lead" style="border-top:1px solid var(--line)">
        <div class="leadrow" onclick="var d=this.parentNode.querySelector('.lead-detail');var open=d.style.display==='block';d.style.display=open?'none':'block';this.querySelector('.chev').style.transform=open?'rotate(0deg)':'rotate(90deg)'"
             style="display:grid;grid-template-columns:${gridCols};gap:12px;padding:13px 18px;font-size:12.5px;align-items:center;cursor:pointer">
          ${cols.map((c) => c.cell(l, meta)).join("")}
        </div>
        <div class="lead-detail" style="display:none;padding:4px 18px 20px 18px;background:var(--bg)">
          <div style="max-width:760px;display:flex;flex-direction:column;gap:14px;padding-top:14px">
            ${metaRows ? `<div><div style="font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-bottom:6px">Datos</div><div style="display:flex;flex-wrap:wrap;gap:6px 18px">${metaRows}</div></div>` : ""}
            <div>
              <div style="font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-bottom:6px">Resumen de la IA</div>
              <div class="text-cream" style="font-size:13px;line-height:1.55;white-space:pre-wrap">${esc(l.intent)}</div>
            </div>
            ${l.notes ? `<div>
              <div style="font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-bottom:6px">Notas</div>
              <div class="text-muted" style="font-size:12.5px;line-height:1.5;white-space:pre-wrap">${esc(l.notes)}</div>
            </div>` : ""}
            <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding-top:2px">
              ${convLink}
              <span class="text-dim" style="font-size:11.5px;display:inline-flex;align-items:center;gap:6px"><i data-lucide="clock" width="12" height="12"></i>${fullDate}</span>
            </div>
          </div>
        </div>
      </div>`;
    })
    .join("");

  const empty = `<div style="padding:40px 18px;text-align:center" class="text-dim text-[12.5px]">Aún no hay ${esc(niche.recordPlural.toLowerCase())}.</div>`;
  const header = cols
    .map((c) => `<span>${esc(c.h)}</span>`)
    .join("");

  const body = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h2 class="font-display font-semibold text-[15px] text-cream">${esc(niche.recordPlural)}</h2>
      <a href="/admin/leads/export.csv" class="ghostbtn" style="display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);color:var(--muted);padding:9px 14px;font-size:12.5px;transition:all .12s ease">
        <i data-lucide="download" width="14" height="14"></i> Exportar CSV
      </a>
    </div>
    <div class="bg-panel border border-line" style="overflow-x:auto">
      <div style="min-width:${minWidth}px">
        <div style="display:grid;grid-template-columns:${gridCols};gap:12px;padding:10px 18px;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">
          ${header}
        </div>
        ${list.length ? rows : empty}
      </div>
    </div>`;
  return layout({ title: niche.recordPlural, activeTab: "leads", body, env });
}

const FALLBACK_TZ = "America/Mexico_City";

function validTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Zona del export: BOT_TIMEZONE, si no CALCOM_TIMEZONE, si no la zona del
 * negocio (member/config.local.ts) y al final America/Mexico_City.
 */
function leadsExportTimeZone(env: {
  BOT_TIMEZONE?: string;
  CALCOM_TIMEZONE?: string;
}): string {
  const candidates = [env.BOT_TIMEZONE, env.CALCOM_TIMEZONE, memberConfig.timezone, FALLBACK_TZ];
  for (const raw of candidates) {
    const tz = (raw ?? "").trim();
    if (tz && validTimeZone(tz)) return tz;
  }
  return FALLBACK_TZ;
}

export function leadsExportFilename(env: Env, now = new Date()): string {
  return `prospectos-${todayInTz(leadsExportTimeZone(env), now)}.csv`;
}

/** "extra_nota" → "Extra Nota". Las columnas del nicho usan su etiqueta, no esto. */
function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-záéíóúüñ])([A-Z])/g, "$1 $2")
    .split(/[_\-\s]+/)
    .filter(Boolean);
  if (!words.length) return key;
  return words.map((w) => w.charAt(0).toLocaleUpperCase("es") + w.slice(1)).join(" ");
}

/**
 * Celda CSV para Excel (Windows): entre comillas, sin saltos de línea, y con
 * un apóstrofo delante si el valor podría ejecutarse como fórmula (= + - @).
 */
function csvCell(value: string | null | undefined): string {
  const flat = (value ?? "").replace(/[\r\n\u2028\u2029]+/g, " ");
  const guarded = /^\s*[=+\-@]/.test(flat) ? `'${flat}` : flat;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function dateTimeInZone(ts: number, timeZone: string): { date: string; time: string } {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
}

function statusText(niche: Pick<NichePack, "statusLabels">, status: string): string {
  const labels = niche.statusLabels as Record<string, string>;
  return labels[status] ?? status;
}

/** Solo llaves propias: `toString` o `constructor` no deben salir del prototipo. */
function metaValue(meta: Record<string, string>, key: string): string {
  if (!Object.hasOwn(meta, key)) return "";
  const value = meta[key];
  return typeof value === "string" ? value : "";
}

/** Arma el CSV (BOM + CRLF) a partir de filas ya cargadas y del nicho activo. */
export function buildLeadsCsv(
  list: Lead[],
  niche: Pick<NichePack, "columns" | "statusLabels">,
  timeZone: string,
): string {
  const nicheKeys = new Set(niche.columns.map((c) => c.key));
  const extraKeys: string[] = [];
  const seen = new Set<string>();
  for (const lead of list) {
    for (const key of Object.keys(leadMetadata(lead))) {
      if (nicheKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      extraKeys.push(key);
    }
  }

  const headers = [
    COL_FECHA,
    COL_HORA,
    COL_NOMBRE,
    COL_CONTACTO,
    ...niche.columns.map((c) => c.label),
    ...extraKeys.map(humanizeKey),
    COL_RESUMEN,
    COL_NOTAS,
    COL_ESTADO,
  ];

  const lines = [headers.map((h) => csvCell(h)).join(",")];
  for (const lead of list) {
    const meta = leadMetadata(lead);
    const when = dateTimeInZone(lead.created_at, timeZone);
    const cells = [
      when.date,
      when.time,
      lead.name ?? "",
      lead.contact ?? "",
      ...niche.columns.map((c) => metaValue(meta, c.key)),
      ...extraKeys.map((k) => metaValue(meta, k)),
      lead.intent ?? "",
      lead.notes ?? "",
      statusText(niche, lead.status),
    ];
    lines.push(cells.map((c) => csvCell(c)).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export async function exportLeadsCsv(env: Env): Promise<string> {
  const leads = new LeadsRepo(new Db(env.DB));
  const list = await leads.list(10_000);
  return buildLeadsCsv(list, getNiche(env), leadsExportTimeZone(env));
}
