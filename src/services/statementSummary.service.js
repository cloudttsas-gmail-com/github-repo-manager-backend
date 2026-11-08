import mongoose from 'mongoose';
import Contract from '../models/Contract.js';
import Quota from '../models/Quota.js';
import Company from '../models/Company.js';
import { publicLinkUrl } from '../utils/publicLinks.js';

/**
 * One account statement for every channel (panel, portal, public page, PDF,
 * Excel, WhatsApp and email), so the buyer reads the same numbers everywhere.
 *
 * Rules:
 * - A quota counts as paid with what was applied to it (`amountPaid`); a quota
 *   marked `pagado` without an amount (older data) counts its full value.
 * - A quota is overdue when it still owes something and its due day (Bogotá)
 *   is before today. The stored `mora` status is not used: nothing updates it
 *   when a due date passes, so it is only set when a payment is rolled back.
 * - The paid total keeps the larger of the quotas and the Siigo totals loaded
 *   from Excel (`recaudadoSiigo2024/2025`), as the client detail already did.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = 'America/Bogota';

/** YYYY-MM-DD of a date in Bogotá. */
export const bogotaDay = (date) => new Date(date).toLocaleDateString('en-CA', { timeZone: TIME_ZONE });

/** Midnight in Bogotá of the day `now` falls on; earlier due dates are overdue. */
export const startOfBogotaDay = (now = new Date()) => new Date(`${bogotaDay(now)}T00:00:00-05:00`);

const dayIndex = (date) => Math.round(Date.parse(`${bogotaDay(date)}T00:00:00Z`) / DAY_MS);

export const quotaPaidAmount = (q) => {
  if (q.status === 'pagado') return q.amountPaid > 0 ? q.amountPaid : (q.value || 0);
  return q.amountPaid || 0;
};

export const quotaPendingAmount = (q) => {
  if (q.status === 'pagado') return 0;
  return Math.max(0, (q.value || 0) - (q.amountPaid || 0));
};

export const isQuotaOverdue = (q, now = new Date()) =>
  quotaPendingAmount(q) > 0 && !!q.dueDate && new Date(q.dueDate) < startOfBogotaDay(now);

/** pagada | mora | abonada | pendiente */
export const quotaState = (q, now = new Date()) => {
  if (quotaPendingAmount(q) === 0) return 'pagada';
  if (isQuotaOverdue(q, now)) return 'mora';
  if ((q.amountPaid || 0) > 0) return 'abonada';
  return 'pendiente';
};

export const QUOTA_STATE_LABELS = {
  pagada: 'PAGADA',
  mora: 'EN MORA',
  abonada: 'ABONADA',
  pendiente: 'PENDIENTE',
};

export const quotaLabel = (q) => {
  if (q.type === 'inicial') return Number(q.number) === 0 ? 'Separación' : `Cuota inicial ${q.number}`;
  return `Cuota ${q.number}`;
};

export const lotLabel = (lot) => {
  if (!lot) return 'N/A';
  const base = `Etapa: ${lot.stage || '-'} - Manzana: ${lot.manzana || '-'} - Lote: ${lot.lotNumber || '-'}`;
  // The nomenclature already names stage, block and lot: never repeat them
  return lot.nomenclature || base;
};

const byTypeAndNumber = (a, b) => {
  if (a.type !== b.type) return a.type === 'inicial' ? -1 : 1;
  return (a.number || 0) - (b.number || 0);
};

const byDueDate = (a, b) => {
  const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
  const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
  return da - db || byTypeAndNumber(a, b);
};

const breakdownOf = (quotas) => ({
  count: quotas.length,
  paidCount: quotas.filter((q) => quotaPendingAmount(q) === 0).length,
  total: quotas.reduce((sum, q) => sum + (q.value || 0), 0),
  paid: quotas.reduce((sum, q) => sum + quotaPaidAmount(q), 0),
});

/**
 * Pure calculation: the summary of a contract from its quotas.
 * `contract.lot` may be populated (for the label) or an id.
 */
