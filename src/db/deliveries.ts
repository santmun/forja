import { Db } from "./client";

/** Código de Meta: texto libre fuera de la ventana de 24 h. */
export const WA_WINDOW_CLOSED = 131047;

const RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

export function deliveryRank(status: string): number {
  return RANK[status] ?? 0;
}

export interface DeliveryRow {
  wamid: string;
  message_id: string | null;
  conversation_id: string | null;
  status: string;
  error_code: number | null;
  error_title: string | null;
  status_at: number;
  updated_at: number;
}

export interface DeliveryUpsert {
  wamid: string;
  messageId?: string | null;
  conversationId?: string | null;
  status: string;
  errorCode?: number | null;
  errorTitle?: string | null;
  statusAt: number;
}

/**
 * Inserta o actualiza un recibo. Un estado más nuevo no pisa uno más avanzado
 * (read no vuelve a sent). failed gana sobre el resto. El message_id que
 * llega después (el envío guardó el wamid) no borra el estado que ya trajo el webhook.
 */
export async function upsertDelivery(db: Db, row: DeliveryUpsert): Promise<void> {
  const existing = await db.first<DeliveryRow>(
    "SELECT * FROM message_deliveries WHERE wamid = ?",
    [row.wamid],
  );
  const now = Date.now();
  if (!existing) {
    await db.run(
      `INSERT INTO message_deliveries (
        wamid, message_id, conversation_id, status, error_code, error_title, status_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.wamid,
        row.messageId ?? null,
        row.conversationId ?? null,
        row.status,
        row.status === "failed" ? (row.errorCode ?? null) : null,
        row.status === "failed" ? (row.errorTitle ?? null) : null,
        row.statusAt,
        now,
      ],
    );
    return;
  }

  const incoming = deliveryRank(row.status);
  const current = deliveryRank(existing.status);
  const nextStatus = incoming >= current ? row.status : existing.status;
  const nextStatusAt = incoming >= current ? row.statusAt : existing.status_at;
  let errorCode: number | null = null;
  let errorTitle: string | null = null;
  if (nextStatus === "failed") {
    if (row.status === "failed") {
      errorCode = row.errorCode ?? existing.error_code;
      errorTitle = row.errorTitle ?? existing.error_title;
    } else {
      errorCode = existing.error_code;
      errorTitle = existing.error_title;
    }
  }

  await db.run(
    `UPDATE message_deliveries SET
       message_id = COALESCE(message_id, ?),
       conversation_id = COALESCE(conversation_id, ?),
       status = ?,
       error_code = ?,
       error_title = ?,
       status_at = ?,
       updated_at = ?
     WHERE wamid = ?`,
    [
      row.messageId ?? null,
      row.conversationId ?? null,
      nextStatus,
      errorCode,
      errorTitle,
      nextStatusAt,
      now,
      row.wamid,
    ],
  );
}

export interface WhatsAppStatusUpdate {
  wamid: string;
  status: string;
  timestamp: number;
  errorCode?: number;
  errorTitle?: string;
}

/** Persiste los recibos que mandó Meta. El match es por wamid. */
export async function applyWhatsAppStatuses(db: Db, events: WhatsAppStatusUpdate[]): Promise<void> {
  for (const ev of events) {
    await upsertDelivery(db, {
      wamid: ev.wamid,
      status: ev.status,
      errorCode: ev.errorCode ?? null,
      errorTitle: ev.errorTitle ?? null,
      statusAt: ev.timestamp,
    });
  }
}

/** El panel acaba de enviar: deja el wamid ligado al mensaje, sin bajar un recibo que ya llegó. */
export async function linkOutboundWamid(
  db: Db,
  input: { wamid: string; messageId: string; conversationId: string; statusAt?: number },
): Promise<void> {
  await upsertDelivery(db, {
    wamid: input.wamid,
    messageId: input.messageId,
    conversationId: input.conversationId,
    status: "sent",
    statusAt: input.statusAt ?? Date.now(),
  });
}

/** El recibo más avanzado de cada mensaje de la conversación. */
export async function deliveriesForConversation(
  db: Db,
  conversationId: string,
): Promise<Map<string, DeliveryRow>> {
  const rows = await db.all<DeliveryRow>(
    "SELECT * FROM message_deliveries WHERE conversation_id = ?",
    [conversationId],
  );
  const map = new Map<string, DeliveryRow>();
  for (const row of rows) {
    if (!row.message_id) continue;
    const prev = map.get(row.message_id);
    if (!prev || deliveryRank(row.status) >= deliveryRank(prev.status)) map.set(row.message_id, row);
  }
  return map;
}

export function deliveryCaption(row: {
  status: string;
  error_code: number | null;
  error_title: string | null;
}): { text: string; color: string } {
  if (row.status === "failed") {
    if (row.error_code === WA_WINDOW_CLOSED) {
      return { text: "No le llegó: fuera de la ventana de 24 h", color: "var(--bad)" };
    }
    const extra = row.error_title ? `: ${row.error_title}` : "";
    return { text: `No le llegó${extra}`, color: "var(--bad)" };
  }
  if (row.status === "read") return { text: "✓✓ Visto", color: "var(--info)" };
  if (row.status === "delivered") return { text: "✓✓ Entregado", color: "var(--ok)" };
  return { text: "✓ Enviado", color: "var(--dim)" };
}
