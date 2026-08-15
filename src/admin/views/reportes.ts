/**
 * BUZÓN — donde el equipo reporta fallas del bot y propone mejoras.
 *
 * La idea: que cualquiera del equipo pueda avisar
 * cuando el bot contesta mal, igual que en los demás sistemas de el negocio.
 *
 * Dos puertas de entrada, el mismo buzón:
 *   1. Esta pestaña — el formulario general ("se me ocurre…", "ayer falló…").
 *   2. El botón "⚑ Reportar" del hilo de una conversación — el caso de verdad:
 *      la secretaria ve una respuesta mala y la reporta EN EL MOMENTO, con el
 *      chat ya enganchado para poder ir a leerlo después.
 *
 * Por qué no se reusó lo que ya existía: `tickets` los abre el BOT cuando pide
 * ayuda humana (y esas conversaciones salen marcadas con 🔔 en la bandeja), y
 * "Mejoras" es lo que propone la IA. Ver schema.sql y db/reportes.ts.
 */
import type { Env } from "../../env";
import { Db } from "../../db/client";
import { ReportesRepo, type Reporte, type EstadoReporte } from "../../db/reportes";
import { layout } from "./layout";
/** Igual que en Tickets: la fecha en local, sin dependencias nuevas. */
const fechaHoraLarga = (ms: number) => new Date(ms).toLocaleString("es-MX");

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const COLOR_TIPO: Record<string, string> = {
  error: "var(--bad)",
  sugerencia: "var(--info)",
};

const ETIQUETA_TIPO: Record<string, string> = {
  error: "⚠ Algo falló",
  sugerencia: "💡 Idea",
};

/**
 * El nombre de quien reporta se recuerda en el navegador.
 *
 * El equipo va a usar esto varias veces al día: pedirles el
 * nombre cada vez es la forma más rápida de que dejen de escribirlo (o de que
 * pongan cualquier cosa). Se guarda solo en SU navegador — no viaja a ningún
 * lado ni se comparte entre computadoras.
 */
export const RECORDAR_NOMBRE = `
<script>
(function () {
  var LLAVE = "forja-quien-reporta";
  function aplicar() {
    var guardado = "";
    try { guardado = localStorage.getItem(LLAVE) || ""; } catch (e) { return; }
    document.querySelectorAll("input[name=reportado_por]").forEach(function (i) {
      if (!i.value && guardado) {
        i.value = guardado;
        // Y pasa a ser "el valor con el que nació el campo". Si no, el cuadro
        // de ⚑ Reportar creería que la persona ya escribió algo y se negaría a
        // cerrarse con un clic afuera — solo porque nos adelantamos a poner su
        // nombre. (Se detectó probándolo en el navegador, 10/08/2026.)
        i.defaultValue = guardado;
      }
    });
  }
  function recordar(e) {
    var f = e.target;
    if (!f || !f.matches || !f.matches("form")) return;
    var i = f.querySelector("input[name=reportado_por]");
    if (i && i.value.trim()) { try { localStorage.setItem(LLAVE, i.value.trim()); } catch (err) {} }
  }
  document.addEventListener("DOMContentLoaded", aplicar);
  document.addEventListener("submit", recordar, true);
  document.body.addEventListener("htmx:afterSwap", aplicar);
  aplicar();
})();
</script>`;

const ESTILO_CAMPO =
  "width:100%;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:9px 12px;font-size:12.5px;font-family:inherit;outline:none";

/**
 * El formulario para dejar un reporte. El mismo en la pestaña y dentro de una
 * conversación; lo que cambia es si trae el chat enganchado y cómo responde.
 *
 * - En la pestaña va como formulario normal: al enviar, la página se recarga y
 *   el reporte ya aparece abajo en la lista.
 * - En el hilo va por htmx (`hx-post`), porque ahí NO se puede recargar la
 *   página: el equipo está leyendo esa conversación. Ojo, esto no es un capricho
 *   de estilo — con un POST normal la respuesta reemplazaría toda la pantalla
 *   por un pedacito de HTML.
 */