export const buildStatementSummary = (contract, quotas, { now = new Date(), apiUrl } = {}) => {
  const sorted = [...quotas].sort(byTypeAndNumber);
  const quotasTotal = sorted.reduce((sum, q) => sum + (q.value || 0), 0);
  const totalValue = contract.totalValue || quotasTotal;

  const paidFromQuotas = sorted.reduce((sum, q) => sum + quotaPaidAmount(q), 0);
  const paidSiigo = (contract.recaudadoSiigo2024 || 0) + (contract.recaudadoSiigo2025 || 0);
  const totalPaid = Math.max(paidFromQuotas, paidSiigo);
  const balance = Math.max(0, totalValue - totalPaid);

  const unpaid = sorted.filter((q) => quotaPendingAmount(q) > 0).sort(byDueDate);
  const overdue = unpaid.filter((q) => isQuotaOverdue(q, now));
  const next = unpaid[0] || null;
  const daysOverdue = overdue.length > 0 && overdue[0].dueDate
    ? Math.max(0, dayIndex(now) - dayIndex(overdue[0].dueDate))
    : 0;

  let status = 'al_dia';
  if (overdue.length > 0) status = 'en_mora';
  else if (sorted.length > 0 && unpaid.length === 0 && balance === 0) status = 'pagado';

  const lot = contract.lot && !(contract.lot instanceof mongoose.Types.ObjectId) ? contract.lot : null;
  const contractId = String(contract._id);

  return {
    contractId,
    lotLabel: lotLabel(lot),
    lotNumber: lot?.lotNumber || '',
    projectName: contract.negotiation || '',
    totalValue,
    totalPaid,
    balance,
    percentPaid: totalValue > 0 ? Math.round((totalPaid / totalValue) * 100) : 0,
    quotasCount: sorted.length,
    paidQuotasCount: sorted.length - unpaid.length,
    nextQuota: next ? {
      id: String(next._id),
      number: next.number,
      type: next.type,
      label: quotaLabel(next),
      dueDate: next.dueDate || null,
      value: next.value || 0,
      pending: quotaPendingAmount(next),
      overdue: isQuotaOverdue(next, now),
    } : null,
    overdueCount: overdue.length,
    overdueAmount: overdue.reduce((sum, q) => sum + quotaPendingAmount(q), 0),
    daysOverdue,
    status,
    breakdown: {
      initial: breakdownOf(sorted.filter((q) => q.type === 'inicial')),
      normal: breakdownOf(sorted.filter((q) => q.type !== 'inicial')),
    },
    quotas: sorted.map((q) => {
      const state = quotaState(q, now);
      return {
        id: String(q._id),
        number: q.number,
        type: q.type,
        label: quotaLabel(q),
        dueDate: q.dueDate || null,
        value: q.value || 0,
        paid: quotaPaidAmount(q),
        pending: quotaPendingAmount(q),
        paymentDate: q.paymentDate || null,
        state,
        stateLabel: QUOTA_STATE_LABELS[state],
      };
    }),
    statementUrl: publicLinkUrl('statement', contractId, apiUrl),
    excelUrl: publicLinkUrl('statement-excel', contractId, apiUrl),
    generatedAt: now,
  };
};

/**
 * Loads a contract with its quotas and builds the summary. `filter` must carry
 * the scope of the caller (tenantId and companyId, or the portal client); a
 * contract outside it is not found.
 */
export const loadStatement = async (filter, { now, apiUrl } = {}) => {
  const contract = await Contract.findOne(filter).populate('client').populate('lot');
  if (!contract) return null;

  const [quotas, company] = await Promise.all([
    Quota.find({ contract: contract._id, tenantId: contract.tenantId, companyId: contract.companyId }),
    Company.findById(contract.companyId),
  ]);

  return {
    contract,
    client: contract.client,
    company,
    quotas,
    summary: buildStatementSummary(contract, quotas, { now, apiUrl }),
  };
};

/**
 * Company-wide overdue figures with the same rule as the summary.
 */
export const getCompanyOverdueStats = async (tenantId, companyId, now = new Date()) => {
  const [row] = await Quota.aggregate([
    {
      $match: {
        tenantId: new mongoose.Types.ObjectId(String(tenantId)),
        companyId: new mongoose.Types.ObjectId(String(companyId)),
        status: { $ne: 'pagado' },
        dueDate: { $lt: startOfBogotaDay(now) },
      },
    },
    { $addFields: { pending: { $subtract: [{ $ifNull: ['$value', 0] }, { $ifNull: ['$amountPaid', 0] }] } } },
    { $match: { pending: { $gt: 0 } } },
    { $group: { _id: null, quotas: { $sum: 1 }, amount: { $sum: '$pending' }, contracts: { $addToSet: '$contract' } } },
  ]);
  return {
    overdueQuotas: row?.quotas || 0,
    overdueAmount: row?.amount || 0,
    overdueContracts: row?.contracts?.length || 0,
  };
};

/**
 * The data the PDF generator expects, taken from the summary.
 */
export const toStatementPdfData = ({ contract, client, company, summary }) => ({
  contractId: contract._id,
  clientName: client?.name || 'N/A',
  clientId: client?.idNumber || 'N/A',
  clientPhone: client?.phone || '',
  clientEmail: client?.email || '',
  projectName: contract.negotiation || 'Proyecto sin nombre',
  lotInfo: summary.lotLabel,
  companyName: company?.name || '',
  companyNit: company?.nit || '',
  companyAddress: company?.address || '',
  companyPhone: company?.phone || '',
  companyLogo: company?.projectLogo || company?.logo || '',
  totalValue: summary.totalValue,
  totalPaid: summary.totalPaid,
  totalPending: summary.balance,
  averageRecaudo: summary.percentPaid,
  overdueCount: summary.overdueCount,
  overdueAmount: summary.overdueAmount,
  daysOverdue: summary.daysOverdue,
  valorTotalInicial: summary.breakdown.initial.total,
  valorPagadoInicial: summary.breakdown.initial.paid,
  totalCuotasIniciales: summary.breakdown.initial.count,
  cuotasInicialesPagadas: summary.breakdown.initial.paidCount,
  valorTotalCuotas: summary.breakdown.normal.total,
  valorPagadoCuotas: summary.breakdown.normal.paid,
  totalCuotasNormales: summary.breakdown.normal.count,
  cuotasNormalesPagadas: summary.breakdown.normal.paidCount,
  quotas: summary.quotas.map((q) => ({
    number: q.number,
    type: q.type,
    dueDate: q.dueDate,
    value: q.value,
    amountPaid: q.paid,
    paymentDate: q.paymentDate,
    status: q.state === 'pagada' ? 'pagado' : 'pendiente',
    statusLabel: q.stateLabel,
  })),
});
