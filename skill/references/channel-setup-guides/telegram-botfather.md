# Conectar tu bot a Telegram (BotFather)

Esta guía te lleva paso a paso para que tu chatbot funcione dentro de Telegram.
Está escrita para que la sigas aunque nunca hayas programado. Cada paso te dice
exactamente qué tocar y qué copiar.

Telegram es **gratis** y es el canal más rápido de conectar (5-10 minutos). Por
eso lo recomendamos para empezar y para probar tu bot.

> Antes de empezar necesitas tener **la app de Telegram instalada** en tu
> teléfono o computadora, con tu cuenta iniciada.

---

## Resumen de lo que vas a hacer

1. Crear tu bot con **@BotFather** y obtener el **token**.
2. Guardar ese token como secret `TELEGRAM_BOT_TOKEN`.
3. Conectar tu bot al Worker (el "webhook").
4. Obtener tu **chat ID** para recibir los avisos cuando un cliente quiera
   hablar contigo (handoff).

Al final tu bot responderá solo a tus clientes dentro de Telegram.

---

## Paso 1 — Crear tu bot con BotFather

**BotFather** es el bot oficial de Telegram que sirve para crear otros bots.

1. Abre Telegram y, en el buscador de arriba, escribe **`BotFather`**.
2. Entra al que tiene **la palomita azul** (verificado). El nombre es
   `@BotFather`.
3. Toca **Iniciar / Start** (o escribe `/start`).
4. Escribe el comando **`/newbot`** y mándalo.
5. BotFather te va a pedir **dos cosas**:
   - **Nombre del bot**: el nombre visible (ej. *Asistente de Tacos El Güero*).
     Puede llevar espacios y acentos.
   - **Username del bot**: un nombre único que **debe terminar en `bot`**
     (ej. `tacoselguero_bot`). Si te dice que ya existe, prueba otro.
