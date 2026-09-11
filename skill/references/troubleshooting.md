# Troubleshooting — Horizontes Bot (Pro)

Guía de problemas comunes y cómo resolverlos. Está ordenada por etapa:
**Setup** (preparación e instalación), **Deploy** (subir el bot a producción),
**Runtime** (el bot ya está vivo pero algo falla) y **KB / Vectorize** (la base
de conocimiento del negocio).

Antes de buscar tu error abajo, lo más rápido casi siempre es correr el chequeo
automático, que detecta secrets faltantes, bindings sin crear y configuración
incompleta:

```bash
pnpm run deploy
```

Si algo falta, el comando te lo dice por nombre antes de intentar subir nada.

> Todos los comandos `pnpm` y `wrangler` se corren **dentro de la carpeta del
> proyecto** (donde está `package.json`). Si ves `command not found` para
> `wrangler`, usa `pnpm wrangler ...` en lugar de `wrangler ...`.

---

## Setup

| Error | Causa | Cómo arreglarlo |
|---|---|---|
| `pnpm: command not found` | pnpm no está instalado | `npm install -g pnpm` (este proyecto usa **pnpm**, no npm) |
| `wrangler: command not found` | wrangler no está en el PATH | usa `pnpm wrangler ...`, o instala global con `npm install -g wrangler` |
| `wrangler login` no abre el navegador | terminal sin entorno gráfico | corre `WRANGLER_LOG=debug pnpm wrangler login` y copia/pega el URL en tu navegador a mano |
| Dependencias no instalan / `node_modules` corrupto | instalación a medias | borra `node_modules` y corre `pnpm install` de nuevo |
| `D1 create ... already exists` | la base de datos ya existía | corre `pnpm wrangler d1 list`, copia el `database_id` real y pégalo en `wrangler.toml` (binding **DB**, `horizontes_bot_db`) |
| `Vectorize ... already exists` | el índice ya existía | corre `pnpm wrangler vectorize list` y reutiliza `horizontes_bot_kb` (no lo vuelvas a crear) |
| `pnpm typecheck` marca errores tras editar `member/config.local.ts` | falta un campo o hay una coma/llave mal | revisa que `businessConfig` tenga `hours`, `services`, `location`, `paymentMethods`, `contactPhone` y `customFields`, y que `memberConfig` esté completo |

**Crear la base de datos y el índice (primera vez):**

```bash
pnpm wrangler d1 create horizontes_bot_db
pnpm wrangler vectorize create horizontes_bot_kb --dimensions=1024 --metric=cosine
```

Después aplica el esquema de la base de datos:

```bash
pnpm db:apply           # aplica el esquema en local
pnpm db:apply:remote    # aplica el esquema en producción
```

> El índice de Vectorize usa **1024 dimensiones** porque la KB se indexa con
> embeddings BGE de Workers AI. No cambies ese número.

---

## Deploy

El comando de despliegue es `pnpm run deploy`. Antes de subir nada corre un
chequeo (deploy-check) que valida que tengas los secrets requeridos y los
bindings creados. Si falta algo, se detiene y te dice qué.

| Error | Causa | Cómo arreglarlo |
|---|---|---|
| `Authentication error` al desplegar | wrangler perdió la sesión | corre `pnpm wrangler login` otra vez |
| deploy-check: `Missing secret ANTHROPIC_API_KEY` | falta la llave de Claude (obligatoria) | `pnpm wrangler secret put ANTHROPIC_API_KEY` |
| deploy-check: `Missing secret DASHBOARD_PASSWORD` | falta la contraseña del dashboard (obligatoria en Pro) | `pnpm wrangler secret put DASHBOARD_PASSWORD` |
| deploy-check: `Missing binding DB / KB / CATALOG` | la base de datos, el índice o el bucket no existen | crea el faltante: `wrangler d1 create horizontes_bot_db`, `wrangler vectorize create horizontes_bot_kb --dimensions=1024 --metric=cosine`, o `wrangler r2 bucket create <nombre>` y verifica el binding en `wrangler.toml` |
| `binding AGENT not found` / Durable Object error | el Durable Object `SupportAgent` no está declarado | revisa el bloque `[[durable_objects.bindings]]` en `wrangler.toml` (binding **AGENT**) y la migración; corre `pnpm typecheck` |
| Despliega pero `/health` da 404 | router mal montado | revisa `src/index.ts` y corre `pnpm typecheck` antes de volver a desplegar |
| Despliega pero `/admin` da 500 | falta `ANTHROPIC_API_KEY` u otro secret en runtime | corre `pnpm wrangler secret list` y agrega el que falte con `secret put` |
| Cambios en `member/` no se reflejan tras deploy | confusión de carpetas | `member/` es tu config y se respeta siempre; lo que se redeploya es `src/`. Si tocaste la KB, además corre el reindex (sección KB) |

**Secrets disponibles** (agrégalos con `pnpm wrangler secret put NOMBRE`):