export function formularioReporte(opts: {
  conversationId?: string | null;
  htmx?: boolean;
  compacto?: boolean;
}): string {
  const conv = opts.conversationId ?? "";
  const envio = opts.htmx
    ? `hx-post="/admin/reportes" hx-target="#estado-reporte" hx-swap="innerHTML"
       hx-on::after-request="if(event.detail.xhr.getResponseHeader('X-Reporte')==='1')this.reset()"`
    : `method="POST" action="/admin/reportes"`;
  const placeholder = opts.conversationId
    ? "¿Qué pasó en este chat? Ej. le dijo que el taller es gratis y no lo es."
    : "Cuéntanos qué pasó o qué se te ocurre. Mientras más concreto, mejor.";

  return `
  <form ${envio} style="display:flex;flex-direction:column;gap:9px">
    ${conv ? `<input type="hidden" name="conversation_id" value="${esc(conv)}">` : ""}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <label class="chip" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:6px 11px;border:1px solid var(--linelit);color:var(--muted)">
        <input type="radio" name="tipo" value="error" checked style="accent-color:var(--bad)"> ⚠ Algo falló
      </label>
      <label class="chip" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:6px 11px;border:1px solid var(--linelit);color:var(--muted)">
        <input type="radio" name="tipo" value="sugerencia" style="accent-color:var(--info)"> 💡 Se me ocurre algo
      </label>
    </div>
    <textarea name="texto" rows="${opts.compacto ? 3 : 4}" required maxlength="2000"
              placeholder="${esc(placeholder)}"
              style="${ESTILO_CAMPO};resize:vertical"></textarea>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input name="reportado_por" maxlength="60" placeholder="Tu nombre"
             autocomplete="off" style="${ESTILO_CAMPO};flex:1;min-width:150px">
      <button type="submit" class="bigbtn font-display font-bold text-[12px] cursor-pointer"
              style="background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:3px 3px 0 var(--linelit);padding:9px 18px;white-space:nowrap">
        Enviar reporte
      </button>
    </div>
    ${opts.htmx ? `<div id="estado-reporte" style="font-size:11.5px;min-height:1rem;color:var(--muted)"></div>` : ""}
  </form>`;
}

/** Lo que ve quien reporta desde el hilo, justo después de enviar. */
export function reporteEnviado(): string {
  return `<span style="color:var(--ok)">✓ Reporte enviado. Queda guardado en el Buzón — gracias.</span>`;
}

export function reporteVacio(): string {
  return `<span style="color:var(--bad)">✗ Escribe qué pasó antes de enviar.</span>`;
}

// --- Tarjeta de un reporte ----------------------------------------------------

function tarjeta(r: Reporte): string {
  const color = COLOR_TIPO[r.tipo] ?? "var(--muted)";
  const etiqueta = ETIQUETA_TIPO[r.tipo] ?? r.tipo;
  const resuelto = r.estado === "resuelto";
  const quien = r.reportado_por ? esc(r.reportado_por) : "alguien del equipo";

  const enlaceChat = r.conversation_id
    ? `<a href="/admin/conversations?c=${encodeURIComponent(r.conversation_id)}"
          style="font-size:11.5px;color:var(--accent);display:inline-flex;align-items:center;gap:5px">
         💬 Ver la conversación
       </a>`
    : "";

  const pie = resuelto
    ? `<div style="border-top:1px solid var(--line);margin-top:10px;padding-top:10px;display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap">
         <div style="flex:1;min-width:180px">
           <div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ok)">Resuelto${r.resuelto_at ? ` · ${esc(fechaHoraLarga(r.resuelto_at))}` : ""}</div>
           ${r.respuesta ? `<p style="margin:4px 0 0;font-size:12.5px;color:var(--muted);line-height:1.5">${esc(r.respuesta)}</p>` : ""}
         </div>
         <form method="POST" action="/admin/reportes/${esc(r.id)}/reabrir">
           <button class="chip" style="font-size:11px;background:transparent;border:1px dashed var(--linelit);color:var(--dim);padding:6px 11px;cursor:pointer">↺ Reabrir</button>
         </form>
       </div>`
    : `<form method="POST" action="/admin/reportes/${esc(r.id)}/resolver"
             style="border-top:1px solid var(--line);margin-top:10px;padding-top:10px;display:flex;gap:8px;flex-wrap:wrap">
         <input name="respuesta" maxlength="1000" placeholder="¿Qué se hizo? (opcional)"
                style="${ESTILO_CAMPO};flex:1;min-width:180px">
         <button class="bigbtn font-display font-bold text-[11.5px] cursor-pointer"
                 style="background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:3px 3px 0 var(--linelit);padding:9px 16px;white-space:nowrap">Marcar resuelto</button>
       </form>`;

  return `
  <div class="tkcard bg-panel border border-line" style="padding:15px 17px;margin-bottom:12px;${resuelto ? "opacity:.72" : ""}">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap">
        <span style="font-size:10px;letter-spacing:.04em;color:${color};border:1px solid ${color};padding:1px 7px;flex:none">${etiqueta}</span>
        <span class="text-muted" style="font-size:11.5px">${quien}</span>
        ${enlaceChat}
      </div>
      <span class="text-dim" style="font-size:11px;flex:none">${esc(fechaHoraLarga(r.created_at))}</span>
    </div>
    <p class="text-cream" style="margin:0;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere">${esc(r.texto)}</p>
    ${pie}
  </div>`;
}

