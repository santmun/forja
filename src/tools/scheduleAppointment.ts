import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import {
  calcomConfigured,
  calcomTimeZone,
  createBooking,
  getAvailableSlots,
  resolveEventTypeId,
} from "../integrations/calcom";
import { applyResolvedDate, resolveDateInput, todayInTz } from "../time/resolveDate";

// El eventTypeId y la zona horaria se resuelven SIEMPRE en el servidor
// (CALCOM_EVENT_TYPE_ID / CALCOM_EVENT_TYPES / CALCOM_TIMEZONE): el modelo no
// conoce esos ids y no debe inventarlos.
export function scheduleAppointmentTool(env: Env, _getConversationId: () => string | null) {
  return tool({
    description:
      "Consulta horarios libres y agenda citas reales en el calendario del negocio (Cal.com). " +
      "Para ver horarios de un día: pasa `date` con lo que dijo el cliente " +
      "('el próximo martes', 'el viernes', o YYYY-MM-DD si ya dio día y mes). " +
      "NO conviertas tú un día de la semana a YYYY-MM-DD: el servidor lo resuelve. " +
      "Para reservar: pasa `startTime` (ISO con offset, ej. 2026-08-03T15:00:00-06:00), " +
      "`attendeeName` y `attendeeEmail`. Si el negocio maneja varios tipos de cita, indica `service`.",
    inputSchema: z.object({
      date: z
        .string()
        .optional()
        .describe(
          "Fecha que dijo el cliente: texto relativo ('el próximo martes', 'el viernes') " +
            "o YYYY-MM-DD solo si el cliente dio día y mes. No calcules YYYY-MM-DD a partir de un día de la semana.",
        ),
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
      const locale = (env.BOT_LANGUAGE || "es").slice(0, 2);
      const today = todayInTz(timeZone);

      // El modelo a menudo manda un YYYY-MM-DD mal contado. Si `date` trae
      // palabras ("el próximo martes"), el resolvedor gana sobre cualquier ISO.
      let resolvedDate: string | undefined;
      let resolvedWeekday: string | undefined;
      const toResolve = date || (startTime?.slice(0, 10) ?? "");
      if (toResolve) {
        const resolved = resolveDateInput(date || toResolve, { timeZone, locale });
        if (!resolved.ok) {
          return {
            error: resolved.error,
            today,
            hint: `Hoy es ${today}. Pasa la fecha con las palabras del cliente (ej. 'el próximo martes') o un YYYY-MM-DD de calendario.`,
          };
        }
        resolvedDate = resolved.date;
        resolvedWeekday = resolved.weekday;
        if (resolvedDate < today) {
          return {
            error: "date_in_past" as const,
            today,
            weekday: resolvedWeekday,
            hint: `Hoy es ${today}. Recalcula la fecha pedida por el cliente a partir de hoy y reintenta.`,
          };
        }
      }

      const bookedStart =
        startTime && resolvedDate ? applyResolvedDate(startTime, resolvedDate) : startTime;

      // Reservar: requiere hora exacta + datos del cliente.
      if (bookedStart && attendeeName && attendeeEmail) {
        const r = await createBooking(env, {
          eventTypeId,
          start: bookedStart,
          name: attendeeName,
          email: attendeeEmail,
          timeZone,
          notes,
        });
        if (!r.ok) return { error: "calcom_failed" as const, reason: r.reason };
        return {
          booked: true,
          bookingId: r.bookingId,
          status: r.status,
          start: r.start ?? bookedStart,
          date: resolvedDate,
          weekday: resolvedWeekday,
        };
      }

      // Consultar horarios libres de un día.
      if (resolvedDate) {
        const r = await getAvailableSlots(env, eventTypeId, resolvedDate, timeZone);
        if (!r.ok) return { error: "calcom_failed" as const, reason: r.reason };
        return { date: resolvedDate, weekday: resolvedWeekday, timeZone, slots: r.slots.slice(0, 12) };
      }

      return {
        error: "missing_params" as const,
        hint: "Pasa `date` para ver horarios, o `startTime` + `attendeeName` + `attendeeEmail` para reservar.",
      };
    },
  });
}
