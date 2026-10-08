import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseWhatsAppEvents,
  parseWhatsAppStatuses,
  WhatsAppSendError,
  whatsappAdapter,
} from "../../src/channels/whatsapp";

const ORIGIN = "https://bot.example.workers.dev";
const env = { WHATSAPP_APP_SECRET: "s3cr3t" } as any;

function body(messages: any[], extra: any = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: "PHONE_ID" },
              contacts: [{ profile: { name: "María" }, wa_id: "5215512345678" }],
              messages,
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

describe("parseWhatsAppEvents", () => {
  it("parsea texto", async () => {
    const out = await parseWhatsAppEvents(
      body([{ from: "5215512345678", id: "wamid.1", type: "text", text: { body: "hola" } }]) as any,
      env,
      ORIGIN,
    );
    expect(out).toHaveLength(1);
    expect(out[0].channel).toBe("whatsapp");
    expect(out[0].channelUserId).toBe("5215512345678");
    expect(out[0].text).toBe("hola");
    expect(out[0].displayName).toBe("María");
  });

  it("parsea imagen con caption a una URL de media firmada", async () => {
    const out = await parseWhatsAppEvents(
      body([
        { from: "5215512345678", id: "wamid.2", type: "image", image: { id: "MEDIA_IMG", caption: "ese corte" } },
      ]) as any,
      env,
      ORIGIN,
    );
    expect(out[0].text).toBe("ese corte");
    expect(out[0].imageUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media/MEDIA_IMG`);
    expect(out[0].imageUrl).toMatch(/[?&]sig=/);
    expect(out[0].imageUrl).toMatch(/[?&]exp=/);
  });

  it("parsea nota de voz (type audio)", async () => {
    const out = await parseWhatsAppEvents(
      body([{ from: "5215512345678", id: "wamid.3", type: "audio", audio: { id: "MEDIA_AUD", voice: true } }]) as any,
      env,
      ORIGIN,
    );
    expect(out[0].audioUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media/MEDIA_AUD`);
    expect(out[0].text).toBeUndefined();
  });

  it("no convierte los recibos en mensajes del cliente", async () => {
    const b = {
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [{ field: "messages", value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
    };
    const out = await parseWhatsAppEvents(b as any, env, ORIGIN);
    expect(out).toHaveLength(0);
  });

  it("sin App Secret no firma media pero no truena (texto sigue)", async () => {
    const out = await parseWhatsAppEvents(
      body([{ from: "5215512345678", id: "wamid.4", type: "image", image: { id: "X" } }]) as any,
      {} as any,
      ORIGIN,
    );
    // imagen sin caption y sin URL firmable → se descarta
    expect(out).toHaveLength(0);
  });
});

describe("parseWhatsAppStatuses", () => {
  const now = 1_800_000_000_000;

  it("lee sent, delivered, read y failed con su código", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  { id: "wamid.sent", status: "sent", timestamp: "1710000000", recipient_id: "5215511111111" },
                  { id: "wamid.read", status: "read", timestamp: "1710000300", recipient_id: "5215511111111" },
                ],
              },
            },
            {
              field: "messages",
              value: {
                statuses: [
                  {
                    id: "wamid.fail",
                    status: "failed",
                    timestamp: "1710000400",
                    recipient_id: "5215522222222",
                    errors: [
                      {
                        code: 131047,
                        title: "Re-engagement message",
                        message: "Re-engagement message",
                        error_data: { details: "More than 24 hours have passed" },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const out = parseWhatsAppStatuses(body as any, now);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      wamid: "wamid.sent",
      status: "sent",
      timestamp: 1710000000 * 1000,
      recipientId: "5215511111111",
    });
    expect(out[1].status).toBe("read");
    expect(out[2]).toMatchObject({
      wamid: "wamid.fail",
      status: "failed",
      errorCode: 131047,
      errorTitle: "Re-engagement message",
    });
  });

  it("lee los recibos aunque el mismo change traiga un mensaje", async () => {
    const body = bodyFn([
      { from: "5215512345678", id: "wamid.in", type: "text", text: { body: "hola" } },
    ], {
      statuses: [{ id: "wamid.out", status: "delivered", timestamp: "1710000001", recipient_id: "5215512345678" }],
    });
    const messages = await parseWhatsAppEvents(body as any, env, ORIGIN);
    const statuses = parseWhatsAppStatuses(body as any, now);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("hola");
    expect(statuses).toEqual([
      expect.objectContaining({ wamid: "wamid.out", status: "delivered", timestamp: 1710000001 * 1000 }),
    ]);
  });

  it("ignora changes que no son de messages y statuses sin id", () => {
    const body = {
      entry: [
        {
          changes: [
            { field: "account_update", value: { statuses: [{ id: "wamid.no", status: "sent" }] } },
            { field: "messages", value: { statuses: [{ status: "sent" }, { id: "wamid.ok", status: "delivered", timestamp: "10" }] } },
          ],
        },
      ],
    };
    const out = parseWhatsAppStatuses(body as any, now);
    expect(out.map((s) => s.wamid)).toEqual(["wamid.ok"]);
  });
});

function bodyFn(messages: any[], extra: any = {}) {
  return body(messages, extra);
}

describe("whatsappAdapter.sendReply", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hace POST al endpoint de Cloud API con el formato correcto", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await whatsappAdapter.sendReply(
      { channel: "whatsapp", channelUserId: "5215512345678", chunks: ["hola"] },
      { WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID", WHATSAPP_ACCESS_TOKEN: "TOKEN" } as any,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe("https://graph.facebook.com/v21.0/PHONE_ID/messages");
    expect(init.method).toBe("POST");
    const hdrs = new Headers(init.headers);
    expect(hdrs.get("Authorization")).toBe("Bearer TOKEN");
    expect(hdrs.get("User-Agent")).toMatch(/^ForjaBot\//);
    const payload = JSON.parse(init.body);
    expect(payload.messaging_product).toBe("whatsapp");
    expect(payload.to).toBe("5215512345678");
    expect(payload.type).toBe("text");
    expect(payload.text.body).toBe("hola");
  });

  it("en modo strict lanza con el código 131047 y no traga el rechazo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 131047,
              message: "Re-engagement message",
              error_data: { details: "More than 24 hours have passed since the customer last replied" },
            },
          }),
          { status: 400 },
        ),
      ),
    );
    const err = await whatsappAdapter
      .sendReply(
        { channel: "whatsapp", channelUserId: "52155", chunks: ["seguimiento"], strict: true },
        { WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID", WHATSAPP_ACCESS_TOKEN: "TOKEN" } as any,
      )
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect(err.code).toBe(131047);
    expect(err.message).toMatch(/ventana de 24 h/);
  });

  it("sin strict un rechazo de Meta no lanza (el bot sigue el turno)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }), { status: 400 }),
      ),
    );
    await expect(
      whatsappAdapter.sendReply(
        { channel: "whatsapp", channelUserId: "52155", chunks: ["hola"] },
        { WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID", WHATSAPP_ACCESS_TOKEN: "TOKEN" } as any,
      ),
    ).resolves.toEqual({});
  });

  it("devuelve el wamid que respondió Graph", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.HBgLNTIx" }] }), { status: 200 }),
      ),
    );
    const sent = await whatsappAdapter.sendReply(
      { channel: "whatsapp", channelUserId: "52155", chunks: ["hola"], strict: true },
      { WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID", WHATSAPP_ACCESS_TOKEN: "TOKEN" } as any,
    );
    expect(sent && sent.providerMessageId).toBe("wamid.HBgLNTIx");
  });

  it("lanza si falta configuración", async () => {
    await expect(
      whatsappAdapter.sendReply({ channel: "whatsapp", channelUserId: "x", chunks: ["hi"] }, {} as any),
    ).rejects.toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
  });
});
