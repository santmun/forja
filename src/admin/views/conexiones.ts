// "Conexiones" tab — el mapa de canales del bot. Cada canal es una card con
// estado VERDE (conectado) o gris (sin conectar), qué falta exactamente para
// conectarlo, y su webhook URL lista para copiar. Es la vista que guía el
// paso 4 del onboarding (CLAUDE.md): conectar canales uno por uno y verlos
// ponerse verdes.
import type { Env } from "../../env";
import { hidesForja } from "../brand";
import { layout } from "./layout";

interface ChannelStatus {
  id: string;
  name: string;
  icon: string; // lucide icon name
  desc: string;
  ok: boolean;
  /** Piezas faltantes (nombre de secret/var) cuando NO está conectado. */
  missing: string[];
  /** Ruta del webhook a registrar en el proveedor (si aplica). */
  webhookPath?: string;
  /** Nota de seguridad opcional (ej. secret del webhook sin configurar). */
  securityNote?: string;
  /** Cómo conectar, en 1-2 líneas. */
  howTo: string;
}

function channelStatuses(env: Env): ChannelStatus[] {
  const has = (v?: string) => Boolean(v && v.trim() !== "");

  const telegramMissing = [!has(env.TELEGRAM_BOT_TOKEN) && "TELEGRAM_BOT_TOKEN"].filter(
    Boolean,
  ) as string[];
  const twilioMissing = [
    !has(env.TWILIO_ACCOUNT_SID) && "TWILIO_ACCOUNT_SID",
    !has(env.TWILIO_AUTH_TOKEN) && "TWILIO_AUTH_TOKEN",
    !has(env.TWILIO_WA_FROM) && "TWILIO_WA_FROM",
  ].filter(Boolean) as string[];
  const metaMissing = [
    !has(env.META_PAGE_ACCESS_TOKEN) && "META_PAGE_ACCESS_TOKEN",
    !has(env.META_VERIFY_TOKEN) && "META_VERIFY_TOKEN",
    !has(env.META_APP_SECRET) && "META_APP_SECRET",
  ].filter(Boolean) as string[];
  const manychatMissing = [!has(env.MANYCHAT_API_KEY) && "MANYCHAT_API_KEY"].filter(
    Boolean,
  ) as string[];
  const whatsappCloudMissing = [
    !has(env.WHATSAPP_PHONE_NUMBER_ID) && "WHATSAPP_PHONE_NUMBER_ID",
    !has(env.WHATSAPP_ACCESS_TOKEN) && "WHATSAPP_ACCESS_TOKEN",
    !has(env.WHATSAPP_VERIFY_TOKEN || env.META_VERIFY_TOKEN) && "WHATSAPP_VERIFY_TOKEN",
    !has(env.WHATSAPP_APP_SECRET || env.META_APP_SECRET) && "WHATSAPP_APP_SECRET",
  ].filter(Boolean) as string[];

  return [
    {
      id: "telegram",
      name: "Telegram",
      icon: "send",
      desc: "Bot de Telegram — gratis y el más rápido de conectar.",
      ok: telegramMissing.length === 0,
      missing: telegramMissing,
      webhookPath: "/webhooks/telegram",
      howTo: "Crea el bot con @BotFather, guarda el token como secret y registra el webhook.",
    },
    {
      id: "whatsapp",
      name: "WhatsApp (Twilio)",
      icon: "phone",
      desc: "WhatsApp Business vía Twilio — el canal que más venden.",
      ok: twilioMissing.length === 0,
      missing: twilioMissing,
      webhookPath: "/webhooks/twilio",
      securityNote:
        twilioMissing.length === 0 && !has(env.TWILIO_HANDOFF_CONTENT_SID)
          ? "Sin TWILIO_HANDOFF_CONTENT_SID: el aviso de handoff por WhatsApp requiere una plantilla (HSM) aprobada."
          : undefined,
      howTo: "En Twilio: número WhatsApp aprobado → apunta el webhook de mensajes entrantes a la URL de abajo.",
    },
    {
      id: "whatsapp-cloud",
      name: "WhatsApp (Oficial · Cloud API)",
      icon: "message-circle",
      desc: "WhatsApp directo con Meta, sin intermediario — mejor margen.",
      ok: whatsappCloudMissing.length === 0,
      missing: whatsappCloudMissing,
      webhookPath: "/webhooks/whatsapp",
      howTo:
        "App de Meta → WhatsApp → Configuration: apunta el webhook a la URL de abajo, suscribe el campo messages, y guarda tu Phone Number ID y token. Pruébalo con el número de prueba gratis.",
    },
    {
      id: "meta",
      name: "Instagram + Messenger (Meta)",
      icon: "instagram",
      desc: "DMs de Instagram y Messenger con la API oficial de Meta.",
      ok: metaMissing.length === 0,
      missing: metaMissing,
      webhookPath: "/webhooks/meta",
      howTo: "App de Meta → Webhooks → suscribe messages con tu VERIFY_TOKEN; la firma se valida sola.",
    },
    {
      id: "manychat",
      name: "ManyChat",
      icon: "bot",
      desc: "Si ya usas ManyChat, el bot puede vivir detrás de tus flujos.",
      ok: manychatMissing.length === 0,
      missing: manychatMissing,
      webhookPath: "/webhooks/manychat",
      howTo: "En ManyChat: External Request hacia la URL de abajo.",
    },
  ];
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

export function renderConexiones(env: Env): string {
  const channels = channelStatuses(env);
  const connected = channels.filter((ch) => ch.ok).length;
  const base = (env.DASHBOARD_BASE_URL ?? "").replace(/\/$/, "");

  const cards = channels
    .map((ch) => {
      const badge = ch.ok
        ? `<span style="font-size:10px;letter-spacing:.14em;color:var(--ok);border:1px solid var(--ok);background:rgba(127,183,126,.08);padding:3px 10px;font-weight:700">● CONECTADO</span>`
        : `<span style="font-size:10px;letter-spacing:.14em;color:var(--dim);border:1px solid var(--line);padding:3px 10px;font-weight:600">○ SIN CONECTAR</span>`;

      const missing = ch.ok
        ? ""
        : `<div class="text-[11.5px]" style="color:var(--bad)">Falta configurar: <span class="font-mono">${ch.missing
            .map(esc)
            .join(", ")}</span></div>
           <div class="text-dim text-[11.5px]">${esc(ch.howTo)}</div>`;

      const webhook =
        ch.webhookPath && base
          ? `<div class="text-dim text-[10.5px] font-mono" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
               <span style="border:1px solid var(--line);padding:4px 8px;background:var(--bg)">${esc(base + ch.webhookPath)}</span>
               <button type="button" class="text-[10.5px]" style="border:1px solid var(--line);color:var(--cream);padding:4px 8px;cursor:pointer;background:none"
                       onclick="navigator.clipboard.writeText('${esc(base + ch.webhookPath)}');this.textContent='copiado ✓'">copiar</button>
             </div>`
          : "";

      const security = ch.securityNote
        ? `<div class="text-[11px]" style="color:var(--warn,#e9ad4f)">⚠ ${esc(ch.securityNote)}</div>`
        : "";

      return `
        <div class="bg-panel border ${ch.ok ? "" : "border-line"}" style="padding:18px 20px;display:flex;flex-direction:column;gap:10px;${ch.ok ? "border-color:rgba(127,183,126,.45)" : ""}">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
            <div class="font-display font-semibold text-[13.5px] text-cream" style="display:flex;align-items:center;gap:9px">
              <i data-lucide="${ch.icon}" width="16" height="16" class="${ch.ok ? "text-accent" : "text-dim"}"></i>
              ${esc(ch.name)}
            </div>
            ${badge}
          </div>
          <p class="text-dim text-[12px]" style="margin:0">${esc(ch.desc)}</p>
          ${missing}
          ${security}
          ${webhook}
        </div>`;
    })
    .join("");

  const body = `
    <div style="display:flex;flex-direction:column;gap:18px">
      <div style="display:flex;flex-direction:column;gap:2px">
        <h2 class="font-display font-semibold text-[15px] text-cream">Canales conectados: ${connected} de ${channels.length}</h2>
        <p class="text-muted text-[12.5px]">Conecta los canales donde están tus clientes. Cuando un canal queda listo, su tarjeta se pone verde. Los secrets se configuran con <span class="font-mono">wrangler secret put NOMBRE</span>${hidesForja(env) ? "" : " (o pídeselo a Claude Code)"}.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px">
        ${cards}
      </div>
    </div>`;

  return layout({ title: "Conexiones", activeTab: "conexiones", body, env });
}

/** Resumen corto para el badge de salud del Resumen. */
export function connectionsSummary(env: Env): { connected: number; total: number } {
  const channels = channelStatuses(env);
  return { connected: channels.filter((ch) => ch.ok).length, total: channels.length };
}
