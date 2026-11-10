import mongoose from 'mongoose';
import Contract from '../models/Contract.js';
import Quota from '../models/Quota.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import AppError from '../utils/AppError.js';

const MAX_QUOTAS = 600;

const isQuotaCount = (val, min) => Number.isInteger(Number(val)) && Number(val) >= min && Number(val) <= MAX_QUOTAS;
const isAmount = (val, { positive }) => val !== null && val !== '' && typeof val !== 'boolean'
  && Number.isFinite(Number(val)) && (positive ? Number(val) > 0 : Number(val) >= 0);
const isDate = (val) => !Number.isNaN(new Date(val).getTime());

/**
 * Checks a restructured plan before saving it: every quota belongs to the contract, values are
 * numbers that never go below what a quota already received, and the plan adds up to the contract value.
 */
const validateAdjustment = (contract, existingQuotas, updatedQuotas) => {
  if (updatedQuotas.length === 0) throw new AppError('El plan no tiene cuotas', 400);

  const byId = new Map(existingQuotas.map((q) => [q._id.toString(), q]));
  const finalValues = new Map(existingQuotas.map((q) => [q._id.toString(), q.value || 0]));
  const taken = new Set(existingQuotas.map((q) => `${q.type}-${q.number}`));
  let newTotal = 0;

  for (const qData of updatedQuotas) {
    const label = `la cuota #${qData.number ?? '?'}`;
    if (!isAmount(qData.value, { positive: false })) throw new AppError(`El valor de ${label} no es válido`, 400);
    if (qData.dueDate && !isDate(qData.dueDate)) throw new AppError(`La fecha de ${label} no es válida`, 400);
    const value = Number(qData.value);

    if (qData._id) {
      const existing = byId.get(String(qData._id));
      if (!existing) throw new AppError(`${label[0].toUpperCase()}${label.slice(1)} no pertenece a este contrato`, 400);
      // A paid quota keeps its value (it is never changed below)
      if (existing.status === 'pagado') continue;
      if (value < (existing.amountPaid || 0)) {
        throw new AppError(`El valor de ${label} no puede ser menor que lo que ya se abonó a ella`, 400);
      }
      finalValues.set(existing._id.toString(), value);
    } else {
      const type = qData.type || 'normal';
      if (!['inicial', 'normal'].includes(type) || !Number.isInteger(Number(qData.number)) || Number(qData.number) < 1) {
        throw new AppError('Una cuota nueva no tiene un número o tipo válido', 400);
      }
      if (!qData.dueDate) throw new AppError(`Falta la fecha de ${label}`, 400);
      if (taken.has(`${type}-${Number(qData.number)}`)) throw new AppError(`${label[0].toUpperCase()}${label.slice(1)} ya existe en el contrato`, 400);
      taken.add(`${type}-${Number(qData.number)}`);
      newTotal += value;
    }
  }

  const planTotal = [...finalValues.values()].reduce((acc, v) => acc + v, 0) + newTotal;
  const difference = planTotal - (contract.totalValue || 0);
  if (Math.abs(difference) >= 1) {
    throw new AppError(`El plan suma $${planTotal.toLocaleString('es-CO')} y el contrato vale $${(contract.totalValue || 0).toLocaleString('es-CO')}: ajuste las cuotas hasta que cuadre`, 400);
  }
};

/**
 * Simulates schedule adjustment without modifying the database.
 * Retains historical payments and computes projected remaining quotas.
 */