6. Cuando termines, BotFather te manda un mensaje con tu **token**. Se ve así:

   ```
   123456789:AAH-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

   > **Este token es la contraseña de tu bot. NO lo compartas con nadie ni lo
   > pegues en chats públicos.** Si alguien lo tiene, puede controlar tu bot.

7. Copia ese token completo (desde el primer número hasta el final).

---

## Paso 2 — Guardar el token como secret

El token se guarda como un "secret" para que tu Worker pueda usarlo de forma
segura. Abre tu terminal **dentro de la carpeta de tu bot** y corre:

```bash
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
```

Cuando te pregunte el valor, **pega el token** que te dio BotFather y presiona
Enter. (No se va a ver en pantalla mientras lo pegas; es normal por seguridad.)

> El nombre del secret tiene que ser **exactamente** `TELEGRAM_BOT_TOKEN`,
> en mayúsculas.

---

## Paso 3 — Publicar el bot y conectar el webhook

El "webhook" es el puente que le dice a Telegram: *"cuando alguien me escriba,
manda el mensaje a mi Worker"*. Son dos pasos: publicar y después registrarlo
en Telegram **una sola vez**.

1. Publica tu bot con:

   ```bash
   pnpm run deploy
   ```

2. Registra el webhook en Telegram. Esto **no es automático**: hay que decirle
   a Telegram a dónde mandar los mensajes, y se hace una única vez por bot
   (Telegram lo recuerda). Corre este comando con tu token y tu URL:

   ```bash
   curl -X POST "https://api.telegram.org/bot<TU_TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://TU-WORKER.workers.dev/webhooks/telegram"}'
   ```

   Debe contestar `{"ok":true,...}`. La dirección es la de tu Worker (la misma
   de la variable `DASHBOARD_BASE_URL` de tu `wrangler.toml`) con la ruta
   `/webhooks/telegram` al final.

   Para comprobar que quedó:

   ```bash
   curl "https://api.telegram.org/bot<TU_TELEGRAM_BOT_TOKEN>/getWebhookInfo"
   ```

3. **Pruébalo**: abre tu bot en Telegram (búscalo por el username que elegiste,
   ej. `@tacoselguero_bot`), toca **Start** y mándale un mensaje. Si te
   contesta, ya quedó conectado.

> **¿No responde?** Revisa el archivo
> `skill/references/troubleshooting.md`. Lo más común es que el token esté mal
> copiado o que falte volver a correr `pnpm run deploy`.

---

## Paso 4 — Obtener tu chat ID (para los avisos de handoff)

Cuando un cliente pida hablar con una persona, tu bot te avisa **por Telegram a
ti**. Para eso necesita saber tu "chat ID" (tu identificador personal dentro de
Telegram). Es muy fácil:

1. Abre **tu propio bot** en Telegram (el que acabas de crear).
2. Mándale el comando **`/start`**.
3. Tu bot guarda tu chat ID y lo muestra en tu **panel de control
   (dashboard)**. Entra al dashboard y copia el número que aparece como
   *"Tu chat ID de Telegram"* (es un número largo, ej. `987654321`).
4. Guárdalo como secret:

   ```bash
   pnpm exec wrangler secret put OWNER_TELEGRAM_CHAT_ID
   ```

   Pega el número y presiona Enter.

5. Vuelve a publicar para aplicar el cambio:

   ```bash
   pnpm run deploy
   ```

A partir de aquí, cada vez que un cliente quiera hablar contigo, recibirás un
**mensaje privado en Telegram** con el resumen de la conversación.

> El aviso por Telegram es el método **por defecto y gratis**. Si además quieres
> recibirlo por **correo**, mira la sección opcional más abajo.

---

## (Opcional) Recibir los avisos también por correo

Si prefieres que el handoff te llegue también a tu email:

```bash
pnpm exec wrangler secret put RESEND_API_KEY
pnpm exec wrangler secret put OWNER_EMAIL
pnpm run deploy
```

- `RESEND_API_KEY`: la llave de tu cuenta en [resend.com](https://resend.com)
  (tienen plan gratis).
- `OWNER_EMAIL`: el correo donde quieres recibir los avisos.

---

## (Opcional, Pro) Recibir los avisos por WhatsApp con Twilio

Esto es para dueños que quieren WhatsApp "nativo" (no ManyChat) **y** recibir
los avisos de handoff por WhatsApp. Requiere una cuenta de Twilio con WhatsApp
Business aprobado.

> **Importante:** WhatsApp **no permite** que tu bot te mande texto libre fuera
> de la ventana de 24 horas. Por eso el aviso de handoff usa una **plantilla
> aprobada** (Content Template). Tienes que crear y registrar esa plantilla en
> Twilio antes de que funcione.

1. Entra a tu consola de [Twilio](https://www.twilio.com/console) y consigue:
   - **Account SID** y **Auth Token** (en la página principal de la consola).
   - Tu número de WhatsApp de Twilio (formato `whatsapp:+1415...`).
2. Crea una **Content Template** (plantilla de contenido) para el aviso de
   handoff y mándala a aprobación de WhatsApp. Cuando la aprueben, copia su
   **Content SID** (empieza con `HX...`).
3. Guarda todos los secrets:

   ```bash
   pnpm exec wrangler secret put TWILIO_ACCOUNT_SID
   pnpm exec wrangler secret put TWILIO_AUTH_TOKEN
   pnpm exec wrangler secret put TWILIO_WA_FROM
   pnpm exec wrangler secret put TWILIO_HANDOFF_CONTENT_SID
   pnpm exec wrangler secret put OWNER_WA_NUMBER
   pnpm run deploy
   ```

   - `TWILIO_WA_FROM`: el número de WhatsApp **de Twilio** (el que envía).
   - `TWILIO_HANDOFF_CONTENT_SID`: el SID `HX...` de tu plantilla **aprobada**.
   - `OWNER_WA_NUMBER`: tu número de WhatsApp (el que recibe los avisos),
     formato `whatsapp:+52...`.

> Si la plantilla **no está aprobada**, el aviso por WhatsApp no se enviará.
> Mientras tanto, seguirás recibiendo el handoff por Telegram (Paso 4).

---

## Tabla rápida de secrets

| Para qué sirve | Secret | De dónde sale |
|---|---|---|
| Conectar tu bot a Telegram | `TELEGRAM_BOT_TOKEN` | @BotFather (Paso 1) |
| Avisos de handoff a ti (default, gratis) | `OWNER_TELEGRAM_CHAT_ID` | Tu dashboard tras mandar `/start` (Paso 4) |
| Avisos por correo (opcional) | `RESEND_API_KEY`, `OWNER_EMAIL` | resend.com |
| WhatsApp nativo (opcional, Pro) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WA_FROM` | Consola de Twilio |
| Plantilla aprobada para handoff WA | `TWILIO_HANDOFF_CONTENT_SID`, `OWNER_WA_NUMBER` | Twilio (Content Template aprobada) |

> El secret `MANYCHAT_API_KEY` es para conectar WhatsApp por **ManyChat** (otro
> canal). Esa configuración está en su propia guía dentro de
> `channel-setup-guides/`. Para Telegram **no lo necesitas**.

---

## Checklist final

- [ ] Creé el bot con @BotFather y copié el token.
- [ ] Guardé `TELEGRAM_BOT_TOKEN` con `wrangler secret put`.
- [ ] Corrí `pnpm run deploy`.
- [ ] Registré el webhook con `setWebhook` y me contestó `{"ok":true}`.
- [ ] Le mandé un mensaje a mi bot y me respondió.
- [ ] Mandé `/start`, copié mi chat ID del dashboard y guardé
      `OWNER_TELEGRAM_CHAT_ID`.
- [ ] Volví a correr `pnpm run deploy` y recibí un aviso de prueba al pedir
      "hablar con un humano".

Si todos están marcados, tu bot ya vive en Telegram. 🎉
