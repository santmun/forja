import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import {
  applyWhatsAppStatuses,
  deliveriesForConversation,
  deliveryCaption,
  linkOutboundWamid,
} from "../../src/db/deliveries";
import { windowFor } from "../../src/segments";

let db: Db;
let convId: string;
let messageId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  const conv = await new ConversationsRepo(db).getOrCreate("whatsapp", "5215500001111", "Ana");
  convId = conv.id;
  messageId = await new MessagesRepo(db).append(convId, "owner", "seguimiento");
});

describe("recibos de WhatsApp", () => {
  it("liga el wamid del envío y el webhook lo sube a leído", async () => {
    await linkOutboundWamid(db, { wamid: "wamid.1", messageId, conversationId: convId, statusAt: 1000 });
    await applyWhatsAppStatuses(db, [
      { wamid: "wamid.1", status: "delivered", timestamp: 2000 },
      { wamid: "wamid.1", status: "read", timestamp: 3000 },
    ]);
    // Un sent atrasado no baja el visto.
    await applyWhatsAppStatuses(db, [{ wamid: "wamid.1", status: "sent", timestamp: 1500 }]);

    const row = await db.first<{ status: string; message_id: string }>(
      "SELECT status, message_id FROM message_deliveries WHERE wamid = ?",
      ["wamid.1"],
    );
    expect(row?.status).toBe("read");
    expect(row?.message_id).toBe(messageId);

    const map = await deliveriesForConversation(db, convId);
    expect(deliveryCaption(map.get(messageId)!).text).toBe("✓✓ Visto");
  });

  it("si el webhook llega antes del insert, el envío no pisa el fallo", async () => {
    await applyWhatsAppStatuses(db, [
      {
        wamid: "wamid.fail",
        status: "failed",
        timestamp: 5000,
        errorCode: 131047,
        errorTitle: "Re-engagement message",
      },
    ]);
    await linkOutboundWamid(db, {
      wamid: "wamid.fail",
      messageId,
      conversationId: convId,
      statusAt: 4000,
    });

    const row = await db.first<{ status: string; error_code: number; message_id: string; conversation_id: string }>(
      "SELECT status, error_code, message_id, conversation_id FROM message_deliveries WHERE wamid = ?",
      ["wamid.fail"],
    );
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe(131047);
    expect(row?.message_id).toBe(messageId);
    expect(row?.conversation_id).toBe(convId);
    expect(deliveryCaption({ status: "failed", error_code: 131047, error_title: "Re-engagement message" }).text).toBe(
      "No le llegó: fuera de la ventana de 24 h",
    );
  });

  it("windowFor usa el último mensaje del cliente", async () => {
    const msgs = new MessagesRepo(db);
    const now = Date.now();
    await msgs.append(convId, "user", "hola", { createdAt: now - 2 * 3_600_000 });
    await msgs.append(convId, "assistant", "qué tal", { createdAt: now - 60_000 });
    const win = await windowFor(db, convId, now);
    expect(win.open).toBe(true);
    expect(win.lastUserAt).toBe(now - 2 * 3_600_000);

    const stale = await windowFor(db, convId, now + 30 * 3_600_000);
    expect(stale.open).toBe(false);
  });
});