export async function simulateScheduleAdjustment({ contractId, tenantId, companyId, changes, strategy }) {
  const contract = await Contract.findOne({ _id: contractId, tenantId, companyId });
  if (!contract) {
    throw new Error('Contrato no encontrado');
  }

  const existingQuotas = await Quota.find({ contract: contractId, tenantId, companyId }).sort({ type: 1, number: 1 });

  // Compute contract values
  const totalValue = contract.totalValue || 0;
  const initialQuotas = existingQuotas.filter(q => q.type === 'inicial');
  const normalQuotas = existingQuotas.filter(q => q.type === 'normal');

  // Sum of initial quotas vs normal quotas
  const initialTotalPactado = initialQuotas.reduce((acc, q) => acc + (q.value || 0), 0);
  const normalTotalPactado = totalValue - initialTotalPactado;

  // Clone normal quotas for preview calculation
  let updatedNormalQuotas = normalQuotas.map(q => ({
    _id: q._id ? q._id.toString() : null,
    number: q.number,
    type: q.type,
    dueDate: q.dueDate,
    value: q.value,
    status: q.status,
    amountPaid: q.amountPaid || 0,
    isPaidOrPartial: q.status === 'pagado' || (q.amountPaid && q.amountPaid > 0),
  }));

  const warnings = [];

  // Apply target modifications passed in changes: { targetNumber, newValue, newDueDate }
  if (changes && Array.isArray(changes)) {
    for (const change of changes) {
      const idx = updatedNormalQuotas.findIndex(q => q.number === change.targetNumber);
      if (idx !== -1) {
        const targetQuota = updatedNormalQuotas[idx];
        if (targetQuota.isPaidOrPartial) {
          warnings.push(`La cuota #${targetQuota.number} tiene estado ${targetQuota.status} o abonado ($${targetQuota.amountPaid}). Se sugiere revisar el impacto en cuotas posteriores.`);
        }
        if (change.newValue !== undefined && change.newValue >= 0) {
          targetQuota.value = Number(change.newValue);
        }
        if (change.newDueDate) {
          targetQuota.dueDate = new Date(change.newDueDate);
        }
      }
    }
  }

  // Calculate sum of fixed / touched / paid cuotas vs remaining editable pending cuotas
  const totalPaidSoFar = existingQuotas.reduce((acc, q) => acc + (q.amountPaid || 0), 0);

  // Separate normal quotas into modified/fixed and editable pending
  const modifiedNumbers = new Set((changes || []).map(c => c.targetNumber));
  
  // Pending editable quotas (excluding paid and explicitly modified)
  const pendingEditable = updatedNormalQuotas.filter(q => !q.isPaidOrPartial && !modifiedNumbers.has(q.number));

  // Current total allocated across all quotas (initial + normal)
  let currentNormalSum = updatedNormalQuotas.reduce((acc, q) => acc + q.value, 0);
  let grandTotalAllocated = initialTotalPactado + currentNormalSum;
  let delta = grandTotalAllocated - totalValue; // > 0 means surplus (over allocated), < 0 means deficit (under allocated)

  if (Math.abs(delta) > 0.01 && strategy === 'REPARTIR_PENDIENTES') {
    if (pendingEditable.length > 0) {
      const adjustmentPerQuota = Math.round(-delta / pendingEditable.length);
      let remainder = -delta - (adjustmentPerQuota * pendingEditable.length);

      for (let i = 0; i < pendingEditable.length; i++) {
        const item = pendingEditable[i];
        let extra = i === pendingEditable.length - 1 ? remainder : 0;
        item.value = Math.max(0, item.value + adjustmentPerQuota + extra);
      }
    } else {
      warnings.push('No hay suficientes cuotas pendientes no modificadas para distribuir la diferencia.');
    }
  } else if (Math.abs(delta) > 0.01 && strategy === 'AJUSTAR_ULTIMAS') {
    let remainingDelta = -delta;
    for (let i = updatedNormalQuotas.length - 1; i >= 0; i--) {
      const q = updatedNormalQuotas[i];
      if (q.isPaidOrPartial || modifiedNumbers.has(q.number)) continue;

      if (remainingDelta < 0) {
        const canReduce = q.value;
        const reduction = Math.min(canReduce, Math.abs(remainingDelta));
        q.value -= reduction;
        remainingDelta += reduction;
      } else if (remainingDelta > 0) {
        q.value += remainingDelta;
        remainingDelta = 0;
      }
      if (Math.abs(remainingDelta) < 0.01) break;
    }
  }

  // Recalculate final sum and balance
  currentNormalSum = updatedNormalQuotas.reduce((acc, q) => acc + q.value, 0);
  grandTotalAllocated = initialTotalPactado + currentNormalSum;
  const finalDifference = grandTotalAllocated - totalValue;

  return {
    contractId,
    totalValue,
    initialTotalPactado,
    normalTotalPactado,
    grandTotalAllocated,
    difference: finalDifference,
    isBalanced: Math.abs(finalDifference) < 1,
    totalPaidSoFar,
    warnings,
    simulatedQuotas: [
      ...initialQuotas.map(q => ({
        _id: q._id ? q._id.toString() : null,
        number: q.number,
        type: q.type,
        dueDate: q.dueDate,
        value: q.value,
        status: q.status,
        amountPaid: q.amountPaid || 0,
        isPaidOrPartial: true
      })),
      ...updatedNormalQuotas
    ]
  };
}

