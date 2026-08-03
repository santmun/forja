import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import {
  calcomConfigured,
  calcomTimeZone,
  createBooking,
  getAvailableSlots,
  resolveEventTypeId,
  todayInTz,
} from "../integrations/calcom";

// El eventTypeId y la zona horaria se resuelven SIEMPRE en el servidor
// (CALCOM_EVENT_TYPE_ID / CALCOM_EVENT_TYPES / CALCOM_TIMEZONE): el modelo no
// conoce esos ids y no debe inventarlos.
export function scheduleAppointmentTool(env: Env, _getConversationId: () => string | null) {
  return tool({
    description:
      "Consulta horarios libres y agenda citas reales en el calendario del negocio (Cal.com). " +
      "Para ver horarios disponibles de un día: pasa solo `date` (YYYY-MM-DD). " +
      "Para reservar: pasa `startTime` (ISO con offset de la zona del negocio, ej. 2026-08-03T15:00:00-06:00), " +
      "`attendeeName` y `attendeeEmail` — idealmente un `startTime` que venga de los horarios consultados. " +
      "Si el negocio maneja varios tipos de cita, indica `service` con el nombre del servicio.",
    inputSchema: z.object({
      date: z.string().optional().describe("YYYY-MM-DD para consultar horarios libres de ese día"),
      startTime: z.string().optional().describe("ISO datetime con offset para reservar, ej. 2026-08-03T15:00:00-06:00"),
      attendeeName: z.string().optional(),
      attendeeEmail: z.string().email().optional(),
      service: z.string().optional().describe("nombre del servicio/tipo de cita solicitado"),
      notes: z.string().optional(),
    }),
    execute: async ({ date, startTime, attendeeName, attendeeEmail, service, notes }) => {
      if (!calcomConfigured(env)) return { error: "calcom_not_configured" as const };
      const eventTypeId = resolveEventTypeId(env, service);
      if (eventTypeId == null) return { error: "calcom_not_configured" as const };
      const timeZone = calcomTimeZone(env);

      // Guardia anti-fecha-fantasma: los LLM no saben qué día es hoy y suelen
      // proponer fechas de su época de entrenamiento. YYYY-MM-DD compara bien
      // como string.
      const today = todayInTz(timeZone);
      const requestedDay = date ?? startTime?.slice(0, 10);
      if (requestedDay && requestedDay < today) {
        return {
          error: "date_in_past" as const,
          today,
          hint: `Hoy es ${today}. Recalcula la fecha pedida por el cliente a partir de hoy y reintenta.`,
        };
      }

      // Reservar: requiere hora exacta + datos del cliente.
      if (startTime && attendeeName && attendeeEmail) {
        const r = await createBooking(env, {
          eventTypeId,
          start: startTime,
          name: attendeeName,
          email: attendeeEmail,
          timeZone,
          notes,
        });
        if (!r.ok) return { error: "calcom_failed" as const, reason: r.reason };
        return { booked: true, bookingId: r.bookingId, status: r.status, start: r.start ?? startTime };
      }

      // Consultar horarios libres de un día.
      if (date) {
        const r = await getAvailableSlots(env, eventTypeId, date, timeZone);
        if (!r.ok) return { error: "calcom_failed" as const, reason: r.reason };
        return { date, timeZone, slots: r.slots.slice(0, 12) };
      }

      return {
        error: "missing_params" as const,
        hint: "Pasa `date` para ver horarios, o `startTime` + `attendeeName` + `attendeeEmail` para reservar.",
      };
    },
  });
}
