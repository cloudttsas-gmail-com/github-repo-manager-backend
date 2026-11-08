import Company from '../models/Company.js';
import Contract from '../models/Contract.js';
import Quota from '../models/Quota.js';
import Client from '../models/Client.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import AppError from '../utils/AppError.js';
import { logAudit } from '../utils/auditLogger.js';
import { parseBusinessDate } from '../utils/dates.js';
import {
  PLAN_RULES_VERSION,
  resolvePaymentPlanPolicy,
  validatePaymentPlanPolicy,
  recalculateOrdinariesAfterInitial,
  rebuildOrdinariesForOtrosi,
  firstOrdinaryDate,
  ordinaryDueDates,
  toCalendarDate,
  fromCalendarDate,
  compareCalendar,
  toISODate,
} from './paymentPlanRules.js';

const SIGNED_STATUSES = ['firmado', 'con_otrosi'];
const formatDate = (date) => (date ? toISODate(toCalendarDate(date)) : null);
// History summaries are read by people: Colombian date, labels and money
const displayDate = (value) => {
  const iso = value instanceof Date ? formatDate(value) : value;
  if (!iso || typeof iso !== 'string') return '-';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const LEGAL_STATUS_LABELS = { sin_firmar: 'Sin firmar', firmado: 'Firmado', con_otrosi: 'Con otrosí' };
const legalLabel = (status) => LEGAL_STATUS_LABELS[status] || 'Sin registrar';
const displayMoney = (value) => (value === undefined || value === null ? '-' : `$${Number(value).toLocaleString('es-CO')}`);
const statusForDueDate = (dueDate) => (new Date(dueDate) < new Date() ? 'mora' : 'pendiente');

export const getPaymentPlanPolicy = async ({ tenantId, companyId }) => {
  const company = await Company.findOne({ _id: companyId, tenantId }).select('paymentPlanPolicy');
  if (!company) throw new AppError('Empresa no encontrada', 404);
  return resolvePaymentPlanPolicy(company.paymentPlanPolicy);
};

export const updatePaymentPlanPolicy = async ({ tenantId, companyId, input, req }) => {
  const company = await Company.findOne({ _id: companyId, tenantId });
  if (!company) throw new AppError('Empresa no encontrada', 404);
  const previous = resolvePaymentPlanPolicy(company.paymentPlanPolicy);
  const policy = validatePaymentPlanPolicy({ ...previous, ...input });
  company.paymentPlanPolicy = policy;
  await company.save();
  await logAudit(req, {
    action: 'UPDATE_PAYMENT_PLAN_POLICY',
    module: 'COMPANIES',
    targetId: company._id,
    details: { previous, policy },
  });
  return policy;
};

const historyAuthor = (req) => ({
  recordedBy: req?.user?.userId,
  recordedByName: req?.user?.fullName,
  recordedAt: new Date(),
});

const pushHistory = (contract, entry) => {
  contract.planHistory = [...(contract.planHistory || []), entry];
};

const loadContract = async ({ contractId, tenantId, companyId }) => {
  const contract = await Contract.findOne({ _id: contractId, tenantId, companyId });
  if (!contract) throw new AppError('Contrato no encontrado', 404);
  return contract;
};

const loadQuotas = ({ contract, tenantId, companyId }) =>
  Quota.find({ contract: contract._id, tenantId, companyId }).sort({ type: 1, number: 1 });

const contractPaymentDay = (contract, quotas) => {
  if (contract.paymentDay >= 1 && contract.paymentDay <= 31) return contract.paymentDay;
  const firstOrdinary = quotas.find((q) => q.type === 'normal');
  return firstOrdinary?.dueDate ? toCalendarDate(firstOrdinary.dueDate).d : null;
};

/** Sends the updated plan to the client; never fails the operation that triggered it. */
const sendUpdatedPlan = async ({ contract, tenantId, companyId, reason }) => {
  try {
    const client = await Client.findOne({ _id: contract.client, tenantId, companyId });
    if (!client) return;
    const quotas = await loadQuotas({ contract, tenantId, companyId });
    const { sendPaymentPlanEmail } = await import('../utils/clientAuthHelper.js');
    await sendPaymentPlanEmail(client, quotas, contract, companyId, reason);
  } catch (error) {
    console.error('[PAYMENT_PLAN] Error sending the updated plan:', error);
  }
};

/**
 * Moves the unpaid ordinary quotas so the first one follows the rule from `initialEnd`.
 * Only for contracts under the new rules and only while no ordinary quota has payments.
 * Returns the list of changes applied (empty when nothing moved).
 */
const realignOrdinariesFromInitialEnd = async ({ contract, quotas, initialEnd }) => {
  if (contract.planRules !== PLAN_RULES_VERSION) return [];
  const ordinary = quotas.filter((q) => q.type === 'normal').sort((a, b) => a.number - b.number);
  if (ordinary.length === 0 || ordinary.some((q) => q.status === 'pagado' || (q.amountPaid || 0) > 0)) return [];
  const paymentDay = contractPaymentDay(contract, quotas);
  if (!paymentDay) return [];

  const first = firstOrdinaryDate({
    initialEnd,
    saleDate: contract.contractDate || contract.createdAt,
    paymentDay,
    minDays: contract.planPolicy?.minDaysBeforeFirstOrdinary ?? 30,
    earlyStart: Boolean(contract.planPolicy?.earlyStart),
  });
  const dates = ordinaryDueDates({ first: fromCalendarDate(first), paymentDay, count: ordinary.length });
  const changes = [];
  for (let i = 0; i < ordinary.length; i++) {
    const quota = ordinary[i];
    const to = fromCalendarDate(dates[i]);
    if (formatDate(quota.dueDate) === formatDate(to)) continue;
    changes.push({ number: quota.number, from: formatDate(quota.dueDate), to: formatDate(to) });
    quota.dueDate = to;
    quota.status = statusForDueDate(to);
    await quota.save();
  }
  return changes;
};

/**
 * Decision (b): once the initial quota is fully paid, the unpaid ordinary quotas are
 * recalculated from the completion date. Only for contracts sold under the new rules,
 * and only while no ordinary quota has any payment. Never throws.
 */
export const recalculatePlanAfterInitialPayment = async ({ contractId, tenantId, companyId, req }) => {
  try {
    const contract = await Contract.findOne({ _id: contractId, tenantId, companyId });
    if (!contract || contract.planRules !== PLAN_RULES_VERSION) return null;
    const quotas = await loadQuotas({ contract, tenantId, companyId });
    const paymentDay = contractPaymentDay(contract, quotas);
    if (!paymentDay) return null;

    const result = recalculateOrdinariesAfterInitial({
      quotas,
      saleDate: contract.contractDate || contract.createdAt,
      paymentDay,
      minDays: contract.planPolicy?.minDaysBeforeFirstOrdinary ?? 30,
      earlyStart: Boolean(contract.planPolicy?.earlyStart),
    });
    if (!result || result.changes.length === 0) return null;

    const changes = [];
    for (const { quota, from, to } of result.changes) {
      quota.dueDate = to;
      quota.status = statusForDueDate(to);
      await quota.save();
      changes.push({ number: quota.number, from: formatDate(from), to: formatDate(to) });
    }

    pushHistory(contract, {
      kind: 'recalculation',
      summary: `Cuota inicial pagada completa el ${displayDate(result.initialEnd)}: cuotas ordinarias recalculadas desde esa fecha`,
      changes: { initialEnd: formatDate(result.initialEnd), quotas: changes },
      ...historyAuthor(req),
    });
    await contract.save();

    await logAudit(req, {
      action: 'RECALCULATE_PLAN_AFTER_INITIAL',
      module: 'CONTRACTS',
      targetId: contract._id,
      details: { initialEnd: formatDate(result.initialEnd), quotas: changes },
    });

    await sendUpdatedPlan({ contract, tenantId, companyId, reason: 'completaste el pago de tu cuota inicial y tus cuotas ordinarias se ajustaron a esa fecha' });
    return { initialEnd: result.initialEnd, changes };
  } catch (error) {
    console.error('[PAYMENT_PLAN] Error recalculating the plan after the initial payment:', error);
    return null;
  }
};

const requireText = (value, message) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new AppError(message, 400);
  return text;
};