- **Obligatorios:** `ANTHROPIC_API_KEY`, `DASHBOARD_PASSWORD`
- **Canales:** `TELEGRAM_BOT_TOKEN`, `MANYCHAT_API_KEY`
- **WhatsApp (Twilio):** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WA_FROM`, `TWILIO_HANDOFF_CONTENT_SID`
- **Agenda:** `CALCOM_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`
- **Avisos al dueño:** `OWNER_TELEGRAM_CHAT_ID` (Telegram DM), `RESEND_API_KEY` + `OWNER_EMAIL` (email), `OWNER_WA_NUMBER` (WhatsApp)

> Las **variables** (no secrets) como `BOT_NAME`, `BUSINESS_NAME`,
> `BOT_LANGUAGE`, `BOT_TIER`, `BUFFER_SECONDS` y `DASHBOARD_BASE_URL` se editan
> directamente en `wrangler.toml`, no con `secret put`.

---

## Runtime (el bot ya está vivo)

### Dashboard / acceso de administrador

| Síntoma | Causa | Cómo arreglarlo |
|---|---|---|
| Al entrar al dashboard pide usuario y contraseña | es lo normal: el dashboard usa **Basic Auth** | usuario: **`admin`** (siempre), contraseña: la que pusiste en `DASHBOARD_PASSWORD` |
| `401 Unauthorized` al entrar al dashboard | la contraseña no coincide con `DASHBOARD_PASSWORD`, o el secret no está seteado | confirma que el usuario sea exactamente `admin`; vuelve a setear con `pnpm wrangler secret put DASHBOARD_PASSWORD` y redeploya con `pnpm run deploy` |
| Olvidaste la contraseña del dashboard | no se puede "recuperar", solo reemplazar | corre `pnpm wrangler secret put DASHBOARD_PASSWORD` con una nueva, luego `pnpm run deploy` |
| El navegador recuerda una contraseña vieja y da 401 | credenciales cacheadas de Basic Auth | abre en ventana privada/incógnito o limpia las credenciales guardadas del sitio |

> El dashboard **no tiene** login por email ni "magic link". No existe `/login`
> ni `/logout`. El único acceso es Basic Auth con usuario `admin`. Si una guía
> menciona magic link o Resend para iniciar sesión, está desactualizada — Resend
> aquí solo sirve para los **avisos por email al dueño**.

### Mensajes y canales

| Síntoma | Causa | Cómo arreglarlo |
|---|---|---|
| El bot no responde en Telegram | el webhook no está configurado o apunta mal | corre el `setWebhook` de la guía de Telegram apuntando a `https://<tu-worker>.workers.dev/webhooks/telegram` |
| Telegram: el webhook responde error | token mal o URL incorrecta | verifica con `getWebhookInfo`; revisa `TELEGRAM_BOT_TOKEN` y que la URL termine en `/webhooks/telegram` |
| El bot tarda mucho en responder (>10s) | el buffer de mensajes está alto | baja `BUFFER_SECONDS` en `wrangler.toml` (ej. `5`) y redeploya |
| El bot agrupa varios mensajes en una sola respuesta | comportamiento esperado del buffer | si lo quieres más reactivo baja `BUFFER_SECONDS`; si quieres que junte más, súbelo |
| El bot responde en el idioma equivocado | `BOT_LANGUAGE` mal configurado | edita `BOT_LANGUAGE` en `wrangler.toml` y redeploya |
| `streamText failed: 401` / `invalid x-api-key` | la llave de Claude es inválida o expiró | renueva en console.anthropic.com y vuelve a poner `pnpm wrangler secret put ANTHROPIC_API_KEY` |
| `AI_APICallError: Bad Request` con **body vacío** (`content-length: 0`) hacia Anthropic o Zernio | el edge/WAF corta el `fetch` del Worker (sin `User-Agent`, CR en un secret de Windows, o colo lejos de la API). Anthropic siempre responde JSON si la petición llega | 1) redeploya esta versión (manda `User-Agent` y limpia CR/LF de las llaves). 2) en Windows, vuelve a poner el secret (sin comillas, sin Enter extra). 3) opcional: `AGENT_LOCATION_HINT=wnam` en `[vars]` y **nueva** conversación (el hint solo aplica la primera vez que se crea el Durable Object). 4) opcional: `ANTHROPIC_BASE_URL` de un AI Gateway + secret `CF_AIG_TOKEN`. 5) en `/admin` → Configuración → prueba de modelo: el error ahora incluye `egress GET … origin=yes\|edge?` |
| El bot ignora notas de voz | falta transcripción o canal sin audio | la transcripción usa Whisper de Workers AI; confirma que el binding **AI** exista en `wrangler.toml` |
| El bot no "ve" imágenes | función Pro de visión no activa | la lectura de imágenes usa Haiku (solo Pro); confirma `BOT_TIER=pro` y que llegue la imagen del canal |

### Handoff / avisos al dueño

