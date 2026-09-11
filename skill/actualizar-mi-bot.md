---
name: actualizar-mi-bot
description: Actualiza tu instalación de Forja a la última versión sin romper el bot ni perder la configuración del usuario (carpeta member/, secrets de Cloudflare, datos en D1). Se activa con "/actualizar-mi-bot", "actualizar bot", "actualizar mi chatbot", "update forja".
---

# Actualizar mi bot

Eres el asistente de actualización. Tu trabajo: traer al miembro a la última versión del template **sin romper su bot ni perder su data**.

La persona con la que hablas probablemente NO sabe programar. Habla claro, en español, sin tecnicismos sin traducir. Tú corres los comandos; ella solo confirma.

## Qué se conserva y qué se sobrescribe

Esto es la regla de oro de las actualizaciones. Memorízala:

| Carpeta / archivo | Qué pasa al actualizar |
|---|---|
| `member/` (config, prompt, base de conocimiento) | **SE CONSERVA SIEMPRE.** Nunca la toques. |
| `src/` (el cerebro del bot) | **Se sobrescribe** con la versión nueva del template. |
| Secrets de Cloudflare (`wrangler secret`) | **No se tocan.** Viven en Cloudflare, no en el repo. |
| Datos en D1 (conversaciones, leads) | **No se borran.** Solo se aplican migraciones de esquema si las hay. |
| `.bot-state.json`, `.dev.vars` | Locales y gitignored. **No se tocan.** |

Si en algún momento dudas: **member/ es sagrado, src/ se actualiza.**

## Sobre las actualizaciones

No hay validación de nivel por API ni chequeos externos. Las actualizaciones vienen del
repo público de Forja (`upstream`) y **conservan siempre tu `member/`**.

No corras ningún `curl` a servicios externos para "chequear nivel": Forja es open source,
las mejoras del Starter llegan por `git`. (Los giros y comandos de Forja+ viven aparte, en
la comunidad — no se actualizan por aquí.)

## Paso 0 — Pre-flight (chequeos antes de tocar nada)

1. Verifica que estás parado en la carpeta del bot del miembro:
   ```bash
   ls package.json wrangler.toml member/
   ```
   Si falla: dile "no veo un bot configurado en esta carpeta. Corre `/configurar-mi-chatbot` primero, o muévete a la carpeta donde instalaste tu bot."

2. Lee `.bot-state.json` si existe (te dice qué canales tiene configurados, su slug, etc.). Si no existe, no pasa nada — puedes seguir, solo no asumas configuración previa.

3. Lee la versión instalada actual:
   ```bash
   cat .bot-version 2>/dev/null || node -e "console.log(require('./package.json').version)"
   ```
   Guarda ese valor como **VERSIÓN_ACTUAL** (ej. `0.1.0`).

## Paso 1 — Configurar el remote de Forja (solo la primera vez)

Las actualizaciones vienen del repo oficial de Forja, que añadimos como un remote llamado `upstream`.

```bash
git remote -v
```

- Si **ya aparece `upstream`** → perfecto, continúa.
- Si **NO aparece `upstream`** → agrégalo apuntando al repo oficial:
  ```bash
  git remote add upstream https://github.com/santmun/forja.git
  ```

> Nota: si el usuario clonó directo el repo oficial (su `origin` ya apunta a `santmun/forja`), puede usar `origin` en lugar de `upstream` en todos los pasos siguientes.

## Paso 2 — Traer la última versión y comparar

```bash
git fetch upstream main
```

Lee la versión que viene en el template nuevo:
```bash
git show upstream/main:package.json | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).version))"
```
Guárdala como **VERSIÓN_NUEVA**.

- Si **VERSIÓN_NUEVA === VERSIÓN_ACTUAL** y `git log HEAD..upstream/main --oneline` no muestra commits nuevos:
  → dile al miembro "**Ya estás al día** (versión X). No hay nada que actualizar." y termina.
- Si hay versión nueva o commits nuevos → continúa.

## Paso 3 — Mostrar el changelog (qué cambió)

Antes de tocar nada, enséñale qué va a cambiar:

```bash
git log --oneline --no-merges HEAD..upstream/main
```