const parseRequiredDate = (value, message) => {
  const date = parseBusinessDate(value, null);
  if (!date) throw new AppError(message, 400);
  return date;
};

/** Moves the initial deadline (the last unpaid initial quota) and realigns the ordinaries. */
const applyInitialDeadline = async ({ contract, quotas, newDeadline }) => {
  const initial = quotas.filter((q) => q.type === 'inicial' && q.number > 0).sort((a, b) => a.number - b.number);
  const pending = initial.filter((q) => q.status !== 'pagado');
  if (pending.length === 0) throw new AppError('La cuota inicial ya está pagada: no hay plazo que ampliar', 400);

  const currentDeadline = initial.reduce((max, q) => (!max || q.dueDate > max ? q.dueDate : max), null);
  const target = toCalendarDate(newDeadline);
  if (currentDeadline && compareCalendar(target, toCalendarDate(currentDeadline)) <= 0) {
    throw new AppError(`La nueva fecha límite debe ser posterior a la actual (${formatDate(currentDeadline)})`, 400);
  }

  const quota = pending[pending.length - 1];
  const deadline = fromCalendarDate(target);
  quota.dueDate = deadline;
  quota.status = statusForDueDate(deadline);
  await quota.save();
  contract.initialDeadline = deadline;

  const ordinaries = await realignOrdinariesFromInitialEnd({ contract, quotas, initialEnd: deadline });
  return { from: formatDate(currentDeadline), to: formatDate(deadline), ordinaries };
};

