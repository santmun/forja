# Conectar tu bot a ManyChat (External Request)

ManyChat es un puente. Tú conectas ManyChat a Instagram, Messenger, WhatsApp o Telegram (todo se hace del lado de ManyChat), y ManyChat le pasa cada mensaje a tu bot. Esto te deja **atender varios canales con un solo bot**.

> Si solo quieres Telegram y nada más, es más fácil conectarlo directo (ver la guía `telegram-direct.md`). ManyChat conviene cuando quieres Instagram/Messenger o varios canales juntos.

---

## Lo que vas a lograr

Al terminar esta guía, cuando un cliente te escriba por Instagram (o Messenger, WhatsApp, Telegram conectado en ManyChat), tu bot va a contestarle solo, en ese mismo canal.

---

## Cómo funciona (en simple)

1. El cliente escribe en Instagram/Messenger/etc.
2. ManyChat recibe el mensaje.
3. ManyChat se lo manda a tu bot (a la URL de tu Worker).
4. Tu bot piensa la respuesta y se la regresa a ManyChat.
5. ManyChat le contesta al cliente en su canal.

---

## Paso 1: Consigue tu llave de ManyChat (API Key)

1. Entra a tu cuenta de **ManyChat** (manychat.com).
2. Ve a **Settings** (Configuración) → **API**.
3. Copia tu **API Key**. Es la llave que conecta ManyChat con tu bot.
4. Guárdala como secreto. En tu compu, dentro de la carpeta del proyecto, corre:
   ```bash
   pnpm wrangler secret put MANYCHAT_API_KEY
   ```
   Cuando te lo pida, pega la API Key y dale Enter.

> Esta misma llave la vas a usar más abajo como un encabezado (`X-Api-Key`) para que tu bot confirme que el mensaje viene de TU ManyChat y no de un desconocido. Para que tu bot **de verdad la revise**, hay que guardarla también como `MANYCHAT_WEBHOOK_SECRET` — ese paso viene en el Paso 3.

---

## Paso 2: Conecta tus canales dentro de ManyChat

Esto se hace **del lado de ManyChat**, no en tu bot:

1. En ManyChat, conecta el canal que quieras: **Instagram**, **Messenger**, **WhatsApp** o **Telegram**.
2. ManyChat te guía con su propio asistente para enlazar cada cuenta.
3. Puedes conectar varios canales a la vez. Tu bot atiende todos por el mismo puente.

---

## Paso 3: Crea el flujo que llama a tu bot (External Request)

Aquí le dices a ManyChat: "cuando llegue un mensaje, pregúntale a mi bot qué responder".

1. En ManyChat, ve a **Automation → Flows** (Automatización → Flujos).
2. Agrega una acción → **"External Request"** (Petición externa).
3. Configura así:
   - **Método (Method):** `POST`
   - **URL:** `<worker-url>/webhooks/manychat`
     (la URL de tu Worker la ves cuando corres `pnpm run deploy`, algo como `https://horizontes-bot.TU-CUENTA.workers.dev`)
4. En el **Body** (cuerpo), pega este JSON:
   ```json
   {
     "subscriber_id": "{{user_id}}",
     "text": "{{last_input_text}}",
     "first_name": "{{first_name}}"
   }
   ```
   > Los `{{...}}` son etiquetas de ManyChat: las rellena solas con el ID del cliente, su mensaje y su nombre.
5. Agrega un **header** (encabezado):
   - Nombre: `X-Api-Key`
   - Valor: tu `MANYCHAT_API_KEY` (la misma llave del Paso 1)
6. **Ya que guardaste el flujo con el header**, dile a tu bot que empiece a exigirlo:
   ```bash
   pnpm wrangler secret put MANYCHAT_WEBHOOK_SECRET
   ```
   Pega **el mismo valor** que pusiste en el header y dale Enter. Desde ahí, tu bot
   contesta `401` a cualquier petición que no traiga esa llave.

   > ⚠️ **En este orden.** Si guardas el secreto ANTES de agregar el header en
   > ManyChat, tu bot empieza a rechazar los mensajes de tus propios clientes.
   > Mientras `MANYCHAT_WEBHOOK_SECRET` no exista, el bot acepta todo — igual que
   > siempre — así que no se te cae nada por dejarlo para el final.

---

## Paso 4: Muestra la respuesta del bot al cliente

Tu bot le regresa a ManyChat un campo llamado `reply` con el texto de la respuesta. Hay que enseñárselo al cliente:

1. Justo después del "External Request", agrega una acción **"Send Message"** (Enviar mensaje).
2. En el texto del mensaje, mete el campo de respuesta que devolvió tu bot: **`reply`**.
3. Guarda el flujo.

Listo: ahora el cliente recibe la respuesta de tu bot en el canal donde escribió.

---

## El aviso al dueño (handoff) NO pasa por ManyChat

Cuando el bot necesita pasarte un cliente a ti (handoff), **no** te avisa por ManyChat. El aviso te llega por:

- **Telegram a ti (recomendado, gratis):** escríbele `/start` a tu propio bot de Telegram para obtener tu chat_id y guárdalo:
  ```bash
  pnpm wrangler secret put OWNER_TELEGRAM_CHAT_ID
  ```
  (Los pasos completos para sacar tu chat_id están en `telegram-direct.md`.)
- **WhatsApp por Twilio (opcional, Pro):** WhatsApp **no deja** mandar texto libre, así que el aviso al dueño por WhatsApp **requiere una plantilla aprobada** (Content Template). Necesitas el `TWILIO_HANDOFF_CONTENT_SID` y el `OWNER_WA_NUMBER`. Ver `whatsapp-twilio.md`.

> Importante: que conectes WhatsApp dentro de ManyChat para hablar con tus clientes es una cosa; el aviso de handoff hacia TI es otra. El handoff sale por Telegram (o por Twilio con plantilla aprobada), no por ManyChat.

---

## Si algo falla

- **El bot no contesta en el canal:** revisa que la URL del External Request termine en `/webhooks/manychat` y que el método sea `POST`.
- **Error de autorización / el bot responde `401`:** el valor del header `X-Api-Key` en ManyChat y el de `MANYCHAT_WEBHOOK_SECRET` tienen que ser **idénticos**. Vuelve a guardar el secreto (`pnpm wrangler secret put MANYCHAT_WEBHOOK_SECRET`) copiando y pegando el mismo texto, y corre `pnpm run deploy`.
- **El cliente no ve la respuesta:** asegúrate de que mapeaste el campo `reply` en la acción "Send Message".
- **No llega ningún mensaje a tu bot:** revisa que el canal (Instagram/Messenger/etc.) esté bien conectado en ManyChat y que el flujo esté activo (publicado).

---

## Resumen

| Qué | Valor |
|---|---|
| Secreto | `MANYCHAT_API_KEY` (y `OWNER_TELEGRAM_CHAT_ID` o `TWILIO_HANDOFF_CONTENT_SID` + `OWNER_WA_NUMBER` para los avisos al dueño) |
| Webhook | `<worker-url>/webhooks/manychat` (método `POST`) |
| Header | `X-Api-Key: <MANYCHAT_API_KEY>` (guarda ese mismo valor como `MANYCHAT_WEBHOOK_SECRET` para que el bot lo exija) |
| Campo de respuesta | `reply` (mapéalo a "Send Message") |
| Canales | Instagram, Messenger, WhatsApp, Telegram (conectados en ManyChat) |
| Costo | Plan de ManyChat (tiene capa gratis limitada) |
| Dificultad | Media |

Listo. Con ManyChat tu bot atiende varios canales desde un solo lugar.