Resúmelo en lenguaje humano y **muéstraselo ANTES de tocar nada**. Deja clarísimas dos cosas: (1) exactamente QUÉ se va a actualizar, y (2) QUÉ de su bot actual NO se toca. Usa este formato:
```
Tu bot pasaría de la versión 0.1.0 → 0.3.0

QUÉ SE ACTUALIZA (el "motor" del bot):
+ Nuevo: <una línea humana por cada commit "feat">
* Mejora: <perf / refactor>
* Arreglo: <fix>

QUÉ NO SE TOCA de tu bot actual (queda igual):
- Tu configuración, tono y datos del negocio (member/)
- Tu base de conocimiento
- Tus conversaciones y leads guardados (D1)
- Tus secrets y los canales que ya tienes conectados
- Tu bot sigue en línea; si algo fallara, lo regreso solo a como estaba (hay respaldo).
```

Deriva los bullets de "QUÉ SE ACTUALIZA" del `git log` REAL — no inventes. Traduce cada commit a lenguaje de negocio (feat→Nuevo, fix→Arreglo, perf/refactor→Mejora) y omite lo interno que no le importa (tests, lint, CI, chores).

Pregunta textual: **"¿Aplico esta actualización?"** No sigas sin un sí explícito.

## Paso 4 — Detectar cambios manuales en src/

Si el miembro (o tú, en un soporte anterior) editó archivos del template directamente:

```bash
git status --porcelain src/
```

- Si **está limpio** → continúa sin avisar.
- Si **hay cambios** → lista los archivos y avisa:
  > "Detecté que estos archivos del cerebro del bot fueron modificados a mano: [lista]. Al actualizar se sobrescriben con la versión oficial. Tu carpeta `member/` NO se toca. ¿Hago un respaldo de esos cambios y continúo, o cancelamos?"

  Si dice continuar, respáldalos primero:
  ```bash
  git stash push -u -m "backup-pre-update-$(date +%Y%m%d-%H%M%S)" -- src/
  ```
  Avísale que el respaldo quedó guardado en `git stash` por si lo necesita.

## Paso 5 — Aplicar la actualización (preservando member/)

La estrategia: traer `upstream/main`, aceptar lo nuevo en `src/` y el resto, pero **siempre conservar el `member/` del miembro**.

```bash
# 1) Asegura que member/ no se pierda: marca la carpeta como "siempre mía"
git merge upstream/main --no-edit -X theirs
```

Si el merge marca conflictos en `member/`, **resuélvelos siempre a favor del miembro** (la versión local):
```bash
git checkout --ours -- member/
git add member/
git commit --no-edit
```

> Si prefieres el camino más simple y el miembro NO ha tocado `src/`:
> ```bash
> git pull upstream main --no-edit -X theirs
> ```
> Igual: ante cualquier conflicto en `member/`, gana la versión local (`--ours`).

Verifica que `member/` siga intacto comparándola contra antes del merge (debe estar sin cambios respecto a lo que el miembro tenía).

## Paso 6 — Reinstalar dependencias si cambiaron

Solo si cambió `package.json` o `pnpm-lock.yaml`:
```bash
git diff HEAD@{1} HEAD --name-only | grep -E "package.json|pnpm-lock.yaml" && pnpm install
```
Si no cambiaron, te puedes saltar este paso. Si dudas, corre `pnpm install` de todos modos — es seguro.

## Paso 7 — Aplicar migraciones de base de datos (si las hay)

Si la versión nueva trae cambios en el esquema de la base (`src/db/schema.sql` cambió):
```bash
git diff HEAD@{1} HEAD --name-only | grep "src/db/schema.sql" && pnpm db:apply:remote
```
Esto **agrega** columnas/tablas nuevas. No borra los datos existentes (conversaciones, leads).
Si el esquema trae el `UPDATE` de `open_ticket_id`, también libera conversaciones
cuyo ticket ya se resolvió o ya no existe — sin eso el follow-up las saltaba para siempre.

## Paso 8 — Publicar y sincronizar la base de conocimiento

Esto deja el bot en la última versión **y** mantiene su base de conocimiento
(`member/kb/`) sincronizada con la memoria del bot (Vectorize). Hazlo **siempre**,
sin importar si el cambio fue del miembro (editó su KB) o mío (versión nueva): así
"un solo comando" cubre todo.

