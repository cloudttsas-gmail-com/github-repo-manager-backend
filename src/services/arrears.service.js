import Quota from '../models/Quota.js';
import { startOfBogotaDay } from './statementSummary.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days-in-arrears ranges used by Inicio, Cartera and the financial report. A contract falls
 * in the range of its oldest overdue quota (overdue from the day after its due date, in Bogotá).
 */
export const ARREARS_RANGES = {
  MORA_1_30: [1, 30],
  MORA_31_60: [31, 60],
  MORA_61_90: [61, 90],
  MORA_90_PLUS: [91, Infinity],
};

/** The range key for a number of days in arrears, or null when it is not overdue. */
export const arrearsRangeOf = (days) => {
  if (!(days >= 1)) return null;
  return Object.keys(ARREARS_RANGES).find((key) => {
    const [min, max] = ARREARS_RANGES[key];
    return days >= min && days <= max;
  });
};

/**
 * Overdue figures by contract: how many contracts and how much money fall in each range.
 * `quotaMatch` narrows the quotas (by contract ids, or by tenant and project).
 */
export const overdueByContract = async (quotaMatch, now = new Date()) => {
  const today = startOfBogotaDay(now);
  const rows = await Quota.aggregate([
    { $match: { ...quotaMatch, status: { $ne: 'pagado' }, dueDate: { $lt: today } } },
    { $addFields: { pending: { $subtract: [{ $ifNull: ['$value', 0] }, { $ifNull: ['$amountPaid', 0] }] } } },
    { $match: { pending: { $gt: 0 } } },
    { $group: { _id: '$contract', oldestDue: { $min: '$dueDate' }, amount: { $sum: '$pending' } } },
  ]);
  const ranges = Object.fromEntries(Object.keys(ARREARS_RANGES).map((key) => [key, { contracts: 0, amount: 0 }]));
  let amount = 0;
  for (const row of rows) {
    amount += row.amount;
    const days = Math.max(1, Math.ceil((today - new Date(row.oldestDue)) / DAY_MS));
    const range = ranges[arrearsRangeOf(days)];
    range.contracts += 1;
    range.amount += row.amount;
  }
  return { contracts: rows.length, amount, ranges };
};
