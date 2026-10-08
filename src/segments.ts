/**
 * Segmentación de audiencias (modo evento) — la moneda de las campañas.
 *
 * Cada segmento es una consulta sobre datos que el bot YA captura: keywords,
 * clicks en links trackeados, etiquetas de la minería (interés/objeción) y
 * actividad. Cada miembro sale con `inWindow`: si su último mensaje fue hace
 * <24h, WhatsApp permite responderle free-form (gratis, sin plantilla); si no,
 * hay que usar plantilla HSM aprobada (cuenta contra el límite diario del
 * número — p.ej. 250 conversaciones iniciadas por el negocio cada 24h).
 */
import { Db } from "./db/client";

export interface SegmentMember {
  conversationId: string;
  channel: string;
  channelUserId: string;
  name: string | null;
  lastUserAt: number;
  inWindow: boolean;
}

export interface SegmentDef {
  id: string;
  label: string;
  desc: string;
}

export const SEGMENTS: SegmentDef[] = [
  {
    id: "quiero_sin_click",
    label: "Mandaron QUIERO pero NO clickearon la oferta",
    desc: "Pidieron el link con la keyword y se quedaron a medio camino — el follow-up más caliente.",
  },
  {
    id: "click_oferta",
    label: "Clickearon la oferta",
    desc: "Ya vieron la página de la oferta — empujón de cierre o resolver la última duda.",
  },
  {
    id: "calientes",
    label: "Leads calientes 🔥",
    desc: "La IA los etiquetó con intención clara de compra (minería de conversaciones).",
  },
  {
    id: "tibios",
    label: "Leads tibios 🌤️",
    desc: "Interesados con dudas sin resolver — mensaje que ataque su objeción.",
  },
  {
    id: "objecion_precio",
    label: "Objeción: precio 💰",
    desc: "No compraron por precio — mensaje del plan mensual o del valor de los bonos.",
  },
  {
    id: "objecion_tiempo",
    label: "Objeción: tiempo ⏰",
    desc: "Dijeron “luego lo veo” — recordatorio del deadline del replay.",
  },
  {
    id: "todos",
    label: "Todos los que han escrito",
    desc: "Cualquier conversación con al menos un mensaje del cliente.",
  },
];

const WINDOW_MS = 24 * 3600_000;
// Margen: no mandamos free-form si la ventana cierra en <1h (riesgo de rebote).
const WINDOW_SAFE_MS = 23 * 3600_000;

const MEMBER_SELECT = `
  SELECT c.id AS conversationId, c.channel AS channel, c.channel_user_id AS channelUserId,
         c.display_name AS name, MAX(m.created_at) AS lastUserAt
  FROM conversations c
  JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'`;

function whereFor(segmentId: string): { joins: string; where: string } {
  switch (segmentId) {
    case "quiero_sin_click":
      return {
        joins: "",
        where: `WHERE c.id IN (SELECT conversation_id FROM keyword_hits WHERE keyword = 'QUIERO')
          AND c.id NOT IN (SELECT conversation_id FROM tracked_links WHERE target = 'oferta' AND clicks > 0)`,
      };
    case "click_oferta":
      return {
        joins: "",
        where: `WHERE c.id IN (SELECT conversation_id FROM tracked_links WHERE target = 'oferta' AND clicks > 0)`,
      };
    case "calientes":
      return {
        joins: "JOIN conv_labels l ON l.conversation_id = c.id",
        where: "WHERE l.interest = 'caliente'",
      };
    case "tibios":
      return {
        joins: "JOIN conv_labels l ON l.conversation_id = c.id",
        where: "WHERE l.interest = 'tibio'",
      };
    case "objecion_precio":
      return {
        joins: "JOIN conv_labels l ON l.conversation_id = c.id",
        where: "WHERE l.objection = 'precio'",
      };
    case "objecion_tiempo":
      return {
        joins: "JOIN conv_labels l ON l.conversation_id = c.id",
        where: "WHERE l.objection = 'tiempo'",
      };
    case "todos":
      return { joins: "", where: "" };
    default:
      throw new Error(`segmento desconocido: ${segmentId}`);
  }
}

