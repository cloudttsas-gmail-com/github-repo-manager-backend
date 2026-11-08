import mongoose from 'mongoose';
import Quota from '../models/Quota.js';
import Contract from '../models/Contract.js';
import Client from '../models/Client.js';
import Company from '../models/Company.js';
import Lot from '../models/Lot.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import { getNextSequence } from '../models/Counter.js';
import AppError from '../utils/AppError.js';
import { sendEmail, sendWhatsApp } from '../utils/notifications.js';
import { logAudit } from '../utils/auditLogger.js';
import { generateSiigoExcel } from '../utils/siigoExport.js';
import { publicLinkUrl, signReceiptUrl } from '../utils/publicLinks.js';
import { parseBusinessDate } from '../utils/dates.js';
import { resolveBankChoice } from '../utils/bankAccounts.js';
import { claimPaymentRequest } from '../utils/idempotency.js';
import { recalculatePlanAfterInitialPayment } from '../services/paymentPlan.service.js';

const migrateLegacyPayments = async (tenantId, companyId) => {
  try {
    const legacyQuotas = await Quota.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          companyId: new mongoose.Types.ObjectId(companyId),
          $or: [
            { paymentCapture: { $ne: null } },
            { paymentBank: { $ne: null } },
            { paymentDate: { $ne: null } },
            { amountPaid: { $gt: 0 } }
          ]
        }
      },
      {
        $lookup: {
          from: 'paymentattempts',
          localField: '_id',
          foreignField: 'quotas.quotaId',
          as: 'attempts'
        }
      },
      {
        $match: {
          attempts: { $size: 0 }
        }
      },
      {
        $limit: 12 // Process and migrate in small batches of 12
      }
    ]);

    for (const quota of legacyQuotas) {
      const contract = await Contract.findById(quota.contract);
      if (!contract) continue;

      await PaymentAttempt.create({
        tenantId: quota.tenantId,
        companyId: quota.companyId,
        contractId: contract._id,
        clientId: contract.client,
        quotas: [{
          quotaId: quota._id,
          amount: quota.amountPaid || quota.value || 0
        }],
        amount: quota.amountPaid || quota.value || 0,
        // The separation is recorded as paid at the sale, with no bank behind it
        banco: quota.paymentBank || (quota.type === 'inicial' && quota.number === 0 ? 'Registrada en la venta' : 'Desconocido'),
        paymentMethod: quota.paymentMethod || 'Transferencia bancaria',
        fechaPago: quota.paymentDate || quota.updatedAt || new Date(),
        comprobante: quota.paymentCapture,
        observations: quota.paymentObservations,
        status: quota.status === 'pagado' ? 'APROBADO' : 'PENDIENTE',
        createdAt: quota.paymentDate || quota.createdAt,
        updatedAt: quota.updatedAt
      });
    }
  } catch (err) {
    console.error('[LOG][MIGRATE_LEGACY_PAYMENTS] Error during auto-migration:', err);
  }
};

/**
 * Get all quotas (payments) for a given company with server-side pagination and filtering.
 * Uses the Quota model since each quota represents a payment record.
 */
