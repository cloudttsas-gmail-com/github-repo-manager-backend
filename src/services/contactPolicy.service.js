import mongoose from 'mongoose';
import CampaignRecipient from '../models/CampaignRecipient.js';
import CollectionAction from '../models/CollectionAction.js';

/**
 * When and how often a project may contact its buyers: the limits of Ley 2300 de 2023 (to be
 * confirmed by legal). Weekdays 7:00-19:00, Saturdays 8:00-15:00, never Sundays or holidays, and
 * one collection message a week per channel. A project can narrow the hours, never widen them.
 */
export const LEGAL_CONTACT_POLICY = {
  weekdayStart: 7,
  weekdayEnd: 19,
  saturdayStart: 8,
  saturdayEnd: 15,
  weeklyLimit: 1,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Bogotá has no daylight saving time
const BOGOTA_OFFSET_MS = -5 * HOUR_MS;

const hour = (value, fallback) => (Number.isInteger(value) && value >= 0 && value <= 24 ? value : fallback);

/** The project's hours inside the legal ones; anything saved outside them is cut to the limit. */
export const resolveContactPolicy = (policy = {}) => {
  const p = policy || {};
  const law = LEGAL_CONTACT_POLICY;
  const resolved = {
    weekdayStart: Math.max(hour(p.weekdayStart, law.weekdayStart), law.weekdayStart),
    weekdayEnd: Math.min(hour(p.weekdayEnd, law.weekdayEnd), law.weekdayEnd),
    saturdayStart: Math.max(hour(p.saturdayStart, law.saturdayStart), law.saturdayStart),
    saturdayEnd: Math.min(hour(p.saturdayEnd, law.saturdayEnd), law.saturdayEnd),
    weeklyLimit: law.weeklyLimit,
  };
  if (resolved.weekdayEnd <= resolved.weekdayStart) Object.assign(resolved, { weekdayStart: law.weekdayStart, weekdayEnd: law.weekdayEnd });
  if (resolved.saturdayEnd < resolved.saturdayStart) Object.assign(resolved, { saturdayStart: law.saturdayStart, saturdayEnd: law.saturdayEnd });
  return resolved;
};

/** Checks a policy sent by the panel; throws a message for the first wrong field. */
export const validateContactPolicy = (input = {}, current = {}) => {
  const law = LEGAL_CONTACT_POLICY;
  const out = {};
  for (const [field, min, max, days] of [
    ['weekdayStart', law.weekdayStart, law.weekdayEnd, 'de lunes a viernes'],
    ['weekdayEnd', law.weekdayStart, law.weekdayEnd, 'de lunes a viernes'],
    ['saturdayStart', law.saturdayStart, law.saturdayEnd, 'los sábados'],
    ['saturdayEnd', law.saturdayStart, law.saturdayEnd, 'los sábados'],
  ]) {
    if (input[field] === undefined) continue;
    const value = Number(input[field]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`La Ley 2300 de 2023 solo permite escribir entre las ${min}:00 y las ${max}:00 ${days}.`);
    out[field] = value;
  }
  if (['allowSundays', 'allowHolidays'].some((field) => input[field] === true || input[field] === 'true')) {
    throw new Error('La Ley 2300 de 2023 no permite escribir los domingos ni los festivos.');
  }
  if (input.weeklyLimit !== undefined && Number(input.weeklyLimit) !== law.weeklyLimit) {
    throw new Error('La Ley 2300 de 2023 permite un solo mensaje de cobranza por semana.');
  }
  const merged = { ...resolveContactPolicy(current), ...out };
  if (merged.weekdayEnd <= merged.weekdayStart) throw new Error('El horario de lunes a viernes debe terminar después de empezar.');
  if (merged.saturdayEnd < merged.saturdayStart) throw new Error('El horario del sábado debe terminar después de empezar.');
  return out;
};

// ---------------------------------------------------------------- calendar (Bogotá)

/** { y, m (0-11), d, weekday (0 = Sunday), hour, minute } of an instant in Bogotá. */
const bogotaParts = (date) => {
  const local = new Date(date.getTime() + BOGOTA_OFFSET_MS);
  return {
    y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate(),
    weekday: local.getUTCDay(), hour: local.getUTCHours(), minute: local.getUTCMinutes(),
  };
};

/** The instant of a Bogotá wall-clock time. */
const bogotaInstant = (y, m, d, h = 0) => new Date(Date.UTC(y, m, d, h) - BOGOTA_OFFSET_MS);

const key = (y, m, d) => `${y}-${m}-${d}`;
const utcDate = (y, m, d) => new Date(Date.UTC(y, m, d));
const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);
// Ley Emiliani: the holiday moves to the next Monday
const nextMonday = (date) => addDays(date, (8 - date.getUTCDay()) % 7);

