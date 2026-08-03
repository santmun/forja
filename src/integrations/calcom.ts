import type { Env } from "../env";

// Cliente de Cal.com API v2 para los nichos de cita. Dos capacidades:
//  - getAvailableSlots: horarios reales libres de un event type en un día.
//  - createBooking: reserva una cita en el calendario del dueño.
// Cada endpoint fija su cal-api-version (Cal.com versiona por endpoint).
// Docs: https://cal.com/docs/api-reference/v2

const CALCOM_API = "https://api.cal.com/v2";
const SLOTS_VERSION = "2024-09-04";
const BOOKINGS_VERSION = "2026-02-25";

export const DEFAULT_TZ = "America/Mexico_City";

/** ¿El dueño ya conectó Cal.com? (API key + al menos un event type). */
export function calcomConfigured(env: Env): boolean {
  return Boolean(env.CALCOM_API_KEY && (env.CALCOM_EVENT_TYPE_ID || env.CALCOM_EVENT_TYPES));
}

export function calcomTimeZone(env: Env): string {
  return (env.CALCOM_TIMEZONE || "").trim() || DEFAULT_TZ;
}

/** YYYY-MM-DD de hoy en la zona dada (en-CA formatea ISO). */
export function todayInTz(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Resuelve el eventTypeId para un servicio. Si hay un mapa CALCOM_EVENT_TYPES,
 * busca por coincidencia de palabra (case-insensitive); si no, usa el default.
 */
export function resolveEventTypeId(env: Env, servicio?: string): number | null {
  const map = parseEventTypes(env.CALCOM_EVENT_TYPES);
  if (map && servicio) {
    const s = servicio.toLowerCase();
    for (const [key, id] of Object.entries(map)) {
      if (s.includes(key.toLowerCase())) return id;
    }
  }
  if (map) {
    const first = Object.values(map)[0];
    if (typeof first === "number") return first;
  }
  const def = Number(env.CALCOM_EVENT_TYPE_ID);
  return Number.isFinite(def) && def > 0 ? def : null;
}

function parseEventTypes(raw?: string): Record<string, number> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

interface Slot {
  start: string;
}

/**
 * Horarios libres de un event type para una fecha (YYYY-MM-DD, en la zona dada).
 * Devuelve los ISO `start` de los slots disponibles ese día.
 */
export async function getAvailableSlots(
  env: Env,
  eventTypeId: number,
  date: string,
  timeZone: string,
): Promise<{ ok: true; slots: string[] } | { ok: false; reason: string }> {
  if (!env.CALCOM_API_KEY) return { ok: false, reason: "not_configured" };
  // Ventana [date, date+1día) para traer solo ese día.
  const end = nextDay(date);
  const url = `${CALCOM_API}/slots?eventTypeId=${eventTypeId}&start=${date}&end=${end}&timeZone=${encodeURIComponent(timeZone)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CALCOM_API_KEY}`, "cal-api-version": SLOTS_VERSION },
    });
    if (!res.ok) {
      // Logueamos el status para soporte, NO el body (puede traer datos del cliente).
      console.warn(`[calcom] slots http_${res.status}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const body = (await res.json()) as { data?: Record<string, Slot[]> };
    const byDate = body.data ?? {};
    const slots = Object.values(byDate)
      .flat()
      .map((s) => s?.start)
      .filter((s): s is string => typeof s === "string");
    return { ok: true, slots };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

export async function createBooking(
  env: Env,
  args: {
    eventTypeId: number;
    start: string; // ISO
    name: string;
    email: string;
    timeZone: string;
    phone?: string;
    notes?: string;
  },
): Promise<
  | { ok: true; bookingId: number | string; uid?: string; status?: string; start?: string }
  | { ok: false; reason: string }
> {
  if (!env.CALCOM_API_KEY) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch(`${CALCOM_API}/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CALCOM_API_KEY}`,
        "cal-api-version": BOOKINGS_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start: args.start,
        eventTypeId: args.eventTypeId,
        attendee: {
          name: args.name,
          email: args.email,
          timeZone: args.timeZone,
          ...(args.phone ? { phoneNumber: args.phone } : {}),
        },
        ...(args.notes ? { bookingFieldsResponses: { notes: args.notes } } : {}),
      }),
    });
    if (!res.ok) {
      // Solo el status (el body del error puede traer nombre/email del cliente).
      console.warn(`[calcom] booking http_${res.status}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const body = (await res.json()) as { data?: { id: number | string; uid?: string; status?: string; start?: string } };
    const d = body.data;
    if (!d?.id) return { ok: false, reason: "no_booking_id" };
    return { ok: true, bookingId: d.id, uid: d.uid, status: d.status, start: d.start };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

/** YYYY-MM-DD del día siguiente (para la ventana de slots). */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