/**
 * «Registrar ampliación del plazo de la inicial». With the contract signed it is
 * recorded as an otrosí; otherwise as a registered approval.
 */
export const registerInitialExtension = async ({ contractId, tenantId, companyId, body, req }) => {
  const reason = requireText(body.reason, 'El motivo de la ampliación es obligatorio');
  const approvedByName = requireText(body.approvedByName, 'Indica quién aprobó la ampliación fuera de Operix');
  const approvedAt = parseRequiredDate(body.approvedAt, 'Indica la fecha de la aprobación');
  const newDeadline = parseRequiredDate(body.newDeadline, 'Indica la nueva fecha límite de la cuota inicial');

  const contract = await loadContract({ contractId, tenantId, companyId });
  const quotas = await loadQuotas({ contract, tenantId, companyId });
  const deadline = await applyInitialDeadline({ contract, quotas, newDeadline });

  const signed = SIGNED_STATUSES.includes(contract.legalStatus);
  if (signed) contract.legalStatus = 'con_otrosi';
  pushHistory(contract, {
    kind: signed ? 'otrosi' : 'extension',
    summary: `Plazo de la cuota inicial ampliado del ${displayDate(deadline.from)} al ${displayDate(deadline.to)}`,
    changes: { initialDeadline: deadline },
    reason,
    approvedByName,
    approvedAt,
    contractSigned: signed,
    ...historyAuthor(req),
  });
  await contract.save();

  await logAudit(req, {
    action: 'REGISTER_INITIAL_EXTENSION',
    module: 'CONTRACTS',
    targetId: contract._id,
    details: { ...deadline, reason, approvedByName, approvedAt, asOtrosi: signed },
  });
  await sendUpdatedPlan({ contract, tenantId, companyId, reason: 'se registró una ampliación del plazo de tu cuota inicial' });
  return contract;
};

const parseOptionalInt = (value, min, max, message) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError(message, 400);
  return n;
};

/**
 * «Registrar otrosí»: records a change approved and signed outside Operix and
 * recalculates only the unpaid quotas from the next one. Paid quotas are never touched.
 */