/**
 * Applies the user-approved schedule adjustment to the database in a Mongoose session transaction.
 */
export async function applyScheduleAdjustment({ contractId, tenantId, companyId, updatedQuotas, reason, auditUser }) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const contract = await Contract.findOne({ _id: contractId, tenantId, companyId }).session(session);
    if (!contract) {
      throw new AppError('Contrato no encontrado', 404);
    }

    const existingQuotas = await Quota.find({ contract: contract._id, tenantId, companyId }).session(session);
    validateAdjustment(contract, existingQuotas, updatedQuotas);
    const byId = new Map(existingQuotas.map((q) => [q._id.toString(), q]));

    for (const qData of updatedQuotas) {
      if (qData._id) {
        const existing = byId.get(String(qData._id));
        if (existing.status !== 'pagado') {
          existing.value = Number(qData.value);
          if (qData.dueDate) existing.dueDate = new Date(qData.dueDate);
          // Lowering a partially paid quota to what it already received settles it
          if (existing.amountPaid > 0 && existing.amountPaid >= existing.value) existing.status = 'pagado';
          await existing.save({ session });
        }
      } else {
        await Quota.create([{
          tenantId,
          companyId,
          contract: contractId,
          number: qData.number,
          type: qData.type || 'normal',
          value: Number(qData.value),
          dueDate: new Date(qData.dueDate),
          status: 'pendiente'
        }], { session });
      }
    }

    const normalCount = updatedQuotas.filter(q => q.type === 'normal').length;
    contract.installmentsCount = normalCount;

    if (reason) {
      const dateStr = new Date().toLocaleDateString('es-CO');
      const noteEntry = `[${dateStr} - Reestructuración Cuotas]: ${reason}`;
      contract.observations = contract.observations ? `${contract.observations} | ${noteEntry}` : noteEntry;
    }

    await contract.save({ session });

    await session.commitTransaction();
    session.endSession();

    return { success: true, message: 'Plan de pagos reestructurado exitosamente', updatedQuotasCount: updatedQuotas.length };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
}

/**
 * Generates or completely rebuilds a contract payment schedule from scratch.
 * Handles setting new totalValue, installment count, installment value,
 * optional initial quotas, and balloon/extraordinary quotas every N months.
 */