/** Miembros de un segmento, cada uno con su estado de ventana de 24h. */
export async function segmentMembers(
  db: Db,
  segmentId: string,
  now = Date.now(),
): Promise<SegmentMember[]> {
  const { joins, where } = whereFor(segmentId);
  const rows = await db.all<Omit<SegmentMember, "inWindow">>(
    `${MEMBER_SELECT}
     ${joins}
     ${where}
     GROUP BY c.id
     ORDER BY lastUserAt DESC`,
  );
  return rows.map((r) => ({
    ...r,
    // Las campañas usan el margen de 23 h (WINDOW_SAFE_MS), no las 24 h exactas.
    inWindow: serviceWindowFrom(r.lastUserAt, now, WINDOW_SAFE_MS).open,
  }));
}

export interface ServiceWindow {
  /** true si todavía se puede mandar texto libre. */
  open: boolean;
  /** Último mensaje del cliente, o null si nunca escribió. */
  lastUserAt: number | null;
  /** Momento en que cierra la ventana (lastUserAt + windowMs). */
  closesAt: number | null;
}

/**
 * Ventana de servicio a partir del último mensaje del cliente.
 * `windowMs` por defecto es las 24 h de Meta. Las campañas pasan
 * WINDOW_SAFE_MS (23 h) para no rozar el cierre.
 */
export function serviceWindowFrom(
  lastUserAt: number | null | undefined,
  now = Date.now(),
  windowMs = WINDOW_MS,
): ServiceWindow {
  if (lastUserAt == null || !Number.isFinite(Number(lastUserAt))) {
    return { open: false, lastUserAt: null, closesAt: null };
  }
  const last = Number(lastUserAt);
  const closesAt = last + windowMs;
  return { open: now < closesAt, lastUserAt: last, closesAt };
}

/** Etiqueta corta para la lista: "✍ 5 h", "✍ 40 min" o "🔒". */
export function windowHoursLabel(lastUserAt: number | null | undefined, now = Date.now()): string {
  const win = serviceWindowFrom(lastUserAt, now);
  if (!win.open || win.closesAt == null) return "🔒";
  const ms = win.closesAt - now;
  if (ms < 3_600_000) {
    const min = Math.max(1, Math.ceil(ms / 60_000));
    return `✍ ${min} min`;
  }
  return `✍ ${Math.floor(ms / 3_600_000)} h`;
}

/**
 * Ventana de 24 h de una conversación, medida desde su último mensaje
 * con role=user. La misma regla que usa el inbox del panel.
 */
export async function windowFor(db: Db, conversationId: string, now = Date.now()): Promise<ServiceWindow> {
  const row = await db.first<{ lastUserAt: number | null }>(
    `SELECT MAX(created_at) AS lastUserAt
     FROM messages
     WHERE conversation_id = ? AND role = 'user'`,
    [conversationId],
  );
  return serviceWindowFrom(row?.lastUserAt ?? null, now);
}

export interface SegmentCount {
  id: string;
  label: string;
  desc: string;
  total: number;
  inWindow: number;
  outWindow: number;
}

/** Conteos de todos los segmentos (para pintar la página de campañas). */
export async function segmentCounts(db: Db, now = Date.now()): Promise<SegmentCount[]> {
  const out: SegmentCount[] = [];
  for (const seg of SEGMENTS) {
    const members = await segmentMembers(db, seg.id, now);
    const inW = members.filter((m) => m.inWindow).length;
    out.push({
      id: seg.id,
      label: seg.label,
      desc: seg.desc,
      total: members.length,
      inWindow: inW,
      outWindow: members.length - inW,
    });
  }
  return out;
}

export { WINDOW_MS, WINDOW_SAFE_MS };