**8.1 — Regenera la base de conocimiento (fixtures) desde `member/kb/`:**
```bash
pnpm kb:reindex
```
Reconstruye el manifiesto de la KB que el deploy va a embarcar. (Si `member/kb/` está
vacío, no pasa nada: indexará 0 documentos.)

**8.2 — Asegura el token del reindex (`KB_REINDEX_TOKEN`).** El endpoint de reindex
está protegido por este secret. Como los secrets de Cloudflare **no se pueden leer de
vuelta**, manéjalo así (auto-cura si nunca se creó en el setup):
```bash
# Reusa el token guardado localmente si existe; si no, genera uno y guárdalo en los dos lados.
if ! grep -q '^KB_REINDEX_TOKEN=' .dev.vars 2>/dev/null; then
  TOKEN=$(openssl rand -hex 24)
  printf '\nKB_REINDEX_TOKEN=%s\n' "$TOKEN" >> .dev.vars
  printf '%s' "$TOKEN" | wrangler secret put KB_REINDEX_TOKEN
fi
```
(Guardarlo en `.dev.vars` —local y gitignored— hace que las próximas actualizaciones
reutilicen el mismo token sin rotarlo.)

**8.3 — Publica:**
```bash
pnpm run deploy
```
El deploy embarca los fixtures nuevos (8.1) y el secret (8.2). El `predeploy` escribe
`.bot-version` solo; no lo toques a mano.

**8.4 — Reindexa en Vectorize** (usa el `worker_url` de `.bot-state.json` y el token de `.dev.vars`):
```bash
WORKER_URL=$(node -e "console.log(require('./.bot-state.json').worker_url)" 2>/dev/null)
TOKEN=$(grep '^KB_REINDEX_TOKEN=' .dev.vars | cut -d= -f2-)
curl -s -X POST "$WORKER_URL/kb/reindex" -H "X-Reindex-Token: $TOKEN"
```
Debe responder `{"ok":true,"indexed":N}`. Si responde `401`, el token del curl no
coincide con el secret: borra la línea `KB_REINDEX_TOKEN` de `.dev.vars`, repite 8.2
(genera uno nuevo) y vuelve a 8.3.

## Paso 9 — Verificar que todo quedó bien

Lee `DASHBOARD_BASE_URL` de `wrangler.toml` (o el slug en `.bot-state.json`) y pega `/health`:
```bash
curl -s https://horizontes-bot-<SLUG>.workers.dev/health
```
Debe responder algo como `{"ok":true}` / `ok`.

- Si responde OK → muéstrale el resumen de cambios del Paso 3 y dile **"Listo, tu bot está actualizado a la versión X. Tu configuración y datos siguen intactos."**
- Si **NO** responde OK → ve a "Si algo falla".

## Si algo falla (rollback)

Si el deploy falla o `/health` no responde:

1. Regresa el código a como estaba antes del merge:
   ```bash
   git reset --hard HEAD@{1}
   ```
   (`HEAD@{1}` es el estado justo antes del último merge/pull.)

2. Vuelve a publicar la versión que funcionaba:
   ```bash
   pnpm run deploy
   ```

3. Si el miembro tenía cambios respaldados con `git stash`, recupéralos:
   ```bash
   git stash list
   git stash pop   # si hay un backup-pre-update
   ```

4. Explícale en lenguaje claro qué pasó y mándalo a `skill/references/troubleshooting.md` para el error específico.

Nunca dejes al miembro con un bot caído. Si no puedes resolverlo, déjalo en la última versión que sí funcionaba.

## Resumen final que le muestras al miembro

```
Antes:  v0.1.0
Ahora:  v0.3.0   ✅

Qué cambió:
+ Nuevo: consulta de catálogo
* Mejora: detección de idioma
* Arreglo: buffer con audios

Lo que NO se tocó:
- Tu configuración (member/)
- Tus conversaciones y leads (D1)
- Tus secrets de Cloudflare

Sí se actualizó (sin que perdieras nada):
- Tu base de conocimiento quedó reindexada en la memoria del bot ✅
```
