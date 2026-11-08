import Quota from '../models/Quota.js';

/**
 * Whether a payment's amounts are on its quotas' amountPaid.
 * A payment reported by the client (public page or portal) stays off the quotas until
 * it is approved; a manual payment and an approved one are on them.
 */
export const isAppliedToQuotas = (attempt) => {
  if (typeof attempt.appliedToQuotas === 'boolean') return attempt.appliedToQuotas;
  if (attempt.status === 'APROBADO') return true;
  // Before the flag existed, a pending payment was only on its quotas when the listing
  // created it from a quota that already had money (the legacy migration), and those
  // never stored the quota value that every client report stores
  return attempt.status === 'PENDIENTE' && attempt.quotaValue == null;
};

/**
 * Applies a payment to a contract: first to startQuota, then the excess in cascade to the
 * next pending or overdue quotas of the same contract (initial quotas first, then by number).
 * `applied` is filled as each quota is saved, so a caller can revert a partial application.
 * Returns the applied entries ({ quotaId, amount }), the quotas to notify (the start quota and
 * the ones fully paid by the cascade) and the amount left over once the contract is paid.
 */
export const applyPaymentToQuotas = async ({ startQuota, amount, tenantId, companyId, payment, applied = [] }) => {
  const notifyQuotaIds = [];
  let remaining = amount;

  const credit = async (quota, observations, isStart) => {
    const pending = Math.max(0, quota.value - (quota.amountPaid || 0));
    const part = Math.min(remaining, pending);
    if (part <= 0) return;

    quota.amountPaid = (quota.amountPaid || 0) + part;
    if (quota.amountPaid >= quota.value) quota.status = 'pagado';
    quota.paymentBank = payment.bank;
    quota.paymentMethod = payment.method;
    quota.paymentObservations = observations;
    quota.paymentDate = payment.date;
    quota.receiptNumber = payment.receiptNumber;
    if (payment.capture) quota.paymentCapture = payment.capture;
    await quota.save();

    applied.push({ quotaId: quota._id, amount: part });
    if (isStart || quota.status === 'pagado') notifyQuotaIds.push(quota._id);
    remaining -= part;
  };

  await credit(startQuota, payment.observations, true);

  if (remaining > 0) {
    const nextQuotas = await Quota.find({
      contract: startQuota.contract,
      tenantId,
      companyId,
      _id: { $ne: startQuota._id },
      status: { $in: ['pendiente', 'mora'] },
    }).sort({ type: 1, number: 1 });

    for (const quota of nextQuotas) {
      if (remaining <= 0) break;
      await credit(quota, `${payment.observations || ''} (Abono por excedente de la cuota #${startQuota.number})`.trim(), false);
    }
  }

  // A payment on a quota that was already paid, with nothing left in the contract,
  // still points to the quota it was made for
  if (applied.length === 0) applied.push({ quotaId: startQuota._id, amount: 0 });

  return { applied, notifyQuotaIds, unapplied: remaining };
};

/**
 * Takes the applied entries of a payment back off its quotas.
 */
export const revertAppliedPayment = async ({ entries, tenantId, companyId }) => {
  for (const entry of entries) {
    if (!entry.amount) continue;
    const quota = await Quota.findOne({ _id: entry.quotaId, tenantId, companyId });
    if (!quota) continue;

    quota.amountPaid = Math.max(0, (quota.amountPaid || 0) - entry.amount);
    if (quota.amountPaid < quota.value) {
      quota.status = quota.dueDate < new Date() ? 'mora' : 'pendiente';
    }
    if (quota.amountPaid === 0) {
      quota.paymentBank = undefined;
      quota.paymentMethod = undefined;
      quota.paymentObservations = undefined;
      quota.paymentDate = undefined;
      quota.paymentCapture = undefined;
      quota.receiptNumber = undefined;
    }
    await quota.save();
  }
};
