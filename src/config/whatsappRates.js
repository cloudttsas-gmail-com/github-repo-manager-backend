/**
 * Meta's price per delivered template message in Colombia, in USD, by category, in force since
 * 1 Oct 2026. Used only for the estimate a send shows before it goes out. Source: Meta's WhatsApp
 * pricing page; check it before relying on these figures (updated by hand).
 * Since 1 Oct 2026 service messages are charged from the 1,001st of the month, and utility ones
 * inside the 24-hour window are charged too. Accounts billed in COP pay MARKETING $46.0227 and the
 * rest $2.9455.
 */
export const WHATSAPP_RATES_USD = {
  MARKETING: 0.0125,
  UTILITY: 0.0008,
  AUTHENTICATION: 0.0008,
  SERVICE: 0.0008,
};
export const WHATSAPP_RATES_CHECKED_AT = '2026-11-26';

export const estimateCostUsd = (category, count) => Math.round((WHATSAPP_RATES_USD[category] || 0) * count * 10000) / 10000;
