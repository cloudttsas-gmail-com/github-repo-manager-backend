import Quota from '../models/Quota.js';
import Contract from '../models/Contract.js';
import Client from '../models/Client.js';
import Company from '../models/Company.js';
import Lot from '../models/Lot.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import { getNextSequence } from '../models/Counter.js';
import AppError from '../utils/AppError.js';
import { sendEmail } from '../utils/notifications.js';
import { sendCompanyNotice, money, shortDate, propertyName } from '../services/whatsappTemplates.service.js';
import { logAudit } from '../utils/auditLogger.js';
import { generateSiigoExcel } from '../utils/siigoExport.js';
import { publicLinkUrl, signReceiptUrl } from '../utils/publicLinks.js';
import { parseBusinessDate } from '../utils/dates.js';
import { resolveBankChoice } from '../utils/bankAccounts.js';
import { claimPaymentRequest } from '../utils/idempotency.js';
import { recalculatePlanAfterInitialPayment } from '../services/paymentPlan.service.js';
import { applyPaymentToQuotas, isAppliedToQuotas, revertAppliedPayment } from '../services/paymentApplication.service.js';
import { parsePositiveAmount } from '../utils/math.js';

/**
 * Get all quotas (payments) for a given company with server-side pagination and filtering.
 * Uses the Quota model since each quota represents a payment record.
 */