export const registerOtrosi = async ({ contractId, tenantId, companyId, body, file, req }) => {
  const reason = requireText(body.reason, 'El motivo del otrosí es obligatorio');
  const approvedByName = requireText(body.approvedByName, 'Indica quién aprobó el otrosí fuera de Operix');
  const approvedAt = parseRequiredDate(body.approvedAt, 'Indica la fecha de la aprobación');

  const paymentDay = parseOptionalInt(body.paymentDay, 1, 31, 'El día de pago debe estar entre 1 y 31');
  const installmentsCount = parseOptionalInt(body.installmentsCount, 1, 600, 'El número de cuotas ordinarias debe estar entre 1 y 600');
  const totalValue = body.totalValue === undefined || body.totalValue === null || body.totalValue === ''
    ? undefined
    : Number(body.totalValue);
  if (totalValue !== undefined && !(totalValue > 0)) throw new AppError('El nuevo valor del contrato debe ser mayor a 0', 400);
  const newDeadline = body.initialDeadline ? parseRequiredDate(body.initialDeadline, 'La nueva fecha límite no es válida') : undefined;

  if (paymentDay === undefined && installmentsCount === undefined && totalValue === undefined && !newDeadline) {
    throw new AppError('Indica qué cambia el otrosí: día de pago, plazo de la inicial, número de cuotas o valor', 400);
  }

  const contract = await loadContract({ contractId, tenantId, companyId });

  if (paymentDay !== undefined) {
    const policy = await getPaymentPlanPolicy({ tenantId, companyId });
    if (!policy.allowedPaymentDays.includes(paymentDay)) {
      throw new AppError(`El día de pago debe ser uno de los permitidos por el proyecto: ${policy.allowedPaymentDays.join(', ')}`, 400);
    }
  }

  // Changing values or the number of quotas would leave reported payments pointing at other amounts
  if (installmentsCount !== undefined || totalValue !== undefined) {
    const pendingReports = await PaymentAttempt.countDocuments({ contractId: contract._id, tenantId, companyId, status: 'PENDIENTE' });
    if (pendingReports > 0) {
      throw new AppError('El contrato tiene pagos reportados sin aprobar. Apruébalos o recházalos antes de registrar el otrosí.', 409);
    }
  }

  let quotas = await loadQuotas({ contract, tenantId, companyId });
  const changes = {};
  const previousPaymentDay = contractPaymentDay(contract, quotas);
  if (paymentDay !== undefined) contract.paymentDay = paymentDay;

  if (newDeadline) {
    changes.initialDeadline = await applyInitialDeadline({ contract, quotas, newDeadline });
    quotas = await loadQuotas({ contract, tenantId, companyId });
  }

  if (paymentDay !== undefined || installmentsCount !== undefined || totalValue !== undefined) {
    const initialTotal = quotas.filter((q) => q.type === 'inicial').reduce((sum, q) => sum + (q.value || 0), 0);
    const plan = rebuildOrdinariesForOtrosi({
      quotas,
      paymentDay: contract.paymentDay || previousPaymentDay,
      installmentsCount,
      totalOrdinaryValue: totalValue !== undefined ? totalValue - initialTotal : undefined,
    });

    const quotaChanges = [];
    for (const { quota, dueDate, value } of plan.update) {
      const before = { dueDate: formatDate(quota.dueDate), value: quota.value };
      if (before.dueDate === formatDate(dueDate) && before.value === value) continue;
      quota.dueDate = dueDate;
      quota.value = value;
      quota.status = statusForDueDate(dueDate);
      await quota.save();
      quotaChanges.push({ number: quota.number, from: before, to: { dueDate: formatDate(dueDate), value } });
    }
    if (plan.create.length > 0) {
      await Quota.insertMany(plan.create.map((q) => ({
        tenantId, companyId, contract: contract._id, number: q.number, type: 'normal',
        value: q.value, dueDate: q.dueDate, status: statusForDueDate(q.dueDate),
      })));
      plan.create.forEach((q) => quotaChanges.push({ number: q.number, from: null, to: { dueDate: formatDate(q.dueDate), value: q.value } }));
    }
    if (plan.remove.length > 0) {
      await Quota.deleteMany({ _id: { $in: plan.remove.map((q) => q._id) }, contract: contract._id, tenantId, companyId, status: { $ne: 'pagado' }, amountPaid: { $in: [0, null] } });
      plan.remove.forEach((q) => quotaChanges.push({ number: q.number, from: { dueDate: formatDate(q.dueDate), value: q.value }, to: null }));
    }

    if (paymentDay !== undefined) changes.paymentDay = { from: previousPaymentDay, to: paymentDay };
    if (installmentsCount !== undefined) {
      changes.installmentsCount = { from: contract.installmentsCount, to: installmentsCount };
      contract.installmentsCount = installmentsCount;
    }
    if (totalValue !== undefined) {
      changes.totalValue = { from: contract.totalValue, to: totalValue };
      contract.totalValue = totalValue;
    }
    if (installmentsCount !== undefined || totalValue !== undefined) {
      const firstNew = plan.update[0] || plan.create[0];
      if (firstNew) contract.installmentValue = firstNew.value;
    }
    changes.quotas = quotaChanges;
  }

  let documentUrl;
  if (file) {
    const { uploadToR2 } = await import('../utils/storage.js');
    documentUrl = await uploadToR2(file, 'contracts');
  }

  const signed = SIGNED_STATUSES.includes(contract.legalStatus);
  if (signed) contract.legalStatus = 'con_otrosi';
  const parts = [];
  if (changes.paymentDay) parts.push(`día de pago ${changes.paymentDay.from ?? '-'} → ${changes.paymentDay.to}`);
  if (changes.initialDeadline) parts.push(`plazo de la inicial ${displayDate(changes.initialDeadline.from)} → ${displayDate(changes.initialDeadline.to)}`);
  if (changes.installmentsCount) parts.push(`cuotas ordinarias ${changes.installmentsCount.from ?? '-'} → ${changes.installmentsCount.to}`);
  if (changes.totalValue) parts.push(`valor ${displayMoney(changes.totalValue.from)} → ${displayMoney(changes.totalValue.to)}`);
  pushHistory(contract, {
    kind: 'otrosi',
    summary: `Otrosí: ${parts.join('; ')}`,
    changes,
    reason,
    approvedByName,
    approvedAt,
    documentUrl,
    contractSigned: signed,
    ...historyAuthor(req),
  });
  await contract.save();

  await logAudit(req, {
    action: 'REGISTER_OTROSI',
    module: 'CONTRACTS',
    targetId: contract._id,
    details: { changes, reason, approvedByName, approvedAt, documentUrl },
  });
  await sendUpdatedPlan({ contract, tenantId, companyId, reason: 'se registró un otrosí a tu contrato' });
  return contract;
};

