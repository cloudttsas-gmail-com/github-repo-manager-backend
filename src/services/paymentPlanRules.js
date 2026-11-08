/**
 * Payment plan rules (pure functions, no database access).
 *
 * All dates are business dates in Bogotá (UTC-5, no daylight saving). They are
 * handled as calendar dates and returned at noon Bogotá time, like
 * parseBusinessDate, so they never show as the previous day.
 */
import AppError from '../utils/AppError.js';
import { roundMoney } from '../utils/math.js';
import { parseBusinessDate } from '../utils/dates.js';

// Contracts sold under these rules; older contracts are never recalculated automatically
export const PLAN_RULES_VERSION = 'v2';

export const INITIAL_QUOTA_MODES = ['free', 'fixed'];

export const DEFAULT_PAYMENT_PLAN_POLICY = Object.freeze({
  initialDeadlineDays: 30,
  allowedPaymentDays: [5, 15, 20, 30],
  minDaysBeforeFirstOrdinary: 30,
  allowEarlyStart: false,
  initialQuotaMode: 'free',
  allowInitialModeOverride: false,
  maxOrdinaryQuotas: null,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

// ---------- Calendar helpers ----------

/** Calendar date ({ y, m (0-11), d }) of a value in Bogotá. */
export const toCalendarDate = (value) => {
  const date = value instanceof Date ? value : parseBusinessDate(value, null);
  if (!date || Number.isNaN(date.getTime())) throw new AppError('Fecha inválida', 400);
  const shifted = new Date(date.getTime() - BOGOTA_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
};

/** Date at noon Bogotá for a calendar date (month and day may overflow; they are normalized). */
export const fromCalendarDate = ({ y, m, d }) => new Date(Date.UTC(y, m, d, 17, 0, 0));

const dayNumber = ({ y, m, d }) => Date.UTC(y, m, d) / DAY_MS;
const normalize = (cal) => toCalendarDate(fromCalendarDate(cal));
export const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export const addDays = (cal, days) => normalize({ ...cal, d: cal.d + days });

/** The chosen day in a given month, or the month's last day if it does not exist (30 in February). */
export const dayInMonth = (y, m, day) => {
  const first = normalize({ y, m, d: 1 });
  return { y: first.y, m: first.m, d: Math.min(day, lastDayOfMonth(first.y, first.m)) };
};

/** Same day N months later, clamped to the last day of a shorter month. */
export const addMonthsClamped = (cal, months, day = cal.d) => dayInMonth(cal.y, cal.m + months, day);

export const compareCalendar = (a, b) => dayNumber(a) - dayNumber(b);
export const toISODate = ({ y, m, d }) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// ---------- Policy ----------

/** Company policy merged with the defaults. */
export const resolvePaymentPlanPolicy = (stored) => {
  const source = stored && typeof stored.toObject === 'function' ? stored.toObject() : (stored || {});
  const policy = { ...DEFAULT_PAYMENT_PLAN_POLICY };
  Object.keys(DEFAULT_PAYMENT_PLAN_POLICY).forEach((key) => {
    if (source[key] !== undefined && source[key] !== null) policy[key] = source[key];
  });
  if (!Array.isArray(policy.allowedPaymentDays) || policy.allowedPaymentDays.length === 0) {
    policy.allowedPaymentDays = [...DEFAULT_PAYMENT_PLAN_POLICY.allowedPaymentDays];
  }
  policy.allowedPaymentDays = [...policy.allowedPaymentDays].map(Number).sort((a, b) => a - b);
  return policy;
};

const intInRange = (value, min, max, message) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError(message, 400);
  return n;
};

/** Validates a policy sent from Configuración and returns it clean (only known fields). */
export const validatePaymentPlanPolicy = (input = {}) => {
  if (Array.isArray(input.allowedPaymentDays) && input.allowedPaymentDays.length === 0) {
    throw new AppError('Debe haber al menos un día de pago permitido', 400);
  }
  const current = resolvePaymentPlanPolicy(input);
  const policy = {};
  policy.initialDeadlineDays = intInRange(current.initialDeadlineDays, 1, 365,
    'El plazo de la cuota inicial debe ser un número de días entre 1 y 365');
  if (!Array.isArray(input.allowedPaymentDays ?? current.allowedPaymentDays)) {
    throw new AppError('Los días de pago permitidos deben ser una lista', 400);
  }
  const days = [...new Set(current.allowedPaymentDays.map((d) => intInRange(d, 1, 31,
    'Cada día de pago permitido debe estar entre 1 y 31')))].sort((a, b) => a - b);
  if (days.length === 0) throw new AppError('Debe haber al menos un día de pago permitido', 400);
  policy.allowedPaymentDays = days;
  policy.minDaysBeforeFirstOrdinary = intInRange(current.minDaysBeforeFirstOrdinary, 1, 365,
    'Los días mínimos antes de la primera cuota ordinaria deben estar entre 1 y 365');
  policy.allowEarlyStart = current.allowEarlyStart === true || current.allowEarlyStart === 'true';
  if (!INITIAL_QUOTA_MODES.includes(current.initialQuotaMode)) {
    throw new AppError('El modo de la cuota inicial debe ser abonos libres o cuotas fijas', 400);
  }
  policy.initialQuotaMode = current.initialQuotaMode;
  policy.allowInitialModeOverride = current.allowInitialModeOverride === true || current.allowInitialModeOverride === 'true';
  policy.maxOrdinaryQuotas = current.maxOrdinaryQuotas === '' || current.maxOrdinaryQuotas === null
    ? null
    : intInRange(current.maxOrdinaryQuotas, 1, 600, 'El número máximo de cuotas ordinarias debe estar entre 1 y 600');
  return policy;
};

// ---------- Schedule rules ----------

/**
 * First ordinary quota: the first chosen payment day at least `minDays` after the
 * end of the initial quota or, with early start, the first chosen day strictly
 * after it. It never falls in the month of the sale.
 */
export const firstOrdinaryDate = ({ initialEnd, saleDate, paymentDay, minDays, earlyStart }) => {
  const end = toCalendarDate(initialEnd);
  const sale = toCalendarDate(saleDate);
  let threshold = earlyStart ? addDays(end, 1) : addDays(end, Math.max(1, minDays));
  const monthAfterSale = normalize({ y: sale.y, m: sale.m + 1, d: 1 });
  if (compareCalendar(threshold, monthAfterSale) < 0) threshold = monthAfterSale;

  const candidate = dayInMonth(threshold.y, threshold.m, paymentDay);
  if (compareCalendar(candidate, threshold) >= 0) return candidate;
  return dayInMonth(threshold.y, threshold.m + 1, paymentDay);
};

/** Monthly due dates on the chosen day, from the first ordinary quota. */
export const ordinaryDueDates = ({ first, paymentDay, count }) => {
  const start = toCalendarDate(first);
  return Array.from({ length: count }, (_, i) => dayInMonth(start.y, start.m + i, paymentDay));
};

/**
 * Due dates of the initial quota(s). Free mode: one quota due at the deadline.
 * Fixed mode: N monthly quotas from the sale; the last one is capped at the deadline.
 */
export const initialDueDates = ({ saleDate, deadlineDays, mode, count }) => {
  const sale = toCalendarDate(saleDate);
  const deadline = addDays(sale, deadlineDays);
  if (mode !== 'fixed' || count <= 1) return [deadline];

  const dates = [];
  for (let i = 1; i <= count; i++) {
    const monthly = addMonthsClamped(sale, i);
    dates.push(compareCalendar(monthly, deadline) > 0 ? deadline : monthly);
  }
  // Every quota but the last must fall strictly before the deadline
  if (compareCalendar(dates[count - 2], deadline) >= 0) {
    throw new AppError(`Con un plazo de ${deadlineDays} días no caben ${count} cuotas iniciales mensuales. Reduce el número de cuotas o registra una ampliación del plazo.`, 400);
  }
  return dates;
};

const splitEvenly = (total, count) => {
  // Same rounding as the original sale code: rounded quotas, the last one takes the rest
  const base = roundMoney(total / count);
  const values = [];
  let sum = 0;
  for (let i = 1; i <= count; i++) {
    const value = i === count ? roundMoney(total - sum) : base;
    sum += value;
    values.push(value);
  }
  return values;
};

/**
 * Builds the plan of a sale under the project policy. Throws AppError(400) when the
 * request breaks the policy. Returns plain quota specs (no ids) and the dates used.
 */
export const buildSalePlan = ({
  saleDate,
  totalValue,
  initialQuotaPercentage = 0,
  separationAmount = 0,
  installmentsCount = 0,
  paymentDay,
  policy: rawPolicy,
  initialQuotaMode,
  initialQuotasCount = 1,
  earlyStart = false,
  maxInstallments = 24,
}) => {
  const policy = resolvePaymentPlanPolicy(rawPolicy);
  const day = paymentDay === undefined || paymentDay === null || paymentDay === ''
    ? policy.allowedPaymentDays[0]
    : Number(paymentDay);
  if (!policy.allowedPaymentDays.includes(day)) {
    throw new AppError(`El día de pago debe ser uno de los permitidos por el proyecto: ${policy.allowedPaymentDays.join(', ')}`, 400);
  }

  const wantsEarlyStart = earlyStart === true || earlyStart === 'true';
  if (wantsEarlyStart && !policy.allowEarlyStart) {
    throw new AppError('Este proyecto no permite empezar las cuotas ordinarias antes del plazo mínimo', 400);
  }

  const mode = initialQuotaMode || policy.initialQuotaMode;
  if (!INITIAL_QUOTA_MODES.includes(mode)) {
    throw new AppError('El modo de la cuota inicial debe ser abonos libres o cuotas fijas', 400);
  }
  if (mode !== policy.initialQuotaMode && !policy.allowInitialModeOverride) {
    throw new AppError('Este proyecto no permite cambiar el modo de la cuota inicial en la venta', 400);
  }

  const count = parseInt(installmentsCount, 10) || 0;
  const lotMax = maxInstallments !== undefined && maxInstallments !== null ? Number(maxInstallments) : 24;
  const maxAllowed = policy.maxOrdinaryQuotas ? Math.min(lotMax, policy.maxOrdinaryQuotas) : lotMax;
  if (count > maxAllowed) {
    throw new AppError(`El número máximo de cuotas permitido es ${maxAllowed}. No se puede seleccionar ${count} cuotas.`, 400);
  }

  const total = Number(totalValue) || 0;
  const rawInitialAmountTotal = roundMoney(total * ((Number(initialQuotaPercentage) || 0) / 100));
  const separation = parseFloat(separationAmount) || 0;
  if (separation < 0) throw new AppError('La separación no puede ser negativa', 400);
  if (separation > rawInitialAmountTotal) {
    throw new AppError('La separación no puede ser mayor que la cuota inicial', 400);
  }
  const initialAmount = Math.max(0, rawInitialAmountTotal - separation);
  const residualAmount = roundMoney(total - rawInitialAmountTotal);
  if (residualAmount > 0 && count <= 0) {
    throw new AppError('Indica el número de cuotas ordinarias para el saldo después de la cuota inicial', 400);
  }
  const installmentValue = count > 0 ? roundMoney(residualAmount / count) : 0;

  const sale = toCalendarDate(saleDate);
  const fixedCount = mode === 'fixed' ? Math.max(1, parseInt(initialQuotasCount, 10) || 1) : 1;

  const quotas = [];
  if (separation > 0) {
    quotas.push({ number: 0, type: 'inicial', value: separation, dueDate: fromCalendarDate(sale), status: 'pagado', amountPaid: separation, paymentDate: fromCalendarDate(sale) });
  }

  let initialEnd = sale;
  let initialDeadline = null;
  if (initialAmount > 0) {
    const dates = initialDueDates({ saleDate: fromCalendarDate(sale), deadlineDays: policy.initialDeadlineDays, mode, count: fixedCount });
    const values = splitEvenly(initialAmount, dates.length);
    dates.forEach((date, i) => {
      if (values[i] > 0) quotas.push({ number: i + 1, type: 'inicial', value: values[i], dueDate: fromCalendarDate(date), status: 'pendiente' });
    });
    initialEnd = dates[dates.length - 1];
    initialDeadline = initialEnd;
  }

  const first = firstOrdinaryDate({
    initialEnd: fromCalendarDate(initialEnd),
    saleDate: fromCalendarDate(sale),
    paymentDay: day,
    minDays: policy.minDaysBeforeFirstOrdinary,
    earlyStart: wantsEarlyStart,
  });
  const ordinaryValues = count > 0 ? splitEvenly(residualAmount, count) : [];
  ordinaryDueDates({ first: fromCalendarDate(first), paymentDay: day, count }).forEach((date, i) => {
    if (ordinaryValues[i] > 0) quotas.push({ number: i + 1, type: 'normal', value: ordinaryValues[i], dueDate: fromCalendarDate(date), status: 'pendiente' });
  });

  // The plan must add up to the sale value: no money can be lost or invented
  const planTotal = roundMoney(quotas.reduce((sum, q) => sum + q.value, 0));
  if (Math.abs(planTotal - roundMoney(total)) > 1) {
    throw new AppError('El plan de pagos no suma el valor de la venta. Revisa la cuota inicial, la separación y las cuotas', 400);
  }

  return {
    paymentDay: day,
    initialQuotaMode: mode,
    initialQuotasCount: mode === 'fixed' ? fixedCount : 1,
    earlyStart: wantsEarlyStart,
    initialAmount,
    separationAmount: separation,
    residualAmount,
    installmentValue,
    installmentsCount: count,
    maxInstallments: maxAllowed,
    initialDeadline: initialDeadline ? fromCalendarDate(initialDeadline) : null,
    firstOrdinaryDate: count > 0 ? fromCalendarDate(first) : null,
    quotas,
    policy: {
      initialDeadlineDays: policy.initialDeadlineDays,
      minDaysBeforeFirstOrdinary: policy.minDaysBeforeFirstOrdinary,
      allowEarlyStart: policy.allowEarlyStart,
      allowedPaymentDays: policy.allowedPaymentDays,
    },
  };
};

/**
 * New due dates for the unpaid ordinary quotas once the initial quota is fully
 * paid (decision b). The end of the initial is the completion date, but never
 * later than its deadline, so paying late does not push the plan back.
 * Returns null when the plan must not be touched.
 */
export const recalculateOrdinariesAfterInitial = ({ quotas, saleDate, paymentDay, minDays, earlyStart }) => {
  const initial = quotas.filter((q) => q.type === 'inicial' && q.number > 0);
  const ordinary = quotas.filter((q) => q.type === 'normal').sort((a, b) => a.number - b.number);
  if (initial.length === 0 || ordinary.length === 0) return null;
  if (initial.some((q) => q.status !== 'pagado')) return null;
  if (ordinary.some((q) => q.status === 'pagado' || (q.amountPaid || 0) > 0)) return null;

  const latest = (dates) => dates.filter(Boolean).reduce((max, d) => (!max || d > max ? d : max), null);
  const completed = latest(initial.map((q) => (q.paymentDate ? new Date(q.paymentDate) : null)));
  const deadline = latest(initial.map((q) => (q.dueDate ? new Date(q.dueDate) : null)));
  if (!completed || !deadline) return null;
  const end = compareCalendar(toCalendarDate(completed), toCalendarDate(deadline)) < 0 ? completed : deadline;

  const first = firstOrdinaryDate({ initialEnd: end, saleDate, paymentDay, minDays, earlyStart });
  const dates = ordinaryDueDates({ first: fromCalendarDate(first), paymentDay, count: ordinary.length });
  const changes = ordinary.map((q, i) => ({ quota: q, from: q.dueDate, to: fromCalendarDate(dates[i]) }))
    .filter((c) => !c.from || toISODate(toCalendarDate(c.from)) !== toISODate(toCalendarDate(c.to)));
  return { initialEnd: fromCalendarDate(toCalendarDate(end)), changes };
};

/**
 * Otrosí: rebuilds the ordinary quotas after the last one that has any payment.
 * Paid or partially paid quotas are never touched. Each recalculated quota keeps
 * its month unless the new day would fall before its current due date, in which
 * case the whole tail starts one month later (no quota becomes due earlier).
 *
 * Returns { keep, update: [{ quota, dueDate, value }], create: [{ number, dueDate, value }], remove: [quota] }.
 */
export const rebuildOrdinariesForOtrosi = ({ quotas, paymentDay, installmentsCount, totalOrdinaryValue }) => {
  const ordinary = quotas.filter((q) => q.type === 'normal').sort((a, b) => a.number - b.number);
  const touched = ordinary.filter((q) => q.status === 'pagado' || (q.amountPaid || 0) > 0);
  const lastTouchedNumber = touched.length ? Math.max(...touched.map((q) => q.number)) : 0;
  const tail = ordinary.filter((q) => q.number > lastTouchedNumber);
  const kept = ordinary.filter((q) => q.number <= lastTouchedNumber);
  if (tail.length === 0) {
    throw new AppError('No hay cuotas ordinarias sin pagar para recalcular', 400);
  }

  const day = Number(paymentDay);
  const newCount = installmentsCount !== undefined && installmentsCount !== null
    ? Number(installmentsCount) - kept.length
    : tail.length;
  if (!Number.isInteger(newCount) || newCount < 1) {
    throw new AppError(`El número de cuotas debe ser mayor que las ${kept.length} cuotas que ya tienen pagos`, 400);
  }

  const keptValue = kept.reduce((sum, q) => sum + (q.value || 0), 0);
  const tailValue = totalOrdinaryValue !== undefined && totalOrdinaryValue !== null
    ? Number(totalOrdinaryValue) - keptValue
    : tail.reduce((sum, q) => sum + (q.value || 0), 0);
  if (!(tailValue > 0)) {
    throw new AppError('El nuevo valor no alcanza para las cuotas pendientes', 400);
  }

  const anchor = toCalendarDate(tail[0].dueDate);
  let firstDate = dayInMonth(anchor.y, anchor.m, day);
  if (compareCalendar(firstDate, anchor) < 0) firstDate = dayInMonth(anchor.y, anchor.m + 1, day);
  const lastKept = kept.length ? toCalendarDate(kept[kept.length - 1].dueDate) : null;
  if (lastKept && compareCalendar(firstDate, lastKept) <= 0) firstDate = dayInMonth(lastKept.y, lastKept.m + 1, day);

  const dates = ordinaryDueDates({ first: fromCalendarDate(firstDate), paymentDay: day, count: newCount });
  const valuesChanged = newCount !== tail.length || (totalOrdinaryValue !== undefined && totalOrdinaryValue !== null);
  const values = valuesChanged ? splitEvenly(tailValue, newCount) : tail.map((q) => q.value);

  const update = [];
  const create = [];
  for (let i = 0; i < newCount; i++) {
    const dueDate = fromCalendarDate(dates[i]);
    if (i < tail.length) update.push({ quota: tail[i], dueDate, value: values[i] });
    else create.push({ number: lastTouchedNumber + i + 1, dueDate, value: values[i] });
  }
  const remove = tail.slice(newCount);
  return { kept, update, create, remove, tailValue, firstDate: fromCalendarDate(firstDate) };
};