export const getPayments = async (req, res, next) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    // The listing no longer creates payments from quotas with money and no payment: those
    // quotas are now mostly the cascade of an approval, and it created phantom payments

    const { page = 1, limit = 12, search, status, sortBy, order } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build dynamic sort
    let sortObj = { fechaPago: -1, status: -1, createdAt: -1 }; // Default: sorted by payment date
    if (sortBy) {
      const sortField = {
        'amount': 'amount',
        'cuotaNumber': 'createdAt', // Default sorting for populated/calculated values to createdAt
        'fechaPago': 'fechaPago',
        'status': 'status',
        'createdAt': 'createdAt',
      }[sortBy] || sortBy;

      sortObj = { [sortField]: order === 'asc' ? 1 : -1 };
    }

    // Base filter by tenant and company
    let query = { 
      tenantId, 
      companyId,
    };

    // If seller/executive role, restrict to their own sales' attempts
    if (role === 'vendedor' || role === 'ejecutivo_comercial' || role === 'agent') {
      const sellerContracts = await Contract.find({ tenantId, companyId, sellerId: userId }).select('_id');
      query.contractId = { $in: sellerContracts.map((c) => c._id) };
    }

    const scope = { ...query };

    // Map frontend status names to PaymentAttempt status values
    if (status && status !== 'ALL') {
      const statusMap = {
        'PENDIENTE': 'PENDIENTE',
        'PAGADO': 'APROBADO',
        'RECHAZADO': 'RECHAZADO',
      };
      const requestedStatus = statusMap[status] || status.toUpperCase();
      query.status = requestedStatus;
    }

    // Search by client name or idNumber
    if (search && search.trim()) {
      const matchingClients = await Client.find({
        tenantId,
        companyId,
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { idNumber: { $regex: search, $options: 'i' } },
        ],
      }).select('_id');

      query.clientId = { $in: matchingClients.map((c) => c._id) };
      scope.clientId = query.clientId;
    }

    // The Pendientes and Pagados cards count every payment of the search, whatever status is shown
    const [total, pendingCount, approvedCount, rejectedCount] = await Promise.all([
      PaymentAttempt.countDocuments(query),
      PaymentAttempt.countDocuments({ ...scope, status: 'PENDIENTE' }),
      PaymentAttempt.countDocuments({ ...scope, status: 'APROBADO' }),
      PaymentAttempt.countDocuments({ ...scope, status: 'RECHAZADO' }),
    ]);
    const attempts = await PaymentAttempt.find(query)
      .populate({
        path: 'contractId',
        populate: {
          path: 'lot',
          select: 'lotNumber stage nomenclature area manzana',
        },
      })
      .populate('clientId', 'name idNumber phone')
      .populate('quotas.quotaId', 'number type receiptUrl receiptNumber value')
      .sort(sortObj)
      .skip(skip)
      .limit(limitNum)
      .lean();

    // Format for frontend expectations
    const formattedPayments = attempts.map((qObj) => {
      const firstQuota = qObj.quotas?.[0]?.quotaId;

      return {
        id: qObj._id,
        cuotaNumber: firstQuota?.number || 0,
        receiptNumber: qObj.receiptNumber || firstQuota?.receiptNumber || null,
        amount: qObj.amount || 0,
        paymentType: qObj.paymentType || 'TOTAL',
        quotaValue: qObj.quotaValue || firstQuota?.value || null,
        banco: qObj.banco || 'N/A',
        fechaPago: qObj.fechaPago || qObj.createdAt,
        comprobante: qObj.comprobante || null,
        status: qObj.status === 'APROBADO' ? 'PAGADO' : (qObj.status === 'RECHAZADO' ? 'RECHAZADO' : 'PENDIENTE'),
        observacion: qObj.status === 'RECHAZADO' ? (qObj.rejectedReason || '') : '',
        observations: qObj.observations || '',
        rejectedReason: qObj.rejectedReason || '',
        type: firstQuota?.type || 'normal',
        contract: {
          client: {
            fullName: qObj.clientId?.name || 'Sin nombre',
            cedula: qObj.clientId?.idNumber || '',
            phone: qObj.clientId?.phone || '',
          },
          lot: {
            project: {
              name: qObj.contractId?.lot?.stage || 'Sin proyecto',
            },
            manzana: qObj.contractId?.lot?.manzana || '-',
            nomenclatura: qObj.contractId?.lot?.nomenclature || '-',
            lotNumber: qObj.contractId?.lot?.lotNumber || '-',
          },
        },
        createdAt: qObj.createdAt,
        updatedAt: qObj.updatedAt,
        receiptUrl: signReceiptUrl(firstQuota?.receiptUrl) || null,
      };
    });

    res.json({
      success: true,
      data: {
        payments: formattedPayments,
        statusCounts: { PENDIENTE: pendingCount, PAGADO: approvedCount, RECHAZADO: rejectedCount },
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Helper to send payment notifications (SMS and Email)
 */
const sendPaymentNotifications = async (req, quotaId, companyId) => {
  const fullQuota = await Quota.findById(quotaId).populate({
    path: 'contract',
    populate: [
      { path: 'client' },
      { path: 'lot' },
    ],
  });
  
  const company = await Company.findById(companyId);
  
  if (fullQuota && fullQuota.contract && fullQuota.contract.client) {
    const apiUrl = process.env.API_URL || `${req.protocol}://${req.get('host')}`;
    const receiptUrl = publicLinkUrl('receipt', quotaId, apiUrl);
    const statementUrl = publicLinkUrl('statement', fullQuota.contract._id, apiUrl);
    
    // Update quota with receiptUrl if not set
    if (fullQuota.receiptUrl !== receiptUrl) {
      await Quota.findByIdAndUpdate(quotaId, { receiptUrl });
    }
    
    // WhatsApp from the company's number, with the receipt attached
    const clientPhone = fullQuota.contract.client.phone;
    if (clientPhone) {
      await sendCompanyNotice({
        company,
        to: clientPhone,
        notice: 'pago_recibido',
        values: {
          clientName: fullQuota.contract.client.name,
          companyName: company?.name || 'su inmobiliaria',
          amount: money(fullQuota.amountPaid || fullQuota.value),
          date: shortDate(fullQuota.paymentDate || new Date()),
          property: propertyName(fullQuota.contract.lot, company?.propertyType),
          receiptNumber: fullQuota.receiptNumber,
          receiptUrl,
          statementUrl,
        },
      });
    }

    // Send Email
    const clientEmail = fullQuota.contract.client.email;
    if (clientEmail) {
      const subject = `Recibo de Pago: Cuota #${fullQuota.number} - ${company?.name || 'Recaudos'}`;
      const htmlMessage = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
          <h2 style="color: #007cba;">Confirmación de Pago</h2>
          <p>Hola <strong>${fullQuota.contract.client.name}</strong>,</p>
          <p>Te enviamos el recibo oficial de tu pago de la cuota <strong>#${fullQuota.number}</strong> y tu estado de cuenta actualizado.</p>
          
          <div style="background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Monto:</strong> $${(fullQuota.amountPaid || fullQuota.value).toLocaleString('es-CO', { maximumFractionDigits: 0 })}</p>
            <p style="margin: 5px 0 0 0;"><strong>Concepto:</strong> Pago de cuota - ${fullQuota.contract.lot?.stage || 'Proyecto'}</p>
          </div>

          <p>Puedes descargar tu recibo de caja oficial y consultar tu estado de cuenta en línea utilizando los siguientes botones:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${receiptUrl}" style="background: #007cba; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; margin: 5px; font-size: 14px;">
              VER RECIBO DE CAJA
            </a>
            <a href="${statementUrl}" style="background: #2e7d32; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; margin: 5px; font-size: 14px;">
              VER ESTADO DE CUENTA
            </a>
          </div>

          <p style="font-size: 12px; color: #777; border-top: 1px solid #eee; pt: 15px; margin-top: 25px;">
            Gracias por tu puntualidad.<br>
            <strong>${company?.name || 'Inmobiliaria'}</strong>
          </p>
        </div>
      `;
      await sendEmail(clientEmail, subject, htmlMessage);
    }
    return true;
  }
  return false;
};

const STATUS_LABELS = { APROBADO: 'aprobado', RECHAZADO: 'rechazado', PENDIENTE: 'pendiente' };

/**
 * Mark a PaymentAttempt as "APROBADO" and apply its amount to the target quotas in cascade.
 * Only a pending payment can be approved, and the change of status is atomic, so the same
 * payment cannot be approved twice or approved after being rejected.
 */
export const approvePayment = async (req, res, next) => {
  try {
    const { tenantId, companyId, userId } = req.user;
    const { id: attemptId } = req.params;
    const { observacion } = req.body;

    const attempt = await PaymentAttempt.findOne({ _id: attemptId, tenantId, companyId });
    if (!attempt) {
      return next(new AppError('Intento de pago no encontrado', 404));
    }
    if (attempt.status !== 'PENDIENTE') {
      return next(new AppError(`Este pago ya fue ${STATUS_LABELS[attempt.status] || 'procesado'}`, 400));
    }
    const entriesValid = attempt.quotas.length > 0 && attempt.quotas.every((q) => parsePositiveAmount(q.amount) !== null);
    if (!parsePositiveAmount(attempt.amount) || !entriesValid) {
      return next(new AppError('El monto de este pago no es válido. Recházalo y pide al cliente que lo reporte de nuevo.', 400));
    }

    // Claim the payment atomically before touching any quota
    const claimed = await PaymentAttempt.findOneAndUpdate(
      { _id: attempt._id, tenantId, companyId, status: 'PENDIENTE' },
      { $set: { status: 'APROBADO', approvedBy: userId, approvedAt: new Date(), ...(observacion ? { observations: observacion } : {}) } },
      { new: true },
    );
    if (!claimed) {
      return next(new AppError('Este pago ya fue procesado por otra persona', 409));
    }

    const applied = [];
    const notifyQuotaIds = [];
    let unapplied = 0;
    try {
      if (!claimed.receiptNumber) {
        claimed.receiptNumber = await getNextSequence(companyId, tenantId, 'RECEIPT');
      }

      if (isAppliedToQuotas(attempt)) {
        // A payment created from quotas that already had the money (legacy migration):
        // approving it only confirms it
        applied.push(...attempt.quotas.map((q) => ({ quotaId: q.quotaId, amount: q.amount })));
        notifyQuotaIds.push(...attempt.quotas.map((q) => q.quotaId));
        await Quota.updateMany(
          { _id: { $in: notifyQuotaIds }, tenantId, companyId },
          { $set: { receiptNumber: claimed.receiptNumber } },
        );
      } else {
        for (const entry of attempt.quotas) {
          const startQuota = await Quota.findOne({ _id: entry.quotaId, tenantId, companyId, contract: attempt.contractId });
          if (!startQuota) {
            throw new AppError('Una de las cuotas de este pago ya no existe. Recházalo y registra el pago de nuevo.', 400);
          }
          const result = await applyPaymentToQuotas({
            startQuota,
            amount: entry.amount,
            tenantId,
            companyId,
            applied,
            payment: {
              bank: claimed.banco,
              method: claimed.paymentMethod,
              observations: claimed.observations,
              date: claimed.fechaPago || new Date(),
              capture: claimed.comprobante,
              receiptNumber: claimed.receiptNumber,
            },
          });
          notifyQuotaIds.push(...result.notifyQuotaIds);
          unapplied += result.unapplied;
        }
      }

      // The payment records every quota it reached, cascade included, so rejecting,
      // editing, the receipt and Siigo use what was really applied
      claimed.quotas = applied;
      claimed.appliedToQuotas = true;
      claimed.unappliedAmount = unapplied;
      await claimed.save();
    } catch (applyError) {
      // Leave the payment as it was: pending and off the quotas
      await revertAppliedPayment({ entries: applied, tenantId, companyId });
      const original = attempt.toObject();
      await PaymentAttempt.collection.updateOne(
        { _id: attempt._id },
        {
          $set: { status: 'PENDIENTE', quotas: original.quotas, observations: original.observations },
          $unset: { approvedBy: 1, approvedAt: 1 },
        },
      );
      throw applyError;
    }

    // Initial quota fully paid: the ordinary quotas follow its completion date (new plan rules only)
    await recalculatePlanAfterInitialPayment({ contractId: claimed.contractId, tenantId, companyId, req });

    // Evaluate commission milestones (comisiones Fase 3)
    try {
      const { evaluateCommissionMilestones } = await import('../services/commission.service.js');
      await evaluateCommissionMilestones({ contractId: claimed.contractId, tenantId, companyId });
    } catch (commissionError) {
      console.error('[LOG][APPROVE_PAYMENT] Error evaluando hitos de comisión:', commissionError);
    }

    // Send notifications
    try {
      const { sendConsolidatedPaymentNotifications } = await import('../utils/consolidatedNotifications.js');
      await sendConsolidatedPaymentNotifications(req, notifyQuotaIds, companyId, claimed);
    } catch (notificationError) {
      console.error('[LOG][APPROVE_PAYMENT] Error al enviar notificaciones consolidadas:', notificationError);
    }

    await logAudit(req, {
      action: 'APPROVE_PAYMENT',
      module: 'PAYMENTS',
      targetId: claimed._id,
      details: { amount: claimed.amount, quotasCount: applied.length, unappliedAmount: unapplied },
    });

    res.json({
      success: true,
      message: unapplied > 0
        ? `Pago aprobado. $${unapplied.toLocaleString('es-CO')} superan el saldo del contrato y quedaron sin aplicar a ninguna cuota.`
        : 'Intento de pago aprobado y cuotas actualizadas exitosamente',
    });
  } catch (error) {
    console.error('[LOG][APPROVE_PAYMENT] Error crítico en aprobación:', error);
    next(error);
  }
};

// A rejected or edited payment may undo the quota that earned a seller's commission
const revokeCommissionsAfterRevert = async ({ attempt, tenantId, companyId, entries }) => {
  try {
    const { revokeUnmetCommissionMilestones } = await import('../services/commission.service.js');
    return await revokeUnmetCommissionMilestones({
      contractId: attempt.contractId,
      tenantId,
      companyId,
      revertedQuotaIds: (entries || []).map((e) => e.quotaId?._id || e.quotaId).filter(Boolean),
    });
  } catch (commissionError) {
    console.error('[LOG][COMMISSIONS] Error revisando comisiones tras revertir un pago:', commissionError);
    return { revoked: [], toReview: [] };
  }
};

const commissionWarning = ({ revoked, toReview }) => {
  const parts = [];
  if (revoked.length) parts.push(`${revoked.length} comisión(es) del asesor volvieron a pendiente porque la cuota ya no está pagada`);
  if (toReview.length) parts.push(`${toReview.length} comisión(es) ya radicada(s) o aprobada(s) dependen de esta cuota: revíselas en Comisiones`);
  return parts.length ? `${parts.join('. ')}.` : null;
};

/**
 * Mark a pending PaymentAttempt as "RECHAZADO" (rejected).
 * A client report was never applied to its quotas, so rejecting it leaves them untouched.
 * An approved payment is corrected with "Editar", not rejected.
 */
export const rejectPayment = async (req, res, next) => {
  try {
    const { tenantId, companyId, userId } = req.user;
    const { id: attemptId } = req.params;
    const { rejectedReason, observacion } = req.body;

    const attempt = await PaymentAttempt.findOne({ _id: attemptId, tenantId, companyId });
    if (!attempt) {
      return next(new AppError('Intento de pago no encontrado', 404));
    }
    if (attempt.status !== 'PENDIENTE') {
      return next(new AppError(`Este pago ya fue ${STATUS_LABELS[attempt.status] || 'procesado'}. Un pago aprobado se corrige con «Editar».`, 400));
    }

    const claimed = await PaymentAttempt.findOneAndUpdate(
      { _id: attempt._id, tenantId, companyId, status: 'PENDIENTE' },
      {
        $set: {
          status: 'RECHAZADO',
          rejectedReason: rejectedReason || observacion || 'Rechazado por el administrador',
          rejectedBy: userId,
          rejectedAt: new Date(),
          appliedToQuotas: false,
        },
      },
      { new: true },
    );
    if (!claimed) {
      return next(new AppError('Este pago ya fue procesado por otra persona', 409));
    }

    // Only a pending payment created from quotas that already had the money takes it back
    const reverted = isAppliedToQuotas(attempt);
    let commissions = { revoked: [], toReview: [] };
    if (reverted) {
      await revertAppliedPayment({ entries: attempt.quotas, tenantId, companyId });
      commissions = await revokeCommissionsAfterRevert({ attempt, tenantId, companyId, entries: attempt.quotas });
    }

    await logAudit(req, {
      action: 'REJECT_PAYMENT',
      module: 'PAYMENTS',
      targetId: claimed._id,
      details: {
        amount: claimed.amount,
        rejectedReason: claimed.rejectedReason,
        revertedQuotas: reverted,
        commissionsRevoked: commissions.revoked,
        commissionsToReview: commissions.toReview,
      },
    });

    res.json({
      success: true,
      message: 'Pago rechazado',
      data: { commissionWarning: commissionWarning(commissions) },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Manually register a payment for a quota (Auto-approved)
 */
export const registerManualPayment = async (req, res, next) => {
  let releaseRequest = async () => {};
  let quotasChanged = false;
  try {
    const { tenantId, companyId } = req.user;
    const { quotaId, amount, bank, bankAccountId, observations, paymentDate, fechaPago, paymentMethod, paymentOption, requestId } = req.body;

    // Cash and account crosses are open to everyone who may register payments (decided 8 Nov)
    const file = req.file;

    console.log('[LOG][REGISTER_MANUAL_PAYMENT] Solicitud de pago manual recibida:', {
      quotaId,
      amount,
      bank,
      observations,
      paymentDate,
      fechaPago,
      paymentMethod,
      tenantId,
      companyId,
      hasFile: !!file
    });

    // Use regular Quota.findOne with companyId for scoping
    const quota = await Quota.findOne({ _id: quotaId, tenantId, companyId });
    if (!quota) {
      console.warn('[LOG][REGISTER_MANUAL_PAYMENT] Error: Cuota no encontrada para el ID y empresa provistos:', { quotaId, companyId });
      return next(new AppError('Cuota no encontrada', 404));
    }

    // Validate everything that can fail before any quota changes, and claim the
    // form's operation id so a double click cannot record the payment twice
    // Only cash or an account cross may come without a bank; a transfer without one
    // used to be recorded as cash
    const isCash = paymentMethod === 'Efectivo' || String(bank || '').toUpperCase() === 'EFECTIVO';
    const isCross = paymentMethod === 'Cruce de cuentas' || bank === 'Cruce de cuentas';
    if (!bank && !bankAccountId && !isCash && !isCross) {
      return next(new AppError('Indica el banco o la cuenta a la que llegó el pago', 400));
    }
    const paidAmount = parsePositiveAmount(amount);
    if (paidAmount === null) {
      return next(new AppError('El monto del pago debe ser un número mayor a 0', 400));
    }
    const fallbackBank = isCash ? 'Efectivo' : 'Cruce de cuentas';
    const bankChoice = await resolveBankChoice(companyId, { bankAccountId, bank: bank || fallbackBank });
    releaseRequest = await claimPaymentRequest(`manual:${companyId}`, requestId);

    console.log('[LOG][REGISTER_MANUAL_PAYMENT] Cuota inicial encontrada para registrar pago:', {
      quotaId: quota._id,
      contract: quota.contract,
      number: quota.number,
      value: quota.value,
      status: quota.status,
      amountPaid: quota.amountPaid
    });

    let captureUrl = null;
    if (file) {
      const { uploadToR2 } = await import('../utils/storage.js');
      captureUrl = await uploadToR2(file, 'payments');
      console.log('[LOG][REGISTER_MANUAL_PAYMENT] Archivo subido exitosamente:', captureUrl);
    }

    const finalPaymentDate = parseBusinessDate(paymentDate || fechaPago);
    console.log('[LOG][REGISTER_MANUAL_PAYMENT] Fecha determinada para registro de pago:', finalPaymentDate);
    // From here on quotas change: a failure must not free the operation id for a retry
    quotasChanged = true;

    // Generate atomic receipt number for this manual payment
    const manualReceiptNumber = await getNextSequence(companyId, tenantId, 'RECEIPT');

    // Admin payments are auto-approved. If there is a payment excess, it cascades sequentially.
    const quotaPendingValue = quota.value - (quota.amountPaid || 0);
    const { applied: quotasToRecord, notifyQuotaIds: paidQuotasAccumulator, unapplied } = await applyPaymentToQuotas({
      startQuota: quota,
      amount: paidAmount,
      tenantId,
      companyId,
      payment: {
        bank: bankChoice.banco,
        method: paymentMethod,
        observations,
        date: finalPaymentDate,
        capture: captureUrl,
        receiptNumber: manualReceiptNumber,
      },
    });

    // Immediately create the PaymentAttempt as approved
    let manualAttempt = null;
    try {
      const contract = await Contract.findById(quota.contract);
      const OPTION_TO_TYPE = { minimo: 'MINIMO', total: 'TOTAL', otro: 'OTRO' };
      manualAttempt = await PaymentAttempt.create({
        tenantId,
        companyId,
        contractId: contract._id,
        clientId: contract.client,
        quotas: quotasToRecord,
        amount: paidAmount,
        paymentType: OPTION_TO_TYPE[paymentOption] || (paidAmount >= quotaPendingValue ? 'TOTAL' : 'PARCIAL'),
        quotaValue: quota.value,
        ...bankChoice,
        paymentMethod: paymentMethod || 'Efectivo',
        fechaPago: finalPaymentDate,
        comprobante: captureUrl || undefined,
        observations: observations,
        receiptNumber: manualReceiptNumber,
        appliedToQuotas: true,
        unappliedAmount: unapplied,
        status: 'APROBADO',
        approvedBy: req.user.userId,
        approvedAt: new Date()
      });
    } catch (attemptError) {
      console.error('[LOG][REGISTER_MANUAL_PAYMENT] Error creating PaymentAttempt:', attemptError);
    }

    // Initial quota fully paid: the ordinary quotas follow its completion date (new plan rules only)
    await recalculatePlanAfterInitialPayment({ contractId: quota.contract, tenantId, companyId, req });

    try {
      const { sendConsolidatedPaymentNotifications } = await import('../utils/consolidatedNotifications.js');
      await sendConsolidatedPaymentNotifications(req, paidQuotasAccumulator, companyId, manualAttempt);
    } catch (error) {
      console.error('[LOG][REGISTER_MANUAL_PAYMENT] Error sending consolidated notifications:', error);
    }

    // Activate commission milestones after a manual payment (quota inicial or quota #N paid)
    try {
      const { evaluateCommissionMilestones } = await import('../services/commission.service.js');
      await evaluateCommissionMilestones({ contractId: quota.contract, tenantId, companyId });
    } catch (error) {
      console.error('[LOG][REGISTER_MANUAL_PAYMENT] Error evaluando hitos de comisión:', error);
    }

    await logAudit(req, {
      action: 'REGISTER_MANUAL_PAYMENT',
      module: 'PAYMENTS',
      targetId: quota._id,
      details: { 
        amount: quota.amountPaid, 
        bank, 
        cuotaNumber: quota.number,
        paymentMethod,
        approvedCount: paidQuotasAccumulator.length
      }
    });

    res.json({
      success: true,
      message: 'Pago registrado y aprobado exitosamente',
    });
  } catch (error) {
    if (!quotasChanged) await releaseRequest();
    console.error('[LOG][REGISTER_MANUAL_PAYMENT] Error crítico:', error);
    next(error);
  }
};

/**
 * Resend payment receipt to client
 */
export const resendReceipt = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const { id: paramId } = req.params;

    let quota = await Quota.findOne({ _id: paramId, tenantId, companyId });

    if (!quota) {
      // Check if paramId belongs to a PaymentAttempt
      const attempt = await PaymentAttempt.findOne({ _id: paramId, tenantId, companyId });
      if (attempt) {
        if (attempt.status !== 'APROBADO') {
          return next(new AppError('Solo se pueden reenviar recibos de pagos aprobados', 400));
        }
        const quotaId = attempt.quotas?.[0]?.quotaId;
        if (quotaId) {
          quota = await Quota.findOne({ _id: quotaId, tenantId, companyId });
        }
      }
    }

    if (!quota) {
      return next(new AppError('Pago no encontrado', 404));
    }

    if (quota.status !== 'pagado') {
      return next(new AppError('Solo se pueden reenviar recibos de pagos aprobados', 400));
    }

    const sent = await sendPaymentNotifications(req, quota._id, companyId);
    
    if (!sent) {
      return next(new AppError('No se pudo enviar el recibo. Verifique que el cliente tenga datos de contacto.', 400));
    }

    await logAudit(req, {
      action: 'RESEND_RECEIPT',
      module: 'PAYMENTS',
      targetId: quota._id,
      details: { cuotaNumber: quota.number }
    });

    res.json({
      success: true,
      message: 'Recibo reenviado exitosamente',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Export approved payments as a Siigo Excel file
 */
export const exportSiigoExcel = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const { 
      startDate, 
      endDate, 
      comprobanteTipo = '14', 
      cuentaCartera = '13050502', 
      centroCostos = '001', 
      defaultCuentaBanco = '11200501' 
    } = req.query;

    const query = {
      tenantId,
      companyId,
      status: 'APROBADO'
    };

    // The range is in Bogotá days: a date-only value covers that whole day in Colombia
    const dayBound = (value, time) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T${time}-05:00`) : new Date(value));
    if (startDate || endDate) {
      query.fechaPago = {};
      if (startDate) {
        query.fechaPago.$gte = dayBound(startDate, '00:00:00.000');
      }
      if (endDate) {
        query.fechaPago.$lte = dayBound(endDate, '23:59:59.999');
      }
    }

    // Load company config for bank accounts
    const company = await Company.findOne({ _id: companyId, tenantId }).select('bankAccounts');

    // Fetch and populate payment attempts
    const attempts = await PaymentAttempt.find(query)
      .populate({
        path: 'contractId',
        populate: [
          { path: 'client', select: 'name idNumber' },
          { path: 'lot', select: 'lotNumber stage manzana propertyType tower floor' },
          { path: 'companyId', select: 'name' }
        ]
      })
      .populate('clientId', 'name idNumber')
      .populate('quotas.quotaId')
      .sort({ fechaPago: 1 });

    const buffer = generateSiigoExcel(attempts, {
      comprobanteTipo,
      cuentaCartera,
      centroCostos,
      defaultCuentaBanco,
      companyBankAccounts: company ? company.bankAccounts : []
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=siigo-import-pagos.xlsx');
    res.send(buffer);
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Edit an existing payment (reversing prior quota applications and reapplying with the new amount/data).
 */
export const editPayment = async (req, res, next) => {
  try {
    const { tenantId, companyId, userId } = req.user;
    const { id: attemptId } = req.params;
    const { amount, bank, bankAccountId, paymentMethod, paymentDate, observations, reason } = req.body;

    const attempt = await PaymentAttempt.findOne({ _id: attemptId, tenantId, companyId });
    if (!attempt) {
      return next(new AppError('Intento de pago no encontrado', 404));
    }
    // Only an approved payment is on the quotas; a pending one is approved or rejected first
    if (attempt.status !== 'APROBADO') {
      return next(new AppError('Solo se pueden editar pagos aprobados. Aprueba o rechaza primero este pago.', 400));
    }

    const oldAmount = attempt.amount;
    const newAmount = amount !== undefined && amount !== null && amount !== '' ? parsePositiveAmount(amount) : oldAmount;

    if (newAmount === null) {
      return next(new AppError('El nuevo monto del pago debe ser un número válido mayor a 0', 400));
    }
    const bankChoice = bankAccountId ? await resolveBankChoice(companyId, { bankAccountId }) : null;

    // 1. Take back everything this payment applied, cascade included
    const previousEntries = attempt.quotas.map((q) => ({ quotaId: q.quotaId, amount: q.amount }));
    await revertAppliedPayment({ entries: attempt.quotas, tenantId, companyId });

    // 2. The payment is applied again from the quota it was made for
    const primaryQuotaId = attempt.quotas.length > 0 ? attempt.quotas[0].quotaId : null;
    let primaryQuota = primaryQuotaId ? await Quota.findOne({ _id: primaryQuotaId, tenantId, companyId }) : null;

    if (!primaryQuota) {
      // Fallback to first pending quota of the contract
      primaryQuota = await Quota.findOne({ contract: attempt.contractId, tenantId, companyId, status: { $in: ['pendiente', 'mora'] } }).sort({ type: 1, number: 1 });
    }

    if (!primaryQuota) {
      return next(new AppError('No se encontró una cuota asociada al contrato para aplicar el pago', 404));
    }

    const finalBank = bankChoice?.banco || bank || attempt.banco || 'Efectivo';
    const finalMethod = paymentMethod || attempt.paymentMethod || 'Efectivo';
    const finalDate = parseBusinessDate(paymentDate, attempt.fechaPago || new Date());
    const finalObservations = observations !== undefined ? observations : attempt.observations;
    const finalReceiptNumber = attempt.receiptNumber || (await getNextSequence(companyId, tenantId, 'RECEIPT'));

    // 3. Re-apply the newAmount in cascade starting from primaryQuota
    const { applied: newQuotasToRecord, unapplied } = await applyPaymentToQuotas({
      startQuota: primaryQuota,
      amount: newAmount,
      tenantId,
      companyId,
      payment: {
        bank: finalBank,
        method: finalMethod,
        observations: finalObservations,
        date: finalDate,
        capture: attempt.comprobante,
        receiptNumber: finalReceiptNumber,
      },
    });

    // 4. Update the PaymentAttempt document
    attempt.amount = newAmount;
    if (bankChoice) attempt.bankAccountId = bankChoice.bankAccountId;
    else if (bank && bank !== attempt.banco) attempt.bankAccountId = null;
    attempt.banco = finalBank;
    attempt.paymentMethod = finalMethod;
    attempt.fechaPago = finalDate;
    attempt.observations = finalObservations;
    attempt.quotas = newQuotasToRecord;
    attempt.appliedToQuotas = true;
    attempt.unappliedAmount = unapplied;
    attempt.receiptNumber = finalReceiptNumber;
    attempt.editedBy = userId;
    attempt.editedAt = new Date();
    attempt.editReason = reason || 'Ajuste administrativo de monto/datos';
    await attempt.save();

    // Initial quota fully paid: the ordinary quotas follow its completion date (new plan rules only)
    await recalculatePlanAfterInitialPayment({ contractId: primaryQuota.contract, tenantId, companyId, req });

    // 5. Milestones the lower amount no longer meets go back to pending; new ones are activated
    const commissions = await revokeCommissionsAfterRevert({ attempt, tenantId, companyId, entries: previousEntries });
    try {
      const { evaluateCommissionMilestones } = await import('../services/commission.service.js');
      await evaluateCommissionMilestones({ contractId: attempt.contractId, tenantId, companyId });
    } catch (commissionError) {
      console.error('[LOG][EDIT_PAYMENT] Error evaluando hitos de comisión:', commissionError);
    }

    await logAudit(req, {
      action: 'EDIT_PAYMENT',
      module: 'PAYMENTS',
      targetId: attempt._id,
      details: {
        oldAmount,
        newAmount,
        reason: attempt.editReason,
        affectedQuotasCount: newQuotasToRecord.length,
        commissionsRevoked: commissions.revoked,
        commissionsToReview: commissions.toReview,
      }
    });

    res.json({
      success: true,
      message: 'Pago corregido y cuotas recalculadas exitosamente',
      data: {
        paymentId: attempt._id,
        newAmount,
        receiptNumber: finalReceiptNumber,
        affectedQuotas: newQuotasToRecord,
        commissionWarning: commissionWarning(commissions),
      }
    });
  } catch (error) {
    console.error('[LOG][EDIT_PAYMENT] Error editando pago:', error);
    next(error);
  }
};


