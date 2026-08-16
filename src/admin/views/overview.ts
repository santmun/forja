import type { Env } from "../../env";
import { Db } from "../../db/client";
import { layout } from "./layout";
import { costOfUsage, type ModelId } from "../../pricing";
import { resolveAgentConfig, type AgentConfig } from "../../settings-loader";
import { buildTools } from "../../tools";
import { resolveProvider, modelIdFor } from "../../llm/provider";
import { handoffNotifyStatus } from "../../tools/handoffHuman";
import { connectionsSummary } from "./conexiones";
import { KbDocsRepo, FIXTURE_CHUNKS } from "../../kb/docs";
import { InsightsRepo } from "../../db/insights";
import { SuggestionsRepo } from "../../db/suggestions";
import { channelLabel } from "../../channels/labels";
import { getNiche } from "../../niches";
import { avatarContacto } from "./avatarContacto";

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

/** Short relative time in Spanish (ej. "hace 5 min", "hace 2 h", "hace 3 d"). */
function ago(ms: number | null | undefined): string {
  if (!ms) return "—";
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

/** "auto" or the concrete model id the agent is pinned to. */
function agentModelLabel(env: Env, cfg: AgentConfig): string {
  if (cfg.modelOverride === "auto") return "auto";
  const provider = resolveProvider(env);
  return modelIdFor(env, provider, cfg.modelOverride === "haiku" ? "fast" : "smart");
}

// Single-letter Spanish day-of-week labels, indexed like Date#getUTCDay() (0 = Dom).
const DOW_LETTER = ["D", "L", "M", "M", "J", "V", "S"];

export async function renderOverview(env: Env): Promise<string> {
  const db = new Db(env.DB);
  const niche = getNiche(env);
  const oneDay = Date.now() - 86_400_000;
  const sevenDays = Date.now() - 7 * 86_400_000;
  const thirtyDays = Date.now() - 30 * 86_400_000;

  const todayMsgs = (await db.first<{ n: number }>(
    "SELECT COUNT(*) as n FROM messages WHERE created_at > ?", [oneDay],
  ))?.n ?? 0;
  const todayConvs = (await db.first<{ n: number }>(
    "SELECT COUNT(DISTINCT conversation_id) as n FROM messages WHERE created_at > ?", [oneDay],
  ))?.n ?? 0;
  const todayLeads = (await db.first<{ n: number }>(
    "SELECT COUNT(*) as n FROM leads WHERE created_at > ?", [oneDay],
  ))?.n ?? 0;

  const monthMsgs = (await db.first<{ n: number }>(
    "SELECT COUNT(*) as n FROM messages WHERE created_at > ?", [thirtyDays],
  ))?.n ?? 0;

  const tokenUsage = await db.all<{ model_used: string; input: number; output: number; cached: number }>(
    `SELECT model_used,
            SUM(COALESCE(input_tokens, 0)) as input,
            SUM(COALESCE(output_tokens, 0)) as output,
            SUM(COALESCE(cached_input_tokens, 0)) as cached
     FROM messages WHERE created_at > ? GROUP BY model_used`,
    [thirtyDays],
  );
  let totalCost = 0;
  for (const row of tokenUsage) {
    if (!row.model_used) continue;
    totalCost += costOfUsage(row.model_used as ModelId, {
      input: row.input,
      output: row.output,
      cached: row.cached,
    });
  }

  const openTickets = (await db.first<{ n: number }>(
    "SELECT COUNT(*) as n FROM tickets WHERE status != 'resolved'",
  ))?.n ?? 0;

  // --- Actividad 7 días ---------------------------------------------------------
  const activityRows = await db.all<{ day: string; msgs: number }>(
    `SELECT date(created_at / 1000, 'unixepoch') as day, COUNT(*) as msgs
     FROM messages WHERE created_at > ? GROUP BY day ORDER BY day ASC`,
    [sevenDays],
  );
  const activityByDay = new Map(activityRows.map((r) => [r.day, r.msgs]));
  const activityDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    return { dow: d.getUTCDay(), msgs: activityByDay.get(key) ?? 0, isToday: i === 6 };
  });
  const activityMax = Math.max(...activityDays.map((d) => d.msgs), 1);

  // --- Estado del agente ----------------------------------------------------------
  const toolNames = Object.keys(buildTools({ env, getConversationId: () => null }));
  const agentCfg = await resolveAgentConfig(env, toolNames);
  const kbDocs = await new KbDocsRepo(db).list();
  const totalKbDocs = kbDocs.length + FIXTURE_CHUNKS.length;
  const insight7d = await new InsightsRepo(db).stats(sevenDays);
  const resolvedPct7d =
    insight7d.analyzed > 0 ? Math.round((insight7d.resolvedNoHuman / insight7d.analyzed) * 100) : null;

  // --- Conversaciones recientes -----------------------------------------------------
  const recentConvs = await db.all<{
    id: string;
    display_name: string | null;
    channel_user_id: string | null;
    channel: string;
    last_message_at: number | null;
    last_msg: string | null;
  }>(
    `SELECT c.id, c.display_name, c.channel_user_id, c.channel, c.last_message_at,
       (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_msg
     FROM conversations c ORDER BY c.last_message_at DESC LIMIT 5`,
  );

  // --- Mejoras sugeridas -------------------------------------------------------------
  const proposedSuggestions = await new SuggestionsRepo(db).listProposed();

  // --- Markup: actividad + estado del agente -----------------------------------------
  const activityChart = `
    <div class="card bg-panel border border-line p-[18px]" style="animation-delay:.22s">
      <div class="font-display font-semibold text-[15px] text-cream flex items-center gap-2 mb-0.5">
        <i data-lucide="bar-chart-3" width="16" height="16" class="text-accent"></i>
        Actividad — últimos 7 días
      </div>
      <div class="text-[11px] text-dim mb-1">mensajes procesados por día</div>
      <div class="flex items-end gap-3" style="height:150px;padding-top:16px">
        ${activityDays
          .map((d) => {
            const pct = d.msgs === 0 ? 3 : Math.max(8, Math.round((d.msgs / activityMax) * 90));
            const label = d.isToday ? "HOY" : DOW_LETTER[d.dow];
            const barColor = d.isToday ? "var(--accent)" : "var(--linelit)";
            const numClass = d.isToday ? "text-accent font-semibold" : "text-muted";
            const labelClass = d.isToday ? "text-accent font-semibold" : "text-dim";
            return `
            <div class="bargrp flex-1 flex flex-col items-center gap-2" style="height:100%;justify-content:flex-end">
              <div class="text-[10px] ${numClass}">${d.msgs}</div>
              <div class="bar" style="width:100%;height:${pct}%;background:${barColor}"></div>
              <div class="text-[10px] ${labelClass}">${label}</div>
            </div>`;
          })
          .join("")}
      </div>
    </div>`;

  const agentStatus = `
    <div class="card bg-panel border border-line p-[18px] flex flex-col" style="animation-delay:.26s">
      <div class="font-display font-semibold text-[15px] text-cream flex items-center gap-2 mb-3.5">
        <i data-lucide="activity" width="16" height="16" class="text-accent"></i>
        Estado del agente
      </div>
      <div class="flex flex-col gap-[11px] text-[12.5px]">
        <div class="flex items-center justify-between">
          <span class="text-muted">Modelo activo</span>
          <span class="font-semibold font-mono text-[11.5px]">${esc(agentModelLabel(env, agentCfg))}</span>
        </div>
        <div style="height:1px;background:var(--line)"></div>
        <div class="flex items-center justify-between">
          <span class="text-muted">Tools activas</span>
          <span class="font-semibold">${agentCfg.enabledToolNames.length} <span class="text-dim font-normal">de ${toolNames.length}</span></span>
        </div>
        <div style="height:1px;background:var(--line)"></div>
        <div class="flex items-center justify-between">
          <span class="text-muted">Docs de conocimiento</span>
          <span class="font-semibold">${totalKbDocs} <span class="text-dim font-normal">(${FIXTURE_CHUNKS.length} precargados)</span></span>
        </div>
        <div style="height:1px;background:var(--line)"></div>
        <div class="flex items-center justify-between">
          <span class="text-muted">Resueltas sin humano</span>
          <span class="font-semibold ${resolvedPct7d === null ? "text-dim" : "text-ok"}">${resolvedPct7d === null ? "—" : `${resolvedPct7d}%`}</span>
        </div>
      </div>
      <a href="/admin/agente" class="bigbtn font-display font-bold text-[12.5px] cursor-pointer flex items-center justify-center gap-2"
         style="background:var(--accent);color:#1a1206;border:1px solid var(--accent);box-shadow:4px 4px 0 var(--linelit);padding:13px;margin-top:18px">
        <i data-lucide="settings-2" width="16" height="16"></i> Ajustar mi agente
      </a>
    </div>`;

  // --- Markup: conversaciones recientes + mejoras sugeridas --------------------------
  const convRows =
    recentConvs
      .map((c) => {
        const label = c.display_name ?? c.channel_user_id ?? "—";
        const name = esc(label);

        const preview = esc((c.last_msg ?? "").replace(/\s+/g, " ").slice(0, 60)) || "—";
        const chanColor = c.channel === "twilio" || c.channel === "whatsapp" ? "var(--info)" : "var(--accent-2)";
        return `
        <a href="/admin/conversations?c=${encodeURIComponent(c.id)}" class="convrow flex items-center gap-3" style="padding:12px 18px;border-top:1px solid var(--line);cursor:pointer">
          ${avatarContacto(label, c.channel_user_id ?? c.id, 36)}
          <div class="flex-1" style="min-width:0">
            <div class="flex items-center gap-2">
              <span class="text-[13px] font-semibold text-cream">${name}</span>
              <span style="font-size:9px;letter-spacing:.05em;color:${chanColor};border:1px solid ${chanColor};padding:0 5px">${esc(channelLabel(c.channel))}</span>
            </div>
            <div class="text-[12px] text-muted mt-0.5" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${preview}</div>
          </div>
          <div class="text-[10px] text-dim flex-none">${ago(c.last_message_at)}</div>
          <i data-lucide="chevron-right" width="16" height="16" class="arr flex-none" style="color:var(--accent);opacity:0;transform:translateX(-4px);transition:all .15s ease"></i>
        </a>`;
      })
      .join("") || `<div class="text-center text-[12.5px] text-dim" style="padding:32px 16px">Aún no hay conversaciones.</div>`;

  const recentConversations = `
    <div class="card bg-panel border border-line" style="animation-delay:.3s">
      <div class="flex items-center justify-between" style="padding:16px 18px 12px">
        <div class="font-display font-semibold text-[15px] text-cream flex items-center gap-2">
          <i data-lucide="messages-square" width="16" height="16" class="text-accent"></i>
          Conversaciones recientes
        </div>
        <a href="/admin/conversations" class="flex items-center gap-1 text-[11.5px]">ver todas <i data-lucide="arrow-right" width="13" height="13"></i></a>
      </div>
      <div>${convRows}</div>
    </div>`;

  const suggestionItems =
    proposedSuggestions.length === 0
      ? `<p class="text-[12px] text-dim">Sin mejoras pendientes.</p>`
      : proposedSuggestions
          .slice(0, 2)
          .map(
            (s) =>
              `<div class="text-[12.5px] text-cream mb-2" style="border:1px solid var(--linelit);background:var(--panel);padding:10px 12px;line-height:1.45">${esc(s.title)}</div>`,
          )
          .join("");

  const suggestedImprovements = `
    <div class="card bg-panel border border-line p-[18px] relative overflow-hidden" style="animation-delay:.34s;background:linear-gradient(160deg,var(--panel2),var(--panel));border-color:var(--linelit)">
      <div class="flex items-center gap-2 mb-1">
        <i data-lucide="sparkles" width="16" height="16" class="text-accent2"></i>
        <span class="font-display font-semibold text-[15px] text-cream">Mejoras sugeridas</span>
      </div>
      <div class="text-[11px] text-dim mb-3.5">
        ${proposedSuggestions.length} ${proposedSuggestions.length === 1 ? "sugerencia detectada" : "sugerencias detectadas"} por IA sobre tus conversaciones
      </div>
      ${suggestionItems}
      <a href="/admin/mejoras" class="flex items-center gap-1 text-[11.5px] mt-2.5">ver todas <i data-lucide="arrow-right" width="13" height="13"></i></a>
    </div>`;

  const body = `
    <div class="flex flex-col gap-[22px]">
      <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-[14px]">
        <div class="card bg-panel border border-line p-4 relative overflow-hidden" style="animation-delay:.02s">
          <div class="absolute top-3 right-3 text-[9.5px] tracking-[.2em] text-dim uppercase">01</div>
          <div class="flex items-center gap-2 text-muted">
            <i data-lucide="message-circle" width="15" height="15"></i>
            <span class="text-[11px] tracking-[.05em]">MENSAJES HOY</span>
          </div>
          <div class="glow font-display font-bold text-[38px] leading-none mt-3">${todayMsgs}</div>
          <div class="text-[11px] text-dim mt-2">últimas 24 horas</div>
        </div>

        <div class="card bg-panel border border-line p-4 relative overflow-hidden" style="animation-delay:.06s">
          <div class="absolute top-3 right-3 text-[9.5px] tracking-[.2em] text-dim uppercase">02</div>
          <div class="flex items-center gap-2 text-muted">
            <i data-lucide="users" width="15" height="15"></i>
            <span class="text-[11px] tracking-[.05em]">CLIENTES ÚNICOS</span>
          </div>
          <div class="glow font-display font-bold text-[38px] leading-none mt-3">${todayConvs}</div>
          <div class="text-[11px] text-dim mt-2">conversaciones distintas hoy</div>
        </div>

        <div class="card bg-panel border border-line p-4 relative overflow-hidden" style="animation-delay:.1s">
          <div class="absolute top-3 right-3 text-[9.5px] tracking-[.2em] text-dim uppercase">03</div>
          <div class="flex items-center gap-2 text-muted">
            <i data-lucide="${niche.navIcon}" width="15" height="15"></i>
            <span class="text-[11px] tracking-[.05em]">${niche.kpiLabel.toUpperCase()}</span>
          </div>
          <div class="glow font-display font-bold text-[38px] leading-none mt-3 text-accent">${todayLeads}</div>
          <div class="text-[11px] text-dim mt-2">nuevos hoy</div>
        </div>

        <div class="card bg-panel border border-line p-4 relative overflow-hidden" style="animation-delay:.14s">
          <div class="absolute top-3 right-3 text-[9.5px] tracking-[.2em] text-dim uppercase">04</div>
          <div class="flex items-center gap-2 text-muted">
            <i data-lucide="coins" width="15" height="15"></i>
            <span class="text-[11px] tracking-[.05em]">COSTO DEL MES</span>
          </div>
          <div class="glow font-display font-bold text-[38px] leading-none mt-3">$${totalCost.toFixed(2)}</div>
          <div class="text-[11px] text-dim mt-2">${monthMsgs} mensajes · Claude · 30 días</div>
        </div>
      </section>

      <section class="card bg-panel border border-line p-[18px]" style="animation-delay:.18s">
        <div class="flex items-center justify-between">
          <div class="font-display font-semibold text-[15px] text-cream flex items-center gap-2">
            <i data-lucide="activity" width="16" height="16" class="text-accent"></i>
            Salud del bot
          </div>
          <a href="/admin/tickets" class="flex items-center gap-1 text-[11.5px]">
            ver tickets <i data-lucide="arrow-right" width="13" height="13"></i>
          </a>
        </div>
        <div class="mt-3" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${
            openTickets > 0
              ? `<span style="font-size:9px;color:var(--bad);border:1px solid var(--bad);padding:1px 6px">⚠ ${openTickets} tickets abiertos</span>`
              : `<span style="font-size:9px;color:var(--ok);border:1px solid var(--ok);padding:1px 6px">✓ 0 tickets abiertos</span>`
          }
          ${(() => {
            // Cuando el bot escala a humano, ¿alguien se entera? Antes esto
            // fallaba en silencio; ahora se ve aquí en rojo si falta configurar.
            const notify = handoffNotifyStatus(env);
            return notify.ok
              ? `<span style="font-size:9px;color:var(--ok);border:1px solid var(--ok);padding:1px 6px">✓ handoff avisa por ${notify.channels.join(" + ")}</span>`
              : `<span style="font-size:9px;color:var(--bad);border:1px solid var(--bad);padding:1px 6px">⚠ HANDOFF SIN AVISO — el bot crea tickets pero NADIE recibe notificación (configura Telegram, WhatsApp o email del dueño)</span>`;
          })()}
          ${(() => {
            const conn = connectionsSummary(env);
            const ok = conn.connected > 0;
            return `<a href="/admin/conexiones" style="font-size:9px;color:${ok ? "var(--ok)" : "var(--bad)"};border:1px solid ${ok ? "var(--ok)" : "var(--bad)"};padding:1px 6px;text-decoration:none">${ok ? "✓" : "⚠"} ${conn.connected}/${conn.total} canales conectados</a>`;
          })()}
        </div>
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] gap-[14px]">
        ${activityChart}
        ${agentStatus}
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] gap-[14px]">
        ${recentConversations}
        ${suggestedImprovements}
      </section>
    </div>`;

  return layout({ title: "Overview", activeTab: "overview", body, env });
}
