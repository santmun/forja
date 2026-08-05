import { describe, it, expect } from "vitest";
import {
  maskTelegramToken,
  unmaskTelegramToken,
  TELEGRAM_TOKEN_MASK,
} from "../src/telegramFiles";

// A token shaped like a real one, but obviously fake.
const TOKEN = "8123456789:AAHfakefakefakefakefakefakefake";
const REAL = `https://api.telegram.org/file/bot${TOKEN}/photos/file_12.jpg`;

describe("telegram file URLs — the bot token must not be stored", () => {
  it("takes the token out of the URL", () => {
    const masked = maskTelegramToken(REAL);
    expect(masked).not.toContain(TOKEN);
    expect(masked).toBe(
      `https://api.telegram.org/file/${TELEGRAM_TOKEN_MASK}/photos/file_12.jpg`,
    );
  });

  it("puts it back, byte for byte, to fetch the file", () => {
    expect(unmaskTelegramToken(maskTelegramToken(REAL), TOKEN)).toBe(REAL);
  });

  it("leaves other image URLs alone", () => {
    const otra = "https://example.com/una-foto.png";
    expect(maskTelegramToken(otra)).toBe(otra);
    expect(unmaskTelegramToken(otra, TOKEN)).toBe(otra);
  });

  it("does not blow up when there is no token configured", () => {
    const masked = maskTelegramToken(REAL);
    expect(unmaskTelegramToken(masked, undefined)).toBe(masked);
  });

  it("keeps the file path intact, including nested folders", () => {
    const anidada = `https://api.telegram.org/file/bot${TOKEN}/voice/a/b/c.ogg`;
    expect(unmaskTelegramToken(maskTelegramToken(anidada), TOKEN)).toBe(anidada);
  });
});