export const getPayments = async (req, res, next) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    
    // Auto-migrate legacy payments to PaymentAttempt format (chunked migration)
    await migrateLegacyPayments(tenantId, companyId);

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
    }

    const total = await PaymentAttempt.countDocuments(query);
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
    
    // Send WhatsApp
    const clientPhone = fullQuota.contract.client.phone;
    if (clientPhone) {
      const message = `Cordial saludo ${fullQuota.contract.client.name}, su recibo de la cuota #${fullQuota.number} por $${(fullQuota.amountPaid || fullQuota.value).toLocaleString('es-CO', { maximumFractionDigits: 0 })} de ${company?.name || 'nuestra empresa'}. Ver recibo: ${receiptUrl} | Estado de Cuenta: ${statementUrl}`;
      await sendWhatsApp(clientPhone, message);
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

/**
 * Mark a PaymentAttempt as "APROBADO" and apply its amount to the target quotas in cascade.
 */
export const approvePayment = async (req, res, next) => {
  try {
    const { tenantId, companyId, userId } = req.user;
    const { id: attemptId } = req.params;
    const { observacion } = req.body;

    console.log('[LOG][APPROVE_PAYMENT] Solicitud de aprobación recibida para Intento de Pago:', {
      attemptId,
      tenantId,
      companyId,
      observacion
    });

    const attempt = await PaymentAttempt.findOne({ _id: attemptId, tenantId, companyId });
    if (!attempt) {
      console.warn('[LOG][APPROVE_PAYMENT] Error: Intento de pago no encontrado con ID:', attemptId);
      return next(new AppError('Intento de pago no encontrado', 404));
    }

    // Set operator observation
    attempt.observations = observacion || '';

    if (attempt.status === 'APROBADO') {
      console.warn('[LOG][APPROVE_PAYMENT] Advertencia: El intento de pago ya fue aprobado:', attemptId);
      return next(new AppError('Este intento de pago ya fue aprobado', 400));
    }

    if (!attempt.receiptNumber) {
      attempt.receiptNumber = await getNextSequence(companyId, tenantId, 'RECEIPT');
    }

    const paidQuotasAccumulator = [];

    // Process each target quota in the attempt
    for (const qEntry of attempt.quotas) {
      const qDoc = await Quota.findOne({ _id: qEntry.quotaId, tenantId, companyId });
      if (!qDoc) {
        console.warn(`[LOG][APPROVE_PAYMENT] Advertencia: Cuota ${qEntry.quotaId} no encontrada en intento de pago.`);
        continue;
      }

      // Calculate pending value of this target quota
      const qPendingValue = qDoc.value - (qDoc.amountPaid || 0);
      const amountToApply = qEntry.amount;

      if (amountToApply >= qPendingValue) {
        // Fully pay this quota
        qDoc.status = 'pagado';
        qDoc.amountPaid = qDoc.value;
        qDoc.paymentBank = attempt.banco;
        qDoc.paymentMethod = attempt.paymentMethod;
        qDoc.paymentObservations = attempt.observations;
        qDoc.paymentDate = attempt.fechaPago || new Date();
        qDoc.paymentCapture = attempt.comprobante;
        qDoc.receiptNumber = attempt.receiptNumber;
        await qDoc.save();
        paidQuotasAccumulator.push(qDoc._id);

        let excess = amountToApply - qPendingValue;
        if (excess > 0) {
          console.log(`[LOG][APPROVE_PAYMENT] Iniciando cascada de aprobación por exceso para cuota #${qDoc.number}. Excedente:`, excess);
          const queryFilter = {
            contract: qDoc.contract,
            tenantId,
            companyId,
            _id: { $nin: [...paidQuotasAccumulator, qDoc._id] },
            status: { $in: ['pendiente', 'mora'] }
          };

          const pendingQuotas = await Quota.find(queryFilter).sort({ type: 1, number: 1 });
          for (const pq of pendingQuotas) {
            if (excess <= 0) break;

            const pqPendingValue = pq.value - (pq.amountPaid || 0);
            if (excess >= pqPendingValue) {
              pq.status = 'pagado';
              pq.amountPaid = pq.value;
              pq.paymentBank = attempt.banco;
              pq.paymentMethod = attempt.paymentMethod;
              pq.paymentObservations = `${attempt.observations || ''} (Abono por excedente cuota #${qDoc.number})`;
              pq.paymentDate = attempt.fechaPago || new Date();
              pq.paymentCapture = attempt.comprobante;
              pq.receiptNumber = attempt.receiptNumber;
              await pq.save();
              paidQuotasAccumulator.push(pq._id);
              excess -= pqPendingValue;
            } else {
              pq.amountPaid = (pq.amountPaid || 0) + excess;
              pq.paymentBank = attempt.banco;
              pq.paymentMethod = attempt.paymentMethod;
              pq.paymentObservations = `${attempt.observations || ''} (Abono parcial por excedente cuota #${qDoc.number})`;
              pq.paymentDate = attempt.fechaPago || new Date();
              pq.paymentCapture = attempt.comprobante;
              pq.receiptNumber = attempt.receiptNumber;
              await pq.save();
              excess = 0;
            }
          }
        }
      } else {
        // Partially pay this quota
        qDoc.amountPaid = (qDoc.amountPaid || 0) + amountToApply;
        if (qDoc.amountPaid >= qDoc.value) {
          qDoc.status = 'pagado';
        }
        qDoc.paymentBank = attempt.banco;
        qDoc.paymentMethod = attempt.paymentMethod;
        qDoc.paymentObservations = attempt.observations;
        qDoc.paymentDate = attempt.fechaPago || new Date();
        qDoc.paymentCapture = attempt.comprobante;
        qDoc.receiptNumber = attempt.receiptNumber;
        await qDoc.save();
        paidQuotasAccumulator.push(qDoc._id);
      }
    }

    // Update attempt status
    attempt.status = 'APROBADO';
    attempt.approvedBy = userId;
    attempt.approvedAt = new Date();
    await attempt.save();

    // Initial quota fully paid: the ordinary quotas follow its completion date (new plan rules only)
    const touchedContractIds = await Quota.distinct('contract', { _id: { $in: attempt.quotas.map((q) => q.quotaId) }, tenantId, companyId });
    for (const contractId of touchedContractIds) {
      await recalculatePlanAfterInitialPayment({ contractId, tenantId, companyId, req });
    }

    // Evaluate commission milestones (comisiones Fase 3)
    try {
      const { evaluateCommissionMilestones } = await import('../services/commission.service.js');
      const affectedContractIds = await Quota.distinct('contract', { _id: { $in: paidQuotasAccumulator } });
      for (const contractId of affectedContractIds) {
        await evaluateCommissionMilestones({ contractId, tenantId, companyId });
      }
    } catch (commissionError) {
      console.error('[LOG][APPROVE_PAYMENT] Error evaluando hitos de comisión:', commissionError);
    }

    // Send notifications
    try {
      const { sendConsolidatedPaymentNotifications } = await import('../utils/consolidatedNotifications.js');
      await sendConsolidatedPaymentNotifications(req, paidQuotasAccumulator, companyId);
    } catch (notificationError) {
      console.error('[LOG][APPROVE_PAYMENT] Error al enviar notificaciones consolidadas:', notificationError);
    }

    await logAudit(req, {
      action: 'APPROVE_PAYMENT',
      module: 'PAYMENTS',
      targetId: attempt._id,
      details: { amount: attempt.amount, quotasCount: attempt.quotas.length, approvedCount: paidQuotasAccumulator.length }
    });

    res.json({
      success: true,
      message: 'Intento de pago aprobado y cuotas actualizadas exitosamente',
    });
  } catch (error) {
    console.error('[LOG][APPROVE_PAYMENT] Error crítico en aprobación:', error);
    next(error);
  }
};

/**
 * Mark a PaymentAttempt as "RECHAZADO" (rejected).
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

    // Rollback quota updates for all associated quotas
    for (const qEntry of attempt.quotas) {
      const qDoc = await Quota.findOne({ _id: qEntry.quotaId, tenantId, companyId });
      if (qDoc) {
        qDoc.amountPaid = Math.max(0, (qDoc.amountPaid || 0) - qEntry.amount);
        
        if (qDoc.amountPaid < qDoc.value) {
          const now = new Date();
          qDoc.status = qDoc.dueDate < now ? 'mora' : 'pendiente';
        }
        
        if (qDoc.amountPaid === 0) {
          qDoc.paymentBank = undefined;
          qDoc.paymentMethod = undefined;
          qDoc.paymentObservations = undefined;
          qDoc.paymentDate = undefined;
          qDoc.paymentCapture = undefined;
        }
        await qDoc.save();
      }
    }

    attempt.status = 'RECHAZADO';
    attempt.rejectedReason = rejectedReason || observacion || 'Rechazado por el administrador';
    attempt.rejectedBy = userId;
    attempt.rejectedAt = new Date();
    await attempt.save();

    await logAudit(req, {
      action: 'REJECT_PAYMENT',
      module: 'PAYMENTS',
      targetId: attempt._id,
      details: { amount: attempt.amount, rejectedReason: attempt.rejectedReason }
    });

    res.json({
      success: true,
      message: 'Intento de pago rechazado y cuotas revertidas exitosamente',
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
    const { tenantId, companyId, role } = req.user;
    const { quotaId, amount, bank, bankAccountId, observations, paymentDate, fechaPago, paymentMethod, paymentOption, requestId } = req.body;

    const isAdmin = ['superadmin', 'tenant_admin', 'company_admin', 'administrador'].includes(role);
    if ((bank === 'Cruce de cuentas' || paymentMethod === 'Cruce de cuentas') && !isAdmin) {
      return next(new AppError('No tienes permiso para registrar pagos por cruce de cuentas', 403));
    }
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
    const bankChoice = await resolveBankChoice(companyId, { bankAccountId, bank: bank || 'Efectivo' });
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
    const paidAmount = parseFloat(amount) || quota.value;
    const quotaPendingValue = quota.value - (quota.amountPaid || 0);

    const paidQuotasAccumulator = [];
    const quotasToRecord = [];

    console.log('[LOG][REGISTER_MANUAL_PAYMENT] Montos a procesar:', {
      paidAmount,
      quotaPendingValue,
      isExcess: paidAmount > quotaPendingValue
    });

    if (paidAmount > quotaPendingValue) {
      let excess = paidAmount - quotaPendingValue;
      quotasToRecord.push({ quotaId: quota._id, amount: quotaPendingValue });
      console.log('[LOG][REGISTER_MANUAL_PAYMENT] Iniciando cascada de pago por exceso. Excedente inicial:', excess);
      
      // Fully pay the selected quota
      quota.status = 'pagado';
      quota.amountPaid = quota.value;
      quota.paymentBank = bank;
      quota.paymentMethod = paymentMethod;
      quota.paymentObservations = `${observations || ''} (Pago inicial)`;
      quota.paymentDate = finalPaymentDate;
      quota.receiptNumber = manualReceiptNumber;
      if (captureUrl) {
        quota.paymentCapture = captureUrl;
      }
      await quota.save();
      paidQuotasAccumulator.push(quota._id);
      console.log('[LOG][REGISTER_MANUAL_PAYMENT] Cuota principal guardada y pagada en su totalidad.');

      // Fetch subsequent pending or in-mora quotas for this contract, sorted by type (inicial first) and number
      const queryFilter = {
        contract: quota.contract,
        tenantId,
        companyId,
        _id: { $ne: quotaId },
        status: { $in: ['pendiente', 'mora'] }
      };

      console.log('[LOG][REGISTER_MANUAL_PAYMENT] Buscando cuotas subsecuentes para cascada con filtro:', queryFilter);

      const pendingQuotas = await Quota.find(queryFilter).sort({ type: 1, number: 1 });
      console.log(`[LOG][REGISTER_MANUAL_PAYMENT] Se encontraron ${pendingQuotas.length} cuotas pendientes subsecuentes para cascada.`);

      for (const pq of pendingQuotas) {
        if (excess <= 0) {
          console.log('[LOG][REGISTER_MANUAL_PAYMENT] El excedente se ha agotado. Deteniendo cascada.');
          break;
        }

        const pqPendingValue = pq.value - (pq.amountPaid || 0);
        console.log(`[LOG][REGISTER_MANUAL_PAYMENT] Procesando cuota #${pq.number}:`, {
          quotaId: pq._id,
          value: pq.value,
          amountPaidBefore: pq.amountPaid,
          pendingValueNeeded: pqPendingValue,
          currentExcessLeft: excess
        });

        if (excess >= pqPendingValue) {
          // Fully pay this quota
          pq.status = 'pagado';
          pq.amountPaid = pq.value;
          pq.paymentBank = bank;
          pq.paymentMethod = paymentMethod;
          pq.paymentObservations = `${observations || ''} (Excedente en cascada de pago de la cuota #${quota.number})`;
          pq.paymentDate = finalPaymentDate;
          pq.receiptNumber = manualReceiptNumber;
          if (captureUrl) {
            pq.paymentCapture = captureUrl;
          }
          await pq.save();
          paidQuotasAccumulator.push(pq._id);
          quotasToRecord.push({ quotaId: pq._id, amount: pqPendingValue });
          console.log(`[LOG][REGISTER_MANUAL_PAYMENT] Cuota #${pq.number} PAGADA totalmente con excedente.`);

          excess -= pqPendingValue;
        } else {
          // Partially pay this quota
          pq.amountPaid = (pq.amountPaid || 0) + excess;
          pq.paymentBank = bank;
          pq.paymentMethod = paymentMethod;
          pq.paymentObservations = `${observations || ''} (Abono parcial en cascada de pago de la cuota #${quota.number})`;
          pq.paymentDate = finalPaymentDate;
          pq.receiptNumber = manualReceiptNumber;
          if (captureUrl) {
            pq.paymentCapture = captureUrl;
          }
          await pq.save();
          quotasToRecord.push({ quotaId: pq._id, amount: excess });
          console.log(`[LOG][REGISTER_MANUAL_PAYMENT] Cuota #${pq.number} ABONADA parcialmente con saldo restante de ${excess}.`);

          excess = 0;
        }
      }
    } else {
      console.log('[LOG][REGISTER_MANUAL_PAYMENT] El pago es igual o menor al saldo pendiente de la cuota. Sin cascada.');
      quotasToRecord.push({ quotaId: quota._id, amount: paidAmount });
      quota.amountPaid = (quota.amountPaid || 0) + paidAmount;
      if (quota.amountPaid >= quota.value) {
        quota.status = 'pagado';
      }
      quota.paymentBank = bank;
      quota.paymentMethod = paymentMethod;
      quota.paymentObservations = observations;
      quota.paymentDate = finalPaymentDate;
      quota.receiptNumber = manualReceiptNumber;
      if (captureUrl) {
        quota.paymentCapture = captureUrl;
      }
      await quota.save();
      paidQuotasAccumulator.push(quota._id);
      console.log('[LOG][REGISTER_MANUAL_PAYMENT] Cuota guardada exitosamente.');
    }

    // Immediately create the PaymentAttempt as approved
    try {
      const contract = await Contract.findById(quota.contract);
      const OPTION_TO_TYPE = { minimo: 'MINIMO', total: 'TOTAL', otro: 'OTRO' };
      await PaymentAttempt.create({
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
      await sendConsolidatedPaymentNotifications(req, paidQuotasAccumulator, companyId);
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

    if (startDate || endDate) {
      query.fechaPago = {};
      if (startDate) {
        query.fechaPago.$gte = new Date(startDate);
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.fechaPago.$lte = end;
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
    const { tenantId, companyId, userId, role } = req.user;
    const { id: attemptId } = req.params;
    const { amount, bank, bankAccountId, paymentMethod, paymentDate, observations, reason } = req.body;

    const isAdmin = ['superadmin', 'tenant_admin', 'company_admin', 'administrador'].includes(role);
    if (!isAdmin) {
      return next(new AppError('No tienes permisos administrativos para editar pagos registrados', 403));
    }

    const attempt = await PaymentAttempt.findOne({ _id: attemptId, tenantId, companyId });
    if (!attempt) {
      return next(new AppError('Intento de pago no encontrado', 404));
    }

    const oldAmount = attempt.amount;
    const newAmount = amount !== undefined && amount !== null ? parseFloat(amount) : oldAmount;

    if (isNaN(newAmount) || newAmount <= 0) {
      return next(new AppError('El nuevo monto del pago debe ser un número válido mayor a 0', 400));
    }

    // 1. Rollback all quotas previously credited by this payment attempt
    for (const qEntry of attempt.quotas) {
      const qDoc = await Quota.findOne({ _id: qEntry.quotaId, tenantId, companyId });
      if (qDoc) {
        const deducted = Math.max(0, (qDoc.amountPaid || 0) - qEntry.amount);
        qDoc.amountPaid = deducted;
        if (qDoc.amountPaid < qDoc.value) {
          const now = new Date();
          qDoc.status = qDoc.dueDate < now ? 'mora' : 'pendiente';
        }
        if (qDoc.amountPaid === 0) {
          qDoc.paymentBank = undefined;
          qDoc.paymentMethod = undefined;
          qDoc.paymentObservations = undefined;
          qDoc.paymentDate = undefined;
          qDoc.paymentCapture = undefined;
          qDoc.receiptNumber = undefined;
        }
        await qDoc.save();
      }
    }

    // 2. Identify the target initial quota for this payment (the first quota in attempt.quotas)
    const primaryQuotaId = attempt.quotas.length > 0 ? attempt.quotas[0].quotaId : null;
    let primaryQuota = primaryQuotaId ? await Quota.findOne({ _id: primaryQuotaId, tenantId, companyId }) : null;

    if (!primaryQuota) {
      // Fallback to first pending quota of the contract
      primaryQuota = await Quota.findOne({ contract: attempt.contractId, tenantId, companyId }).sort({ type: 1, number: 1 });
    }

    if (!primaryQuota) {
      return next(new AppError('No se encontró una cuota asociada al contrato para aplicar el pago', 404));
    }

    const bankChoice = bankAccountId ? await resolveBankChoice(companyId, { bankAccountId }) : null;
    const finalBank = bankChoice?.banco || bank || attempt.banco || 'Efectivo';
    const finalMethod = paymentMethod || attempt.paymentMethod || 'Efectivo';
    const finalDate = parseBusinessDate(paymentDate, attempt.fechaPago || new Date());
    const finalObservations = observations !== undefined ? observations : attempt.observations;
    const finalReceiptNumber = attempt.receiptNumber || (await getNextSequence(companyId, tenantId, 'RECEIPT'));

    // 3. Re-apply the newAmount in cascade starting from primaryQuota
    const paidQuotasAccumulator = [];
    const newQuotasToRecord = [];

    let excess = newAmount;

    // First process primaryQuota
    const primaryPending = primaryQuota.value - (primaryQuota.amountPaid || 0);
    if (excess >= primaryPending) {
      primaryQuota.status = 'pagado';
      primaryQuota.amountPaid = primaryQuota.value;
      primaryQuota.paymentBank = finalBank;
      primaryQuota.paymentMethod = finalMethod;
      primaryQuota.paymentObservations = `${finalObservations || ''} (Pago principal editado)`;
      primaryQuota.paymentDate = finalDate;
      primaryQuota.receiptNumber = finalReceiptNumber;
      if (attempt.comprobante) {
        primaryQuota.paymentCapture = attempt.comprobante;
      }
      await primaryQuota.save();
      paidQuotasAccumulator.push(primaryQuota._id);
      newQuotasToRecord.push({ quotaId: primaryQuota._id, amount: primaryPending });
      excess -= primaryPending;

      // If there is excess, cascade to subsequent pending/mora quotas of this contract
      if (excess > 0) {
        const queryFilter = {
          contract: primaryQuota.contract,
          tenantId,
          companyId,
          _id: { $ne: primaryQuota._id },
          status: { $in: ['pendiente', 'mora'] }
        };
        const nextQuotas = await Quota.find(queryFilter).sort({ type: 1, number: 1 });
        for (const pq of nextQuotas) {
          if (excess <= 0) break;
          const pqPending = pq.value - (pq.amountPaid || 0);
          if (excess >= pqPending) {
            pq.status = 'pagado';
            pq.amountPaid = pq.value;
            pq.paymentBank = finalBank;
            pq.paymentMethod = finalMethod;
            pq.paymentObservations = `${finalObservations || ''} (Excedente cascada)`;
            pq.paymentDate = finalDate;
            pq.receiptNumber = finalReceiptNumber;
            if (attempt.comprobante) pq.paymentCapture = attempt.comprobante;
            await pq.save();
            paidQuotasAccumulator.push(pq._id);
            newQuotasToRecord.push({ quotaId: pq._id, amount: pqPending });
            excess -= pqPending;
          } else {
            pq.amountPaid = (pq.amountPaid || 0) + excess;
            pq.paymentBank = finalBank;
            pq.paymentMethod = finalMethod;
            pq.paymentObservations = `${finalObservations || ''} (Abono parcial cascada)`;
            pq.paymentDate = finalDate;
            pq.receiptNumber = finalReceiptNumber;
            if (attempt.comprobante) pq.paymentCapture = attempt.comprobante;
            await pq.save();
            newQuotasToRecord.push({ quotaId: pq._id, amount: excess });
            excess = 0;
          }
        }
      }
    } else {
      // Partial payment on primary quota
      primaryQuota.amountPaid = (primaryQuota.amountPaid || 0) + excess;
      if (primaryQuota.amountPaid >= primaryQuota.value) {
        primaryQuota.status = 'pagado';
      }
      primaryQuota.paymentBank = finalBank;
      primaryQuota.paymentMethod = finalMethod;
      primaryQuota.paymentObservations = finalObservations;
      primaryQuota.paymentDate = finalDate;
      primaryQuota.receiptNumber = finalReceiptNumber;
      if (attempt.comprobante) primaryQuota.paymentCapture = attempt.comprobante;
      await primaryQuota.save();
      paidQuotasAccumulator.push(primaryQuota._id);
      newQuotasToRecord.push({ quotaId: primaryQuota._id, amount: excess });
      excess = 0;
    }

    // 4. Update the PaymentAttempt document
    attempt.amount = newAmount;
    if (bankChoice) attempt.bankAccountId = bankChoice.bankAccountId;
    else if (bank && bank !== attempt.banco) attempt.bankAccountId = null;
    attempt.banco = finalBank;
    attempt.paymentMethod = finalMethod;
    attempt.fechaPago = finalDate;
    attempt.observations = finalObservations;
    attempt.quotas = newQuotasToRecord;
    attempt.receiptNumber = finalReceiptNumber;
    attempt.editedBy = userId;
    attempt.editedAt = new Date();
    attempt.editReason = reason || 'Ajuste administrativo de monto/datos';
    await attempt.save();

    // Initial quota fully paid: the ordinary quotas follow its completion date (new plan rules only)
    await recalculatePlanAfterInitialPayment({ contractId: primaryQuota.contract, tenantId, companyId, req });

    // 5. Re-evaluate commission milestones in case payment changes milestone status
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
        affectedQuotasCount: newQuotasToRecord.length
      }
    });

    res.json({
      success: true,
      message: 'Pago corregido y cuotas recalculadas exitosamente',
      data: {
        paymentId: attempt._id,
        newAmount,
        receiptNumber: finalReceiptNumber,
        affectedQuotas: newQuotasToRecord
      }
    });
  } catch (error) {
    console.error('[LOG][EDIT_PAYMENT] Error editando pago:', error);
    next(error);
  }
};


