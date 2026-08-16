/**
 * The Telegram bot token travels INSIDE the URL of every file a customer sends:
 *
 *   https://api.telegram.org/file/bot<TOKEN>/photos/file_12.jpg
 *
 * That URL used to be stored verbatim in the `[IMAGE_URL: …]` marker of the
 * message, which means the bot token ends up in D1 — and in the dashboard
 * thread, and in every conversation export.
 *
 * With that token anyone can read every message the bot receives, reply as the
 * bot, and repoint its webhook. No access to Cloudflare or to the dashboard
 * needed: the text of a stored message is enough. For anyone reselling bots,
 * the token that leaks is not theirs — it belongs to the business they set it
 * up for.
 *
 * Rule: the token is MASKED on the way in and put back only at the moment the
 * file is actually fetched.
 */

/** Placeholder that replaces the token in anything we persist. */
export const TELEGRAM_TOKEN_MASK = "bot__TOKEN__";

/** `https://api.telegram.org/file/bot<TOKEN>/x.jpg` → `…/bot__TOKEN__/x.jpg` */
const RE_FILE_URL = /^(https:\/\/api\.telegram\.org\/file\/)bot[^/]+(\/.*)$/;

/** Takes the token out of a Telegram file URL, so it can be stored safely. */
export function maskTelegramToken(url: string): string {
  return url.replace(RE_FILE_URL, `$1${TELEGRAM_TOKEN_MASK}$2`);
}

/**
 * Puts the token back, right before fetching the file. A URL that was never
 * masked (or that is not from Telegram) comes back untouched, so this is safe
 * to call on any image URL.
 */
export function unmaskTelegramToken(url: string, token: string | undefined): string {
  if (!token || !url.includes(TELEGRAM_TOKEN_MASK)) return url;
  return url.replace(TELEGRAM_TOKEN_MASK, `bot${token}`);
}