/** Easter Sunday (anonymous Gregorian algorithm). */
const easter = (y) => {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(y, month, day);
};

const holidayCache = new Map();

/** Colombian public holidays of a year, as keys y-m-d (Ley 51 de 1983). */
export const colombianHolidays = (y) => {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const fixed = [[0, 1], [4, 1], [6, 20], [7, 7], [11, 8], [11, 25]].map(([m, d]) => utcDate(y, m, d));
  const moved = [[0, 6], [2, 19], [5, 29], [7, 15], [9, 12], [10, 1], [10, 11]].map(([m, d]) => nextMonday(utcDate(y, m, d)));
  const e = easter(y);
  const religious = [addDays(e, -3), addDays(e, -2), addDays(e, 43), addDays(e, 64), addDays(e, 71)];
  const set = new Set([...fixed, ...moved, ...religious].map((date) => key(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())));
  holidayCache.set(y, set);
  return set;
};

const isHolidayParts = ({ y, m, d }) => colombianHolidays(y).has(key(y, m, d));

/** Allowed [start, end) hours of a Bogotá day, or null when no contact is allowed that day. */
const hoursOfDay = (parts, policy) => {
  if (isHolidayParts(parts) || parts.weekday === 0) return null;
  if (parts.weekday === 6) return policy.saturdayEnd > policy.saturdayStart ? [policy.saturdayStart, policy.saturdayEnd] : null;
  return [policy.weekdayStart, policy.weekdayEnd];
};

/** Whether `now` falls inside the hours the policy allows. */
export const isWithinContactHours = (now, policy) => {
  const parts = bogotaParts(now);
  const hours = hoursOfDay(parts, policy);
  return !!hours && parts.hour >= hours[0] && parts.hour < hours[1];
};

/** `now` if contact is allowed then, otherwise the start of the next allowed window. */
export const nextContactWindow = (now, policy) => {
  if (isWithinContactHours(now, policy)) return now;
  const today = bogotaParts(now);
  for (let ahead = 0; ahead < 21; ahead += 1) {
    const day = bogotaParts(bogotaInstant(today.y, today.m, today.d + ahead, 12));
    const hours = hoursOfDay(day, policy);
    if (!hours) continue;
    const start = bogotaInstant(day.y, day.m, day.d, hours[0]);
    if (start > now) return start;
  }
  return null;
};

/** Monday 00:00 (Bogotá) of the week `now` falls in. */
export const startOfBogotaWeek = (now = new Date()) => {
  const parts = bogotaParts(now);
  const back = (parts.weekday + 6) % 7;
  return bogotaInstant(parts.y, parts.m, parts.d - back);
};

/**
 * WhatsApp collection contacts of each client this week: messages of sends that went out and
 * collection actions recorded by WhatsApp. Returns a Map clientId → count.
 */
export const weeklyWhatsAppContacts = async ({ tenantId, companyId, clientIds, excludeCampaignId }, now = new Date()) => {
  const since = startOfBogotaWeek(now);
  const ids = clientIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  const scope = { tenantId: new mongoose.Types.ObjectId(String(tenantId)), companyId: new mongoose.Types.ObjectId(String(companyId)), clientId: { $in: ids } };
  const [sent, actions] = await Promise.all([
    CampaignRecipient.aggregate([
      { $match: { ...scope, sentAt: { $gte: since }, ...(excludeCampaignId ? { campaignId: { $ne: new mongoose.Types.ObjectId(String(excludeCampaignId)) } } : {}) } },
      { $group: { _id: '$clientId', count: { $sum: 1 } } },
    ]),
    CollectionAction.aggregate([
      { $match: { ...scope, channel: 'whatsapp', createdAt: { $gte: since } } },
      { $group: { _id: '$clientId', count: { $sum: 1 } } },
    ]),
  ]);
  const counts = new Map();
  [...sent, ...actions].forEach((row) => counts.set(String(row._id), (counts.get(String(row._id)) || 0) + row.count));
  return counts;
};
