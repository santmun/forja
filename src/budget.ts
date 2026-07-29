/**
 * Monthly AI budget guard.
 *
 * The owner can set `monthly_budget` (USD) from the Costos tab. When the
 * month-to-date AI spend reaches it, the agent downgrades to the "fast" tier
 * (cheap model) instead of going silent — the bot keeps answering, it just
 * stops burning money on the smart model.
 *
 * A downgrade alone doesn't cap spend — "fast" still costs money, and a burst
 * of traffic between two spend checks can blow past the budget anyway. Once
 * spend reaches HARD_STOP_MULTIPLIER × the budget, enforceBudgetGuard() pauses
 * the bot globally (the same bot_paused switch the owner uses from the panel)
 * and notifies the owner — reusing notifyOwner(), the same best-effort
 * Telegram/WhatsApp/email channel the watchdog and handoff tool already use.
 */
import { Db } from "./db/client";
import { costOfUsage, type ModelId } from "./pricing";
import type { Tier } from "./upgrade/modelSelector";
import type { Env } from "./env";
import { SettingsRepo, SETTING_KEYS } from "./db/settings";
import { notifyOwner } from "./tools/handoffHuman";

/** UTC start of the current month (injectable clock for tests). */
export function monthStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Exact month-to-date AI cost, computed from per-message token usage. */
export async function monthIaCostUsd(db: Db, now = Date.now()): Promise<number> {
  const rows = await db.all<{ model_used: string; input: number; output: number; cached: number }>(
    `SELECT model_used,
            SUM(COALESCE(input_tokens, 0)) as input,
            SUM(COALESCE(output_tokens, 0)) as output,
            SUM(COALESCE(cached_input_tokens, 0)) as cached
     FROM messages
     WHERE created_at >= ? AND model_used IS NOT NULL
     GROUP BY model_used`,
    [monthStartMs(now)],
  );
  let total = 0;
  for (const r of rows) {
    total += costOfUsage(r.model_used as ModelId, {
      input: r.input,
      output: r.output,
      cached: r.cached,
    });
  }
  return total;
}

/** Pure decision: downgrade to "fast" once spend reaches the budget. */
export function applyBudgetGuard(
  tier: Tier,
  monthCostUsd: number,
  budgetUsd: number | undefined,
): { tier: Tier; downgraded: boolean } {
  if (budgetUsd === undefined || budgetUsd <= 0) return { tier, downgraded: false };
  if (monthCostUsd >= budgetUsd && tier !== "fast") {
    return { tier: "fast", downgraded: true };
  }
  return { tier, downgraded: false };
}

/** Hard-stop threshold: spend at 1.5x the monthly budget pauses the bot. */
export const HARD_STOP_MULTIPLIER = 1.5;

export interface BudgetGuardResult {
  tier: Tier;
  downgraded: boolean;
  /** true only the turn that actually flips bot_paused (already-paused → false). */
  paused: boolean;
}

/**
 * Downgrades the tier (applyBudgetGuard) and, once spend reaches
 * HARD_STOP_MULTIPLIER × the budget, pauses the bot for good measure — sets
 * the same `bot_paused` setting the owner's dashboard toggle uses, so every
 * conversation goes silent until the owner reactivates it manually. Idempotent:
 * if the bot is already paused, does not re-notify on every message.
 */
export async function enforceBudgetGuard(
  env: Env,
  db: Db,
  tier: Tier,
  monthCostUsd: number,
  budgetUsd: number | undefined,
): Promise<BudgetGuardResult> {
  const guard = applyBudgetGuard(tier, monthCostUsd, budgetUsd);
  if (budgetUsd === undefined || budgetUsd <= 0 || monthCostUsd < budgetUsd * HARD_STOP_MULTIPLIER) {
    return { ...guard, paused: false };
  }

  const settings = new SettingsRepo(db);
  if ((await settings.get(SETTING_KEYS.botPaused)) === "1") {
    return { ...guard, paused: false }; // ya pausado — no volver a notificar
  }

  await settings.set(SETTING_KEYS.botPaused, "1");
  await notifyOwner(env, {
    reason: "presupuesto de IA excedido",
    summary:
      `🚨 El bot se pausó solo: el gasto de IA de este mes ($${monthCostUsd.toFixed(2)}) ` +
      `superó 1.5x tu presupuesto ($${budgetUsd}). Reactívalo desde el panel (Agente) cuando quieras.`,
    ticketId: "budget-guard",
  });
  return { ...guard, paused: true };
}
