// Bandeja de entrada (F1) — dos paneles estilo WhatsApp Web.
//
// Izquierda: lista de conversaciones (filtros + búsqueda), refrescada por HTMX
// cada 10 s. Derecha: el hilo seleccionado (?c=<id>) — cabecera de estado +
// mensajes, refrescado cada 5 s — y el composer para responder COMO HUMANO
// desde el dashboard (sale por el adapter del canal y pausa el bot).
//
// El hilo muestra lo que el bot HIZO, no solo lo que dijo: cada tool call es
// un chip, cada respuesta trae modelo + costo del turno.
//
// Truco de scroll: el contenedor de mensajes usa flex-col-reverse con los
// mensajes en orden DESC, así el scroll queda pegado abajo aun cuando el
// polling reemplaza el contenido.
import type { Env } from "../../env";
import { Db } from "../../db/client";
import { InsightsRepo } from "../../db/insights";
import { SENTIMENT_BADGE } from "./insights";
import { costOfUsage, type ModelId } from "../../pricing";
import { channelLabel } from "../../channels/labels";
import { layout } from "./layout";
import { fmtDateTime } from "../format";

/** Tiempo relativo corto en español (ej. "hace 5 min", "hace 2 h", "hace 3 d"). */
function ago(ms: number | null | undefined): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} d`;
}

// Lead pill colors follow the design-system's own "Lead" example (accent) —
// see docs/design-system.md §3 Pill/badge.
const LEAD_BADGE: Record<string, { txt: string; color: string }> = {
  new: { txt: "💰 Lead nuevo", color: "var(--accent)" },
  contacted: { txt: "💬 Contactado", color: "var(--info)" },
  sold: { txt: "✅ Vendido", color: "var(--ok)" },
  lost: { txt: "✖ Perdido", color: "var(--dim)" },
};

// We reuse SENTIMENT_BADGE's `.txt` labels (insights.ts) but render inbox pills
// with inline token colors; both maps use the same semantics (frustrated→amber,
// angry→red) so the two views stay visually coherent.
const SENTIMENT_COLOR: Record<string, string> = {
  positive: "var(--ok)",
  neutral: "var(--dim)",
  frustrated: "var(--accent-2)",
  angry: "var(--bad)",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function modelShort(modelId: string): string {
  if (modelId.includes("haiku")) return "haiku";
  if (modelId.includes("sonnet")) return "sonnet";
  if (modelId.includes("opus")) return "opus";
  return modelId.length > 14 ? `${modelId.slice(0, 14)}…` : modelId;
}

function turnCost(m: {
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
}): string {
  if (!m.model_used) return "";
  const cost = costOfUsage(m.model_used as ModelId, {
    input: m.input_tokens ?? 0,
    output: m.output_tokens ?? 0,
    cached: m.cached_input_tokens ?? 0,
  });
  return `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

/** Short human summary of a tool call's input for the chip. */
function toolInputSummary(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = o.query ?? o.reason ?? o.summary ?? o.name ?? o.intent;
    if (typeof pick === "string") return pick;
    const json = JSON.stringify(o);
    return json.length > 42 ? `${json.slice(0, 42)}…` : json;
  }
  return String(input ?? "");
}

// Pill recipes (docs/design-system.md §3): text = border = the variant color.
const smallPill = (color: string) =>
  `font-size:9px;letter-spacing:.03em;color:${color};border:1px solid ${color};padding:1px 6px`;
const statusBadge = (color: string) =>
  `font-size:10px;letter-spacing:.03em;color:${color};border:1px solid ${color};padding:2px 8px`;

/** Two-letter avatar initials from a display name (or channel-id fallback). */
function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

/** WhatsApp gets info-blue, every other channel gets accent-2 amber — mirrors the mockup's WA/other split. */
function channelColor(channel: string): string {
  return channel === "twilio" || channel === "whatsapp" ? "var(--info)" : "var(--accent-2)";
}

interface InboxParams {
  search?: string;
  filter?: string;
  selectedId?: string;
}

/** Preserve the current filter/search when building inbox URLs. */
function inboxUrl(p: InboxParams, convId?: string): string {
  const qs = new URLSearchParams();
  if (convId) qs.set("c", convId);
  if (p.filter) qs.set("f", p.filter);
  if (p.search) qs.set("q", p.search);
  const s = qs.toString();
  return `/admin/conversations${s ? `?${s}` : ""}`;
}

