/**
 * Friendly channel names for the dashboard + detection of which channels are
 * actually configured (env credentials present). Kept separate from shared.ts
 * so dashboard concerns don't touch the adapter contract.
 */
import type { Env } from "../env";

/** channel id (as stored in conversations.channel) → label the owner reads. */
export const CHANNEL_LABELS: Record<string, string> = {
  twilio: "WhatsApp",
  whatsapp: "WhatsApp", // legacy rows
  telegram: "Telegram",
  instagram: "Instagram",
  messenger: "Messenger",
  manychat: "ManyChat",
  web: "Web",
};

export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return "—";
  return CHANNEL_LABELS[channel] ?? channel;
}

export interface ConfiguredChannel {
  id: string;
  label: string;
  detail: string;
}

/** Channels with credentials configured — shown in Mi Agente even at 0 traffic. */
export function configuredChannels(env: Env): ConfiguredChannel[] {
  const out: ConfiguredChannel[] = [];
  if (env.TWILIO_ACCOUNT_SID) {
    out.push({ id: "twilio", label: "WhatsApp", detail: "Twilio" });
  }
  if (env.TELEGRAM_BOT_TOKEN) {
    out.push({ id: "telegram", label: "Telegram", detail: "bot oficial" });
  }
  if (env.INSTAGRAM_ACCESS_TOKEN) {
    out.push({ id: "instagram", label: "Instagram", detail: "Meta oficial" });
  }
  if (env.META_PAGE_ACCESS_TOKEN) {
    out.push({ id: "messenger", label: "Messenger", detail: "Meta oficial" });
  }
  if (env.MANYCHAT_API_KEY) {
    out.push({ id: "manychat", label: "ManyChat", detail: "IG/FB vía ManyChat" });
  }
  return out;
}