export async function generateContractSchedule({
  contractId,
  tenantId,
  companyId,
  totalValue,
  installmentsCount,
  installmentValue,
  startDate,
  paymentDay = 15,
  balloonInterval,
  balloonValue,
  initialQuotasCount = 0,
  initialQuotaValue = 0,
  preserveExistingPayments = true,
  reason,
  auditUser
}) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const contract = await Contract.findOne({ _id: contractId, tenantId, companyId }).session(session);
    if (!contract) {
      throw new AppError('Contrato no encontrado', 404);
    }

    if (!isAmount(totalValue, { positive: true })) {
      throw new AppError('El valor total del contrato debe ser un número mayor a 0', 400);
    }
    if (!isQuotaCount(installmentsCount, 1)) {
      throw new AppError(`El número de cuotas debe ser un número entero entre 1 y ${MAX_QUOTAS}`, 400);
    }
    if (!isAmount(installmentValue, { positive: true })) {
      throw new AppError('El valor de la cuota debe ser un número mayor a 0', 400);
    }
    if (!isQuotaCount(initialQuotasCount || 0, 0) || !isAmount(initialQuotaValue || 0, { positive: false })) {
      throw new AppError('La cantidad y el valor de las cuotas iniciales deben ser números válidos', 400);
    }
    if (balloonInterval && (!isQuotaCount(balloonInterval, 1) || !isAmount(balloonValue, { positive: true }))) {
      throw new AppError('La periodicidad y el valor de las cuotas extraordinarias deben ser números válidos', 400);
    }
    if (paymentDay && !(Number.isInteger(Number(paymentDay)) && Number(paymentDay) >= 1 && Number(paymentDay) <= 31)) {
      throw new AppError('El día de pago debe estar entre 1 y 31', 400);
    }
    if (startDate && !isDate(startDate)) {
      throw new AppError('La fecha de inicio no es válida', 400);
    }

    const parsedTotalValue = Number(totalValue);
    const parsedInstallmentsCount = Number(installmentsCount);
    const parsedInstallmentValue = Number(installmentValue);
    initialQuotasCount = Number(initialQuotasCount || 0);
    initialQuotaValue = Number(initialQuotaValue || 0);

    // Existing quotas
    const existingQuotas = await Quota.find({ contract: contractId, tenantId, companyId }).session(session);
    const paidOrPartialQuotas = existingQuotas.filter(q => q.status === 'pagado' || (q.amountPaid && q.amountPaid > 0));

    // Quotas with money are never deleted: their payments and receipts point to them
    if (preserveExistingPayments === false && paidOrPartialQuotas.length > 0) {
      throw new AppError('Este contrato tiene cuotas con pagos: el plan nuevo las conserva y solo reemplaza las cuotas sin abonos', 400);
    }
    // A reported payment waiting for approval points to a quota that would be deleted
    const pendingReport = await PaymentAttempt.exists({ contractId: contract._id, tenantId, companyId, status: 'PENDIENTE' }).session(session);
    if (pendingReport) {
      throw new AppError('Este contrato tiene pagos reportados sin revisar: apruébelos o recháselos antes de generar el plan', 400);
    }

    // Remove only the quotas without payments
    const paidIds = paidOrPartialQuotas.map(q => q._id);
    await Quota.deleteMany({ contract: contractId, tenantId, companyId, _id: { $nin: paidIds } }).session(session);

    const baseStartDate = startDate ? new Date(startDate) : (contract.startDate || new Date());
    const quotasToInsert = [];

    // 1. Initial quotas if specified
    if (initialQuotasCount > 0 && initialQuotaValue > 0) {
      for (let i = 1; i <= initialQuotasCount; i++) {
        const existingPaid = paidOrPartialQuotas.find(q => q.type === 'inicial' && q.number === i);
        if (existingPaid) continue;

        const dueDate = new Date(baseStartDate);
        dueDate.setMonth(dueDate.getMonth() + (i - 1));
        if (paymentDay) dueDate.setDate(Math.min(paymentDay, 28));

        quotasToInsert.push({
          tenantId,
          companyId,
          contract: contractId,
          number: i,
          type: 'inicial',
          value: initialQuotaValue,
          dueDate,
          status: 'pendiente',
          amountPaid: 0
        });
      }
    }

    // 2. Normal / Extraordinary quotas
    for (let i = 1; i <= parsedInstallmentsCount; i++) {
      const existingPaid = paidOrPartialQuotas.find(q => q.type === 'normal' && q.number === i);
      if (existingPaid) continue;

      const dueDate = new Date(baseStartDate);
      dueDate.setMonth(dueDate.getMonth() + (initialQuotasCount || 0) + (i - 1));
      if (paymentDay) dueDate.setDate(Math.min(paymentDay, 28));

      let qVal = parsedInstallmentValue;
      // If balloonInterval is provided and i is a multiple of balloonInterval
      if (balloonInterval && balloonValue && i % Number(balloonInterval) === 0) {
        qVal = Number(balloonValue);
      }

      quotasToInsert.push({
        tenantId,
        companyId,
        contract: contractId,
        number: i,
        type: 'normal',
        value: qVal,
        dueDate,
        status: 'pendiente',
        amountPaid: 0
      });
    }

    if (quotasToInsert.length > 0) {
      await Quota.insertMany(quotasToInsert, { session });
    }

    // Update contract metadata
    contract.totalValue = parsedTotalValue;
    contract.installmentsCount = parsedInstallmentsCount;
    contract.installmentValue = parsedInstallmentValue;
    if (startDate) contract.startDate = new Date(startDate);
    if (paymentDay) contract.paymentDay = paymentDay;
    if (initialQuotasCount) contract.initialQuotasCount = initialQuotasCount;

    if (reason) {
      const dateStr = new Date().toLocaleDateString('es-CO');
      const noteEntry = `[${dateStr} - Estructuración Contrato]: ${reason}`;
      contract.observations = contract.observations ? `${contract.observations} | ${noteEntry}` : noteEntry;
    }

    await contract.save({ session });

    await session.commitTransaction();
    session.endSession();

    return {
      success: true,
      message: `Plan de financiación generado exitosamente con ${quotasToInsert.length} cuotas nuevas`,
      totalValue: parsedTotalValue,
      quotasCreated: quotasToInsert.length
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
}