// --- Página completa ----------------------------------------------------------

export async function renderReportes(
  env: Env,
  opts: { filtro?: string; enviado?: boolean } = {},
): Promise<string> {
  const repo = new ReportesRepo(new Db(env.DB));
  const filtro: EstadoReporte | undefined =
    opts.filtro === "abierto" || opts.filtro === "resuelto" ? opts.filtro : undefined;

  const [lista, abiertos] = await Promise.all([repo.listar(filtro), repo.contarAbiertos()]);
  const total = lista.length;

  const pill = (href: string, texto: string, activo: boolean, color: string) =>
    `<a href="${href}" class="chip" style="font-size:11px;letter-spacing:.05em;padding:5px 12px;white-space:nowrap;border:1px solid ${color};${
      activo ? `background:${color};color:#1a1206;font-weight:700` : `color:${color}`
    }">${texto}</a>`;

  const cuerpoLista =
    total === 0
      ? `<div class="bg-panel border border-line" style="padding:40px 18px;text-align:center">
           <i data-lucide="inbox" width="24" height="24" style="color:var(--dim);margin:0 auto 12px;display:block"></i>
           <p style="font-size:13px;color:var(--muted);font-weight:600;margin:0">${filtro ? "Nada con este filtro" : "El buzón está vacío"}</p>
           <p class="text-dim" style="font-size:11.5px;margin:6px auto 0;line-height:1.5;max-width:400px">
             ${filtro ? "Prueba con otro filtro." : "Aquí van a llegar los avisos del equipo: una respuesta que salió mal, un dato equivocado, una idea para que el bot atienda mejor."}
           </p>
         </div>`
      : lista.map(tarjeta).join("");

  const aviso = opts.enviado
    ? `<div style="border:1px solid var(--ok);background:rgba(127,183,126,.1);color:var(--ok);padding:10px 14px;font-size:12.5px;margin-bottom:14px">✓ Reporte enviado. Gracias — queda anotado aquí abajo.</div>`
    : "";

  const body = `
    ${aviso}
    <div class="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4 items-start">
      <div class="bg-panel border border-line" style="padding:16px 18px">
        <div class="font-display text-cream" style="font-weight:700;font-size:15px">Reportar algo del bot</div>
        <p class="text-dim" style="font-size:12px;line-height:1.55;margin:6px 0 14px">
          ¿El bot contestó algo raro, dio un dato equivocado o se le puede mejorar algo?
          Escríbelo aquí y lo revisamos. Si es de un chat en concreto, es mejor usar el
          botón <b class="text-muted">⚑ Reportar</b> que está arriba de esa conversación.
        </p>
        ${formularioReporte({})}
      </div>

      <div style="min-width:0">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          ${pill("/admin/reportes", `Todos · ${total}`, !filtro, "var(--accent)")}
          ${pill("/admin/reportes?estado=abierto", `Pendientes · ${abiertos}`, filtro === "abierto", "var(--bad)")}
          ${pill("/admin/reportes?estado=resuelto", "Resueltos", filtro === "resuelto", "var(--ok)")}
        </div>
        ${cuerpoLista}
      </div>
    </div>
    ${RECORDAR_NOMBRE}`;

  return layout({ title: "Buzón", activeTab: "reportes", body, env });
}