// --- Left pane: conversation list --------------------------------------------

export async function renderInboxList(env: Env, p: InboxParams): Promise<string> {
  const db = new Db(env.DB);
  const now = Date.now();

  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (p.search) {
    conds.push("(c.display_name LIKE ? OR c.channel_user_id LIKE ?)");
    params.push(`%${p.search}%`, `%${p.search}%`);
  }
  if (p.filter === "leads") {
    conds.push("EXISTS (SELECT 1 FROM leads l WHERE l.conversation_id = c.id)");
  } else if (p.filter === "atencion") {
    conds.push(
      "((c.paused_until IS NOT NULL AND c.paused_until > ?) OR EXISTS (SELECT 1 FROM tickets t WHERE t.conversation_id = c.id AND t.status != 'resolved'))",
    );
    params.push(now);
  } else if (p.filter === "molestos") {
    // Clasificación del Analista: revisar estas conversaciones = oro para mejorar.
    conds.push(
      "EXISTS (SELECT 1 FROM conversation_insights i WHERE i.conversation_id = c.id AND i.sentiment IN ('frustrated','angry'))",
    );
  } else if (p.filter === "contentos") {
    conds.push(
      "EXISTS (SELECT 1 FROM conversation_insights i WHERE i.conversation_id = c.id AND i.sentiment = 'positive')",
    );
  }
  const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const rows = await db.all<any>(
    `SELECT c.*,
       (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_msg,
       (SELECT COUNT(*) FROM leads l WHERE l.conversation_id = c.id) as lead_count,
       (SELECT status FROM leads l WHERE l.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as lead_status,
       (SELECT COUNT(*) FROM tickets t WHERE t.conversation_id = c.id AND t.status != 'resolved') as open_tickets,
       (SELECT sentiment FROM conversation_insights i WHERE i.conversation_id = c.id) as ai_sentiment
     FROM conversations c
     ${whereSql}
     ORDER BY c.last_message_at DESC LIMIT 50`,
    params,
  );

  const items = rows
    .map((r) => {
      const paused = r.paused_until && r.paused_until > now;
      const badges: string[] = [];
      if (r.lead_count > 0) {
        const b = LEAD_BADGE[r.lead_status as string] ?? LEAD_BADGE.new;
        badges.push(`<span style="${smallPill(b.color)}">${b.txt}</span>`);
      }
      if (r.open_tickets > 0) badges.push(`<span style="${smallPill("var(--accent-2)")}">🔔</span>`);
      if (paused) badges.push(`<span style="${smallPill("var(--dim)")}">⏸</span>`);
      if (r.ai_sentiment === "frustrated" || r.ai_sentiment === "angry") {
        const s = SENTIMENT_BADGE[r.ai_sentiment as string];
        badges.push(`<span style="${smallPill(SENTIMENT_COLOR[r.ai_sentiment as string])}">${s.txt}</span>`);
      }
      const selected = r.id === p.selectedId;
      const name = escapeHtml(r.display_name ?? r.channel_user_id ?? "—");
      const preview = escapeHtml((r.last_msg ?? "").replace(/\s+/g, " ").slice(0, 60));
      const initials = initialsOf(r.display_name ?? r.channel_user_id ?? "?");
      const chanColor = channelColor(r.channel);

      return `
      <a href="${inboxUrl(p, r.id)}" class="convrow" style="display:flex;gap:11px;padding:12px 14px;border-bottom:1px solid var(--line);cursor:pointer;${selected ? "background:var(--panel2);border-left:2px solid var(--accent)" : "border-left:2px solid transparent"}">
        <div style="width:34px;height:34px;flex:none;background:var(--raise);border:1px solid var(--linelit);display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700;color:var(--accent)">${initials}</div>
        <div style="min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:12.5px;font-weight:600;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--cream)">${name}</span>
            <span style="font-size:9px;letter-spacing:.05em;color:${chanColor};border:1px solid ${chanColor};padding:0 5px;flex:none">${escapeHtml(channelLabel(r.channel))}</span>
            <span style="margin-left:auto;font-size:9.5px;color:var(--dim);white-space:nowrap">${ago(r.last_message_at)}</span>
          </div>
          <div style="font-size:11.5px;color:var(--muted);white-space:nowrap;text-overflow:ellipsis;overflow:hidden;margin-top:3px">${preview || "—"}</div>
          ${badges.length ? `<div style="display:flex;gap:5px;margin-top:6px;flex-wrap:wrap">${badges.join("")}</div>` : ""}
        </div>
      </a>`;
    })
    .join("") ||
    `<div style="padding:32px 16px;text-align:center;font-size:12.5px;color:var(--dim)">Sin conversaciones${p.filter ? " con este filtro" : ""}.</div>`;

  return items;
}

