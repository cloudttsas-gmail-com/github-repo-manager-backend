/**
 * Meta's price per delivered template message in Colombia, in USD, by category. Used only for the
 * estimate a send shows before it goes out. Source: Meta's WhatsApp pricing page; check it before
 * relying on these figures (updated by hand).
 */
export const WHATSAPP_RATES_USD = {
  MARKETING: 0.0125,
  UTILITY: 0.0008,
  AUTHENTICATION: 0.0008,
};
export const WHATSAPP_RATES_CHECKED_AT = '2026-11-15';

export const estimateCostUsd = (category, count) => Math.round((WHATSAPP_RATES_USD[category] || 0) * count * 10000) / 10000;