| Síntoma | Causa | Cómo arreglarlo |
|---|---|---|
| No llega el aviso cuando un cliente pide hablar con una persona | falta el canal de aviso configurado | configura al menos uno: Telegram DM (`OWNER_TELEGRAM_CHAT_ID`), email (`RESEND_API_KEY` + `OWNER_EMAIL`) o WhatsApp Pro (Twilio) |
| No sabes tu `OWNER_TELEGRAM_CHAT_ID` | nunca le diste `/start` a tu propio bot | abre tu bot en Telegram, mándale `/start`, y obtén tu `chat_id` (ej. con `getUpdates`); guárdalo con `pnpm wrangler secret put OWNER_TELEGRAM_CHAT_ID` |
| El aviso por WhatsApp no llega | falta la plantilla aprobada de Twilio | WhatsApp **solo** envía con una plantilla aprobada: setea `TWILIO_HANDOFF_CONTENT_SID` (Content Template SID) y `OWNER_WA_NUMBER`; **no** se manda texto libre |
| Twilio devuelve error al avisar por WhatsApp | credenciales o número mal | revisa `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WA_FROM` y `OWNER_WA_NUMBER` (formato internacional, ej. `+52...`) |
| El email de aviso no llega | falta o es inválida la llave de Resend | setea `RESEND_API_KEY` y `OWNER_EMAIL`; revisa spam la primera vez |
| El bot se quedó "pausado" en una conversación | alguien usó la pausa (handoff) | el bot pausa una conversación cuando entra un humano; se reactiva según la lógica de la herramienta `pauseBot` |

### Herramientas (tools) y agenda

| Síntoma | Causa | Cómo arreglarlo |
|---|---|---|
| `scheduleAppointment` no agenda | falta config de Cal.com / Google | setea `CALCOM_API_KEY` y, si usas Google, `GOOGLE_SERVICE_ACCOUNT_JSON` |
| `catalogQuery` no encuentra productos | el catálogo en R2 está vacío o el binding falta | verifica el binding **CATALOG** (R2) en `wrangler.toml` y que hayas subido el catálogo |
| `captureLead` no guarda nada | la base de datos no responde | confirma el binding **DB** y que el esquema esté aplicado (`pnpm db:apply:remote`) |

### Mantenimiento automático

| Síntoma | Causa | Cómo arreglarlo |
|---|---|---|
| Los mensajes viejos no se borran | el cron de limpieza no corre | el cron diario `0 3 * * *` purga mensajes con más de 90 días; verifica el bloque `[triggers]`/`crons` en `wrangler.toml` |

---

## KB / Vectorize (base de conocimiento del negocio)

La KB son tus archivos `member/kb/*.md`. Cuando los editas, hay que volver a
indexarlos en Vectorize para que el bot use la info nueva.

| Síntoma | Causa | Cómo arreglarlo |
|---|---|---|
| El bot no conoce info del negocio (horarios, servicios, precios) | la KB no está indexada o cambió y no se reindexó | vuelve a indexar (ver abajo) |
| El bot responde con info vieja | editaste `member/kb/*.md` pero no reindexaste | reindexa después de cada cambio en la KB |
| `Vectorize: index not found` | el índice no existe | `pnpm wrangler vectorize create horizontes_bot_kb --dimensions=1024 --metric=cosine` |
| `dimension mismatch` al indexar | el índice se creó con dimensiones distintas | borra y recrea el índice con `--dimensions=1024` (embeddings BGE) |
| La búsqueda (`searchKb`) devuelve resultados raros o vacíos | poca info o documentos muy largos | divide los `.md` en secciones claras por tema y reindexa |
| `member/config.local.ts` cambió pero el bot no lo refleja | esa config se lee en runtime, no es KB | no requiere reindex; basta redeploy con `pnpm run deploy` (no toca tu carpeta `member/`) |

**Reindexar la KB** (corre esto cada vez que edites `member/kb/*.md`):

```bash
pnpm kb:reindex
```

> Si la KB también dependía de cambios en el esquema de la base de datos, aplica
> primero `pnpm db:apply:remote` y luego `pnpm kb:reindex`.

> La carpeta `member/` (tu config y tu KB) **nunca se sobrescribe** al
> actualizar el bot. Solo `src/` se reemplaza. Si actualizas con
> `/actualizar-mi-bot` y algo de tu negocio "desaparece", revisa que tus cambios
> estén dentro de `member/` y no en `src/`.

---

## Si nada de esto funciona

1. Corre `pnpm typecheck` — atrapa errores antes de desplegar.
2. Corre `pnpm test` — confirma que la lógica base sigue sana.
3. Revisa los logs en vivo: `pnpm wrangler tail`.
4. Confirma tus secrets: `pnpm wrangler secret list`.
5. Vuelve a desplegar: `pnpm run deploy` (el deploy-check te dirá qué falta).

Si sigues atorado, copia el mensaje de error completo y el comando exacto que
corriste — eso es lo que se necesita para ayudarte rápido.