// --- Right pane: live thread (header + messages, polled) ----------------------


/**
 * EL TELÉFONO DEL CLIENTE, SIEMPRE VISIBLE Y COPIABLE.
 *
 * En cuanto alguien le pone nombre a un contacto, el número desaparecía del
 * panel — y es lo ÚNICO con lo que el equipo puede contactar a esa persona
 * desde otro celular, o pasárselo a alguien que no tiene acceso al panel.
 *
 * Telegram no finge ser un teléfono: ahí se muestra el id tal cual, porque
 * escribir "+42" sería mentir.
 */
function esTelefono(canal: string | null | undefined): boolean {
  const c = (canal ?? "").toLowerCase();
  return c === "whatsapp" || c === "twilio" || c === "meta";
}

/** "51999888777" -> "+51 999 888 777": se lee, y se copia entero de un clic. */
function telefonoLegible(id: string): string {
  const d = (id ?? "").replace(/\D/g, "");
  if (d.length < 8) return id;
  return "+" + d.replace(/^(\d{1,3})(\d{3})(\d{3})(\d{3,})$/, "$1 $2 $3 $4");
}

function bloqueContacto(canal: string | null | undefined, idCanal: string): string {
  const tel = esTelefono(canal);
  const visible = tel ? telefonoLegible(idCanal) : idCanal;
  const crudo = tel ? "+" + (idCanal ?? "").replace(/\D/g, "") : idCanal;
  const enlace = tel
    ? `<a href="https://api.whatsapp.com/send?phone=${encodeURIComponent((idCanal ?? "").replace(/\D/g, ""))}" target="_blank" rel="noopener"
         title="Abrir este chat en tu WhatsApp" style="color:inherit;text-decoration:none;border-bottom:1px dotted currentColor">${escapeHtml(visible)}</a>`
    : escapeHtml(visible);
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dim)">
    ${enlace}
    <button type="button" title="Copiar" aria-label="Copiar el contacto"
            onclick="navigator.clipboard.writeText('${crudo.replace(/'/g, "")}');this.textContent='✓';setTimeout(()=>this.textContent='⧉',1200)"
            style="background:none;border:none;color:inherit;cursor:pointer;font-size:11px;padding:0 2px;line-height:1">⧉</button>
  </span>`;
}

export async function renderThreadLive(env: Env, convId: string): Promise<string> {
  const db = new Db(env.DB);
  const conv = await db.first<any>("SELECT * FROM conversations WHERE id = ?", [convId]);
  if (!conv) return `<div style="padding:24px;font-size:12.5px;color:var(--dim)">Conversación no encontrada.</div>`;

  const insight = await new InsightsRepo(db).getByConversation(convId);
  const msgs = await db.all<any>(
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 100",
    [convId],
  );

  const now = Date.now();
  const paused = conv.paused_until && conv.paused_until > now;
  const openTicket =
    (await db.first<{ n: number }>(
      "SELECT COUNT(*) as n FROM tickets WHERE conversation_id = ? AND status != 'resolved'",
      [convId],
    ))?.n ?? 0;

  // Header: identity + live state + takeover controls.
  const statusColor = paused ? "var(--accent-2)" : "var(--ok)";
  const statusPill = `<span style="${statusBadge(statusColor)}">${
    paused ? "⏸ bot pausado · tú tienes el control" : "🟢 bot activo"
  }</span>`;

  // "NEUTRAL" NO SE MUESTRA. El analizador clasifica cómo quedó el cliente en
  // cuatro casillas, y "neutral" es la de "no detecté nada": es la enorme
  // mayoría de las conversaciones. Una etiqueta que sale casi siempre y no dice
  // nada solo roba sitio en la barra y le quita fuerza a las que sí importan.
  //
  // Sin etiqueta = todo normal. Cuando aparezca una, significa algo.
  // Las alertas del dueño no cambian: nunca dependieron de "neutral", y la
  // lista de conversaciones ya filtraba así (solo frustrated/angry).
  const sentBadge =
    insight?.sentiment &&
    insight.sentiment !== "neutral" &&
    SENTIMENT_BADGE[insight.sentiment]
      ? `<span style="${statusBadge(SENTIMENT_COLOR[insight.sentiment])}">${SENTIMENT_BADGE[insight.sentiment].txt}</span>`
      : "";

  const controls = paused
    ? `
    <details style="position:relative;margin-left:auto">
      <summary class="chip"
               hx-post="/admin/conversations/${encodeURIComponent(convId)}/resume"
               hx-swap="none"
               title="Devolver el bot: vuelve a responder en este chat"
               style="cursor:pointer;list-style:none;font-size:11px;color:var(--accent-2);background:var(--panel2);border:1px solid var(--linelit);padding:6px 11px;display:inline-flex;align-items:center;gap:6px">▸ Devolver bot</summary>
      <form method="POST" action="/admin/conversations/${encodeURIComponent(convId)}/resume"
            style="position:absolute;right:0;z-index:10;margin-top:8px;width:280px;background:var(--panel);border:1px solid var(--linelit);box-shadow:6px 6px 0 rgba(0,0,0,.4);padding:12px">
        <p style="font-size:11px;color:var(--muted);margin:0 0 8px">Cuéntale al bot qué resolviste para que siga con contexto.</p>
        <textarea name="summary" rows="3" required placeholder="Ej. Ya le confirmé su pago y le di acceso."
                  style="width:100%;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:8px 10px;font-size:12px;outline:none;resize:vertical;margin-bottom:8px"></textarea>
        <button class="bigbtn" style="width:100%;background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:3px 3px 0 var(--linelit);padding:9px;font-size:12px;font-weight:700;font-family:'Space Grotesk';cursor:pointer">Enviar al bot</button>
      </form>
    </details>`
    : `
    <button hx-post="/admin/conversations/${encodeURIComponent(convId)}/pause" hx-target="#thread-live" hx-swap="innerHTML"
            class="chip" style="margin-left:auto;font-size:11px;color:var(--muted);background:var(--panel2);border:1px solid var(--linelit);padding:6px 11px;cursor:pointer">
      ⏸ Pausar bot aquí
    </button>`;

  const header = `
  <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel)">
    <span style="font-family:'Space Grotesk';font-weight:600;font-size:14px;color:var(--cream)">${escapeHtml(conv.display_name || "Sin nombre")}</span>
    ${bloqueContacto(conv.channel, conv.channel_user_id)}
    <span style="${smallPill("var(--info)")}">${escapeHtml(channelLabel(conv.channel))}</span>
    ${statusPill}
    ${sentBadge}
    ${openTicket > 0 ? `<span style="${statusBadge("var(--accent-2)")}">🔔 ticket abierto</span>` : ""}
    ${controls}
  </div>`;

  // Messages, DESC in the DOM + column-reverse = pinned to bottom.
  const bubbles = msgs
    .map((m) => {
      const time = fmtDateTime(m.created_at, {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      });

      // Tool chips (what the bot DID this turn) render above the bubble; in a
      // reversed column that means AFTER it in the DOM.
      let chips = "";
      if (m.tool_calls) {
        try {
          const calls = JSON.parse(m.tool_calls) as { toolName: string; input?: unknown }[];
          chips = calls
            .map(
              (tc) => `
            <div style="align-self:flex-end;display:inline-flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dim);border:1px dashed var(--linelit);padding:3px 10px;margin-bottom:2px">→ <span style="color:var(--accent);font-weight:600">${escapeHtml(tc.toolName ?? "?")}</span> «${escapeHtml(toolInputSummary(tc.input))}»</div>`,
            )
            .join("");
        } catch { /* legacy/malformed tool_calls JSON — skip chips */ }
      }

      if (m.role === "user") {
        return `
        <div style="display:flex;flex-direction:column;align-items:flex-start;gap:4px;max-width:78%">
          <div style="background:var(--panel2);border:1px solid var(--line);padding:9px 13px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;color:var(--cream)">${escapeHtml(m.content)}</div>
          <span style="font-size:9.5px;color:var(--dim)">${time}</span>
        </div>`;
      }

      const isOwner = m.role === "owner";
      const cost = turnCost(m);
      const meta = isOwner
        ? `Tú · ${time}`
        : [m.model_used ? modelShort(m.model_used) : null, cost || null, time].filter(Boolean).join(" · ");
      const bubbleBg = isOwner
        ? "background:rgba(245,166,35,.1);border:1px solid rgba(245,166,35,.4)"
        : "background:var(--accent-soft);border:1px solid var(--linelit)";
      return `
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:78%;margin-left:auto">
        ${chips}
        <div style="${bubbleBg};padding:9px 13px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;color:var(--cream)">${escapeHtml(m.content)}</div>
        <span style="font-size:9.5px;color:var(--dim)">${meta}</span>
      </div>`;
    })
    .join("");

  return `
  ${header}
  <div id="msgscroll" style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column-reverse;gap:12px;padding:16px;background:var(--bg)">
    ${bubbles || `<div style="text-align:center;font-size:12.5px;color:var(--dim);padding:32px 0">Sin mensajes.</div>`}
  </div>`;
}

// --- Composer (static per selection — NOT inside the polled fragment) ---------

function renderComposer(convId: string): string {
  const id = encodeURIComponent(convId);
  return `
  <div style="border-top:1px solid var(--line);background:var(--panel);padding:12px;display:flex;flex-direction:column;gap:8px">
    <div id="suggestion-box"></div>
    <form hx-post="/admin/conversations/${id}/reply" hx-target="#send-status" hx-swap="innerHTML"
          hx-on::after-request="if(event.detail.xhr.getResponseHeader('X-Sent')==='1')this.reset()"
          style="display:flex;align-items:flex-end;gap:9px">
      <textarea name="text" id="reply-text" rows="2" required
                placeholder="Responde como humano — se envía por el canal del cliente y el bot se pausa…"
                style="flex:1;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:10px 12px;font-size:12.5px;resize:none;outline:none"></textarea>
      <button type="button" hx-post="/admin/conversations/${id}/suggest" hx-target="#suggestion-box" hx-swap="innerHTML"
              class="chip" style="background:var(--panel2);border:1px solid var(--linelit);color:var(--accent-2);padding:11px 13px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:6px" title="El co-pilot sugiere una respuesta">
        <i data-lucide="sparkles" width="13" height="13"></i> Sugerir
      </button>
      <button type="submit" class="bigbtn" style="background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:4px 4px 0 var(--linelit);padding:11px 18px;font-size:12.5px;font-weight:700;font-family:'Space Grotesk';cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:6px">
        Enviar <i data-lucide="send" width="14" height="14"></i>
      </button>
    </form>
    <div id="send-status" style="font-size:11px;min-height:1rem;color:var(--muted)"></div>
  </div>`;
}

/** Fragment returned by /suggest — suggestion + a "use it" button that fills the textarea. */
export function renderSuggestionBox(text: string): string {
  return `
  <div style="border:1px solid var(--accent-2);background:rgba(245,166,35,.08);padding:10px 12px;font-size:12.5px;display:flex;align-items:flex-start;gap:10px">
    <div style="flex:1">
      <div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-2);margin-bottom:3px">✦ Sugerencia del co-pilot</div>
      <div class="sugg-text" style="white-space:pre-wrap;color:var(--cream)">${escapeHtml(text)}</div>
    </div>
    <button type="button"
            onclick="document.getElementById('reply-text').value=this.parentElement.querySelector('.sugg-text').textContent;document.getElementById('suggestion-box').innerHTML=''"
            class="chip" style="font-size:11px;background:var(--accent-2);color:#1a1206;font-weight:700;border:1px solid var(--accent-2);padding:5px 10px;white-space:nowrap;cursor:pointer">Usar</button>
  </div>`;
}

// --- Full page -----------------------------------------------------------------

export async function renderInbox(env: Env, p: InboxParams): Promise<string> {
  const db = new Db(env.DB);
  const now = Date.now();

  const totalConvs = (await db.first<{ n: number }>("SELECT COUNT(*) as n FROM conversations"))?.n ?? 0;
  const totalLeads = (await db.first<{ n: number }>("SELECT COUNT(*) as n FROM leads"))?.n ?? 0;
  const nMolestos =
    (await db.first<{ n: number }>(
      "SELECT COUNT(*) as n FROM conversation_insights WHERE sentiment IN ('frustrated','angry')",
    ))?.n ?? 0;
  const nContentos =
    (await db.first<{ n: number }>(
      "SELECT COUNT(*) as n FROM conversation_insights WHERE sentiment = 'positive'",
    ))?.n ?? 0;
  const needAttention =
    (await db.first<{ n: number }>(
      `SELECT COUNT(*) as n FROM conversations c
       WHERE (c.paused_until IS NOT NULL AND c.paused_until > ?)
          OR EXISTS (SELECT 1 FROM tickets t WHERE t.conversation_id = c.id AND t.status != 'resolved')`,
      [now],
    ))?.n ?? 0;

  const filterPill = (href: string, label: string, active: boolean, color: string) =>
    `<a href="${href}" class="chip" style="font-size:11px;letter-spacing:.05em;padding:5px 12px;white-space:nowrap;border:1px solid ${color};${
      active ? `background:${color};color:#1a1206;font-weight:700` : `color:${color}`
    }">${label}</a>`;

  const list = await renderInboxList(env, p);

  const listPollUrl = `/admin/conversations/list-fragment?${new URLSearchParams({
    ...(p.filter ? { f: p.filter } : {}),
    ...(p.search ? { q: p.search } : {}),
    ...(p.selectedId ? { c: p.selectedId } : {}),
  }).toString()}`;

  let rightPane: string;
  if (p.selectedId) {
    const thread = await renderThreadLive(env, p.selectedId);
    rightPane = `
      <div id="thread-live" class="flex flex-col flex-1 min-h-0"
           hx-get="/admin/conversations/thread/${encodeURIComponent(p.selectedId)}"
           hx-trigger="every 5s[window.puedeRefrescar('msgscroll')]" hx-swap="innerHTML">
        ${thread}
      </div>
      ${renderComposer(p.selectedId)}`;
  } else {
    rightPane = `
      <div class="flex-1 flex items-center justify-center" style="font-size:12.5px;color:var(--dim);background:var(--bg)">
        Selecciona una conversación para abrirla aquí.
      </div>`;
  }

  const body = `
    <div class="flex flex-wrap items-center gap-2" style="margin-bottom:14px">
      ${filterPill(inboxUrl({ selectedId: p.selectedId }), `Todas · ${totalConvs}`, !p.filter, "var(--accent)")}
      ${filterPill(inboxUrl({ filter: "leads", selectedId: p.selectedId }), `💰 Leads · ${totalLeads}`, p.filter === "leads", "var(--accent)")}
      ${filterPill(inboxUrl({ filter: "atencion", selectedId: p.selectedId }), `🔔 Atención · ${needAttention}`, p.filter === "atencion", "var(--bad)")}
      ${filterPill(inboxUrl({ filter: "molestos", selectedId: p.selectedId }), `😠 Molestos · ${nMolestos}`, p.filter === "molestos", "var(--bad)")}
      ${filterPill(inboxUrl({ filter: "contentos", selectedId: p.selectedId }), `🙂 Contentos · ${nContentos}`, p.filter === "contentos", "var(--ok)")}
      <form method="GET" action="/admin/conversations" class="ml-auto" style="display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);padding:7px 12px;min-width:220px">
        <i data-lucide="search" width="14" height="14" style="color:var(--dim)"></i>
        ${p.filter ? `<input type="hidden" name="f" value="${escapeHtml(p.filter)}">` : ""}
        ${p.selectedId ? `<input type="hidden" name="c" value="${escapeHtml(p.selectedId)}">` : ""}
        <input name="q" value="${escapeHtml(p.search ?? "")}" placeholder="Buscar cliente…"
               style="flex:1;background:transparent;border:none;color:var(--cream);font-size:12px;outline:none">
      </form>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-[320px_1fr] overflow-hidden" style="border:1px solid var(--line);background:var(--panel);height:calc(100vh - 200px);min-height:480px">
      <div class="border-r border-line flex flex-col" style="min-height:0">
        <div id="conv-list" class="overflow-y-auto flex-1"
             hx-get="${listPollUrl}" hx-trigger="every 10s[window.puedeRefrescar('conv-list')]" hx-swap="innerHTML">
          ${list}
        </div>
      </div>
      <div class="flex flex-col" style="min-height:0;background:var(--bg)">
        ${rightPane}
      </div>
    </div>`;

  return layout({ title: "Conversaciones", activeTab: "conversations", body, env });
}
