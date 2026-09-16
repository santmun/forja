# Migraciones D1 (bots que ya están en producción)

`src/db/schema.sql` usa `CREATE TABLE IF NOT EXISTS` y `CREATE INDEX IF NOT EXISTS`.
Un bot **nuevo** aplica el archivo completo (`pnpm db:apply:remote`) y listo.

Un bot **que ya tiene datos** no se recrea: hay que correr solo las sentencias
nuevas sobre la base remota. `CREATE INDEX IF NOT EXISTS` es seguro: no borra
filas y no falla si el índice ya existe.

## 2026-09-16 — índices por `conversation_id` en `leads` y `tickets`

El inbox (`/admin/conversations`) cuenta leads y tickets abiertos por cada
conversación visible (hasta 50). Sin estos índices D1 hace SCAN de las dos
tablas en cada refresco (~10s) y se come la cuota gratis de lecturas.

**Opción A — reaplicar el esquema (recomendado al actualizar):**

```bash
pnpm db:apply:remote
```

**Opción B — solo estos dos índices** (si no quieres reaplicar todo el schema):

```bash
pnpm wrangler d1 execute horizontes_bot_db --remote --file=src/db/migrations/001_leads_tickets_conv_indexes.sql
```

O a mano:

```sql
CREATE INDEX IF NOT EXISTS idx_leads_conv ON leads(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tickets_conv ON tickets(conversation_id);
```
