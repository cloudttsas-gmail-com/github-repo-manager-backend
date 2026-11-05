/**
 * Date-only strings ("2026-11-05") come from date pickers. Parsed as is they
 * become UTC midnight, which shows as the previous day in Colombia, so they are
 * stored at noon Bogotá time instead.
 */
export const parseBusinessDate = (value, fallback = new Date()) => {
  if (!value) return fallback;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T12:00:00-05:00`);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
};
