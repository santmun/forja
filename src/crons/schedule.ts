/**
 * Which scheduled tick is allowed to run the nightly maintenance jobs (purge,
 * insights, flywheel, owner report).
 *
 * The scheduled handler needs to tell the nightly tick apart from any extra,
 * more frequent trigger a member adds, so the heavy jobs don't run on every
 * tick. That check used to be a bare string literal against "0 3 * * *".
 *
 * The trap: the literal is the ONLY thing that identifies the nightly tick, and
 * nothing ties it to wrangler.toml. A member who *edits* their cron rather than
 * adding a second one — say to `0 * * * *`, so follow-ups run hourly — makes the
 * comparison fail on every tick. Purge, insights, flywheel and the daily owner
 * report just stop, with no error and nothing in the logs. Even a stray double
 * space inside the expression is enough.
 *
 * So: one exported constant, whitespace-tolerant matching, and a log line when a
 * tick is skipped. `test/crons/schedule.test.ts` reads wrangler.toml and fails
 * if the two ever drift apart.
 */

/** Nightly maintenance window. MUST match [triggers] crons in wrangler.toml. */
export const DAILY_CRON = "0 3 * * *";

/** Collapse runs of whitespace so "0  3 * * *" still matches "0 3 * * *". */
function normalize(cron: string): string {
  return cron.trim().replace(/\s+/g, " ");
}

/**
 * True when this tick should run the nightly jobs.
 *
 * An undefined cron (a manual/test invocation of the scheduled handler) counts
 * as the nightly tick — that matches the previous behaviour.
 */
export function isNightlyTick(cron: string | undefined): boolean {
  if (!cron) return true;
  return normalize(cron) === DAILY_CRON;
}