/** Registers whether the contract is signed (the signing happens outside Operix). */
export const setContractLegalStatus = async ({ contractId, tenantId, companyId, body, file, req }) => {
  const status = body.legalStatus;
  if (!['sin_firmar', 'firmado'].includes(status)) {
    throw new AppError('El estado del contrato debe ser sin firmar o firmado', 400);
  }
  const contract = await loadContract({ contractId, tenantId, companyId });
  const hasOtrosi = (contract.planHistory || []).some((h) => h.kind === 'otrosi' && h.contractSigned);
  const previous = contract.legalStatus || null;
  const next = status === 'firmado' && hasOtrosi ? 'con_otrosi' : status;

  let documentUrl;
  if (file) {
    const { uploadToR2 } = await import('../utils/storage.js');
    documentUrl = await uploadToR2(file, 'contracts');
    contract.contractDocumentUrl = documentUrl;
  }
  contract.legalStatus = next;
  contract.signedAt = status === 'firmado' ? parseBusinessDate(body.signedAt, new Date()) : undefined;
  pushHistory(contract, {
    kind: 'legal_status',
    summary: `Estado del contrato: ${legalLabel(previous)} → ${legalLabel(next)}`,
    changes: { legalStatus: { from: previous, to: next }, signedAt: formatDate(contract.signedAt) },
    reason: typeof body.reason === 'string' ? body.reason.trim() : undefined,
    documentUrl,
    contractSigned: status === 'firmado',
    ...historyAuthor(req),
  });
  await contract.save();

  await logAudit(req, {
    action: 'SET_CONTRACT_LEGAL_STATUS',
    module: 'CONTRACTS',
    targetId: contract._id,
    details: { from: previous, to: next, documentUrl },
  });
  return contract;
};
