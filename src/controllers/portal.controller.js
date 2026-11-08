import mongoose from 'mongoose';
import Lot from '../models/Lot.js';
import Payment from '../models/Payment.js';
import Client from '../models/Client.js';
import Quota from '../models/Quota.js';
import Contract from '../models/Contract.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import Company from '../models/Company.js';
import { getNextSequence } from '../models/Counter.js';
import AppError from '../utils/AppError.js';
import { uploadToR2 } from '../utils/storage.js';
import { generateReceiptStream } from '../utils/receipt.js';
import { generateStatementStream } from '../utils/statement.js';
import { loadStatement, toStatementPdfData, buildStatementSummary } from '../services/statementSummary.service.js';
import { recordDelivery } from './statement.controller.js';
import { parseBusinessDate } from '../utils/dates.js';
import { resolveBankChoice, publicBankAccounts } from '../utils/bankAccounts.js';
import { claimPaymentRequest } from '../utils/idempotency.js';
import { parsePositiveAmount } from '../utils/math.js';

/**
 * Get dashboard home data for the client portal
 */
export const getPortalHome = async (req, res, next) => {
  try {
    const { clientId, tenantId } = req.user;
    
    if (!clientId) {
      return next(new AppError('No client associated with this account', 400));
    }

    const clientObj = await Client.findById(clientId);
    if (!clientObj) {
      return next(new AppError('Client not found', 404));
    }

    // Fetch contracts for this client
    const contracts = await Contract.find({ client: clientId, tenantId })
      .populate({
        path: 'lot',
        populate: { path: 'companyId' }
      })
      .populate('companyId');

    const formattedContracts = await Promise.all(contracts.map(async (c) => {
      const quotas = await Quota.find({ contract: c._id, tenantId });
      const summary = buildStatementSummary(c, quotas, { apiUrl: process.env.API_URL || '' });

      const totalValue = summary.totalValue;
      const cuotasPagadas = summary.paidQuotasCount;
      const cuotasPendientes = summary.quotasCount - summary.paidQuotasCount;
      const totalPagado = summary.totalPaid;
      const totalPendiente = summary.balance;
      const porcentajePagado = summary.percentPaid;
      const proximoVencimiento = summary.nextQuota?.dueDate || null;
      const diasMora = summary.daysOverdue;

      return {
        id: c._id,
        lote: {
          manzana: c.lot?.manzana || '',
          nomenclatura: c.lot?.nomenclature || '',
          areaTotalM2: c.lot?.area || 0,
          proyecto: c.companyId?.name || c.lot?.companyId?.name || '',
          propertyType: c.lot?.propertyType || 'lotes',
          tower: c.lot?.tower || '',
          floor: c.lot?.floor || '',
          lotNumber: c.lot?.lotNumber || '',
        },
        valorTotal: totalValue,
        valorCuota: c.installmentValue || 0,
        diaPago: c.paymentDay || 1,
        totalCuotas: quotas.length,
        cuotasPagadas,
        cuotasPendientes,
        totalPagado,
        totalPendiente,
        porcentajePagado,
        proximoVencimiento,
        diasMora,
        cuotasEnMora: summary.overdueCount,
        valorEnMora: summary.overdueAmount,
        proximaCuota: summary.nextQuota,
        status: c.status || 'ACTIVO'
      };
    }));

    res.json({
      success: true,
      data: {
        client: {
          id: clientObj._id,
          fullName: clientObj.name,
          cedula: clientObj.idNumber,
          phone: clientObj.phone
        },
        contracts: formattedContracts,
        notifications: []
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get summary for the client portal dashboard
 */
export const getPortalSummary = async (req, res, next) => {
  try {
    const { clientId, tenantId } = req.user;
    
    if (!clientId) {
      return next(new AppError('No client associated with this account', 400));
    }

    // 1. Fetch contracts to identify lots under contract
    const contracts = await Contract.find({ client: clientId, tenantId })
      .populate('lot')
      .populate('companyId');
    const contractLotIds = contracts.map(c => c.lot?._id).filter(Boolean);

    // 2. Fetch all lots (either under contract or direct reservations)
    const lots = await Lot.find({
      $or: [
        { _id: { $in: contractLotIds } },
        { reservationBy: clientId }
      ],
      tenantId
    }).populate('companyId', 'name slug logo phone email');

    // 3. Fetch payment attempts for this client
    const attempts = await PaymentAttempt.find({ clientId, tenantId })
      .populate({
        path: 'contractId',
        populate: { path: 'lot' }
      })
      .sort({ createdAt: -1 });

    // 4. Calculate total invested (only approved attempts)
    const totalInvested = attempts
      .filter(a => a.status === 'APROBADO')
      .reduce((sum, a) => sum + a.amount, 0);

    // 5. Format recent payments (limit to 5) for the frontend expectation
    const recentPayments = attempts.slice(0, 5).map(a => {
      let statusStr = 'pending';
      if (a.status === 'APROBADO') statusStr = 'approved';
      if (a.status === 'RECHAZADO') statusStr = 'rejected';

      const lotNumber = a.contractId?.lot?.lotNumber;
      const stageName = a.contractId?.lot?.stage;
      const referenceName = lotNumber 
        ? `Abono Lote ${lotNumber}${stageName ? ` - ${stageName}` : ''}`
        : 'Abono General';

      return {
        _id: a._id,
        amount: a.amount,
        status: statusStr,
        referencia: referenceName,
        createdAt: a.createdAt
      };
    });

    // 6. Extract company contact details from the first available populated lot or contract
    let companySlug = null;
    let companyPhone = null;
    let companyEmail = null;

    if (contracts.length > 0 && contracts[0].companyId) {
      companySlug = contracts[0].companyId.slug;
      companyPhone = contracts[0].companyId.phone;
      companyEmail = contracts[0].companyId.email;
    } else if (lots.length > 0) {
      companySlug = lots[0].companyId?.slug;
      companyPhone = lots[0].companyId?.phone;
      companyEmail = lots[0].companyId?.email;
    }

    const contractQuotas = await Quota.find({ contract: { $in: contracts.map((c) => c._id) }, tenantId });
    const clientContact = await Client.findOne({ _id: clientId, tenantId }).select('email');

    const contractsData = contracts.map(c => {
      const lotNumber = c.lot?.lotNumber;
      const stageName = c.lot?.stage;
      const manzana = c.lot?.manzana;
      const lotInfo = lotNumber 
        ? `Etapa: ${stageName || '-'} - Mz: ${manzana || '-'} - Lote: ${lotNumber}`
        : 'N/A';
      const { quotas: _quotas, ...statement } = buildStatementSummary(
        c,
        contractQuotas.filter((q) => String(q.contract) === String(c._id)),
        { apiUrl: process.env.API_URL || `${req.protocol}://${req.get('host')}` },
      );
      return {
        id: c._id,
        lotInfo,
        projectName: c.companyId?.name || c.lot?.companyId?.name || '',
        hasEmail: !!clientContact?.email,
        statement,
      };
    });

    res.json({
      success: true,
      data: {
        lotsCount: lots.length,
        recentPayments,
        totalInvested,
        clientName: req.user.fullName,
        companySlug,
        companyPhone,
        companyEmail,
        contracts: contractsData
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all lots for the logged-in client
 */
export const getMyLots = async (req, res, next) => {
  try {
    const { clientId, tenantId } = req.user;
    
    if (!clientId) {
      return next(new AppError('No client associated with this account', 400));
    }

    const contracts = await Contract.find({ client: clientId, tenantId });
    const contractLotIds = contracts.map(c => c.lot).filter(Boolean);

    const directLots = await Lot.find({
      $or: [
        { _id: { $in: contractLotIds } },
        { reservationBy: clientId }
      ],
      tenantId
    }).populate('companyId', 'name slug logo phone email').lean();

    const lots = directLots.map(lot => {
      const associatedContract = contracts.find(c => c.lot && c.lot.toString() === lot._id.toString());
      return {
        ...lot,
        contractId: associatedContract ? associatedContract._id : null
      };
    });

    res.json({
      success: true,
      data: { lots }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all payments for the logged-in client
 */
/**
 * GET /api/portal/bank-accounts — the authorized accounts of the client's company
 */
export const getPortalBankAccounts = async (req, res, next) => {
  try {
    const client = await Client.findOne({ _id: req.user.clientId, tenantId: req.user.tenantId }).select('companyId');
    if (!client) {
      return next(new AppError('No hay un cliente asociado a esta cuenta', 400));
    }
    const company = await Company.findById(client.companyId).select('bankAccounts');
    res.json({ success: true, data: { bankAccounts: publicBankAccounts(company) } });
  } catch (error) {
    next(error);
  }
};

export const getMyPayments = async (req, res, next) => {
  try {
    const { clientId, tenantId } = req.user;
    
    if (!clientId) {
      return next(new AppError('No client associated with this account', 400));
    }

    const attempts = await PaymentAttempt.find({ clientId, tenantId })
      .populate({
        path: 'contractId',
        populate: { path: 'lot' }
      })
      .sort({ createdAt: -1 });

    const formattedPayments = attempts.map(a => {
      let statusStr = 'pending';
      if (a.status === 'APROBADO') statusStr = 'approved';
      if (a.status === 'RECHAZADO') statusStr = 'rejected';

      const lotNumber = a.contractId?.lot?.lotNumber;
      const stageName = a.contractId?.lot?.stage;
      const referenceName = lotNumber 
        ? `Cuota Lote ${lotNumber}${stageName ? ` - ${stageName}` : ''}`
        : 'Pago de Cuota Lote';

      return {
        _id: a._id,
        receiptNumber: a.receiptNumber || null,
        amount: a.amount,
        status: statusStr,
        referencia: referenceName,
        metodoPago: a.paymentMethod || 'Consignación',
        createdAt: a.createdAt,
        updatedAt: a.updatedAt
      };
    });

    res.json({
      success: true,
      data: { payments: formattedPayments }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Report a payment from the client portal
 */
export const reportPortalPayment = async (req, res, next) => {
  try {
    const { clientId, tenantId } = req.user;
    const { contractId, cuotaNumber, amount, banco, bankAccountId, paymentMethod, fechaPago, paymentType, requestId } = req.body;
    const file = req.file;

    if (!clientId) {
      return next(new AppError('No hay un cliente asociado a esta cuenta', 400));
    }

    if (!contractId || !cuotaNumber || !amount || !(banco || bankAccountId) || !paymentMethod) {
      return next(new AppError('Todos los campos son requeridos', 400));
    }

    if (!file) {
      return next(new AppError('El comprobante de pago es obligatorio', 400));
    }

    // Verify contract belongs to this client
    const contract = await Contract.findOne({ _id: contractId, client: clientId, tenantId });
    if (!contract) {
      return next(new AppError('El contrato no pertenece al cliente autenticado', 403));
    }

    // Find the target quota
    const quota = await Quota.findOne({ contract: contractId, number: parseInt(cuotaNumber), tenantId });
    if (!quota) {
      return next(new AppError('Cuota no encontrada', 404));
    }

    let captureUrl = null;
    if (file) {
      captureUrl = await uploadToR2(file, 'payments');
      console.log('[LOG][PORTAL_REPORT_PAYMENT] Archivo subido exitosamente:', captureUrl);
    }

    const targetDate = parseBusinessDate(fechaPago);
    const paymentAmount = parsePositiveAmount(amount);
    if (paymentAmount === null) {
      return next(new AppError('Indica el monto que pagaste, mayor a 0', 400));
    }

    // Tipo de pago seleccionado por el cliente: TOTAL / MINIMO / OTRO (o PARCIAL si no llega)
    const VALID_PAYMENT_TYPES = ['TOTAL', 'MINIMO', 'OTRO'];
    const normalizedPaymentType = VALID_PAYMENT_TYPES.includes(String(paymentType || '').toUpperCase())
      ? String(paymentType).toUpperCase()
      : (paymentAmount >= (quota.value - (quota.amountPaid || 0)) ? 'TOTAL' : 'PARCIAL');

    const bankChoice = await resolveBankChoice(contract.companyId, { bankAccountId, bank: banco });
    // A double click or a retry with the same operation id cannot report the payment twice
    const releaseRequest = await claimPaymentRequest(`portal:${clientId}`, requestId);

    const attempt = await PaymentAttempt.create({
      tenantId,
      companyId: contract.companyId,
      contractId,
      clientId,
      quotas: [{
        quotaId: quota._id,
        amount: paymentAmount
      }],
      amount: paymentAmount,
      paymentType: normalizedPaymentType,
      quotaValue: quota.value,
      ...bankChoice,
      paymentMethod,
      fechaPago: targetDate,
      comprobante: captureUrl || undefined,
      status: 'PENDIENTE',
      appliedToQuotas: false,
    }).catch(async (createError) => {
      await releaseRequest();
      throw createError;
    });

    console.log('[LOG][PORTAL_REPORT_PAYMENT] Intento de pago de portal creado exitosamente:', attempt._id);

    res.json({
      success: true,
      message: 'Pago reportado exitosamente. Pendiente de aprobación.',
    });
  } catch (error) {
    console.error('[LOG][PORTAL_REPORT_PAYMENT] Error crítico:', error);
    next(error);
  }
};

/**
 * Generate a PDF cash receipt for a portal client payment attempt
 */
export const getPortalReceiptPDF = async (req, res, next) => {
  try {
    const { clientId, tenantId } = req.user;
    const { paymentId } = req.params;

    if (!clientId) {
      return next(new AppError('No client associated with this account', 400));
    }

    const attempt = await PaymentAttempt.findById(paymentId);
    if (!attempt) {
      return next(new AppError('Pago no encontrado', 404));
    }

    if (attempt.clientId.toString() !== clientId.toString()) {
      return next(new AppError('No tienes permiso para descargar este recibo', 403));
    }

    if (attempt.status !== 'APROBADO') {
      return next(new AppError('El recibo solo está disponible para pagos aprobados', 400));
    }

    const quotaEntries = attempt.quotas || [];
    if (quotaEntries.length === 0) {
      return next(new AppError('No hay cuotas asociadas a este pago', 400));
    }

    // Populate all target quotas
    const quotaIds = quotaEntries.map(q => q.quotaId);
    const quotas = await Quota.find({ _id: { $in: quotaIds }, tenantId })
      .populate({
        path: 'contract',
        populate: [
          { path: 'client' },
          { path: 'lot' },
        ],
      })
      .sort({ type: 1, number: 1 });

    if (quotas.length === 0) {
      return next(new AppError('Cuotas asociadas no encontradas', 404));
    }

    const firstQuota = quotas[0];
    const company = await Company.findById(firstQuota.companyId);
    
    // Load Tenant (Matriz) info from Settings
    const Tenant = (await import('../models/Tenant.js')).default;
    const tenant = await Tenant.findById(firstQuota.tenantId);

    if (!attempt.receiptNumber) {
      attempt.receiptNumber = await getNextSequence(firstQuota.companyId, firstQuota.tenantId, 'RECEIPT');
      await attempt.save();
      await Quota.updateMany({ _id: { $in: quotaIds } }, { $set: { receiptNumber: attempt.receiptNumber } });
    }

    // Format quota numbers (e.g. "2, 3")
    const quotaNumbers = quotas.map(q => {
      const isSeparation = q.number === 0 || q.number === '0';
      return isSeparation ? 'SEPARACIÓN' : `${q.number}`;
    }).join(', ');

    // Compile observations with exact breakdown of how the payment was split
    const breakdownLines = quotas.map(q => {
      const isSeparation = q.number === 0 || q.number === '0';
      const quotaName = isSeparation ? 'Separación' : `Cuota #${q.number}`;
      const quotaType = q.type === 'inicial' ? 'Inicial' : 'Ordinaria';
      const appliedAmount = attempt.quotas.find(entry => entry.quotaId.toString() === q._id.toString())?.amount || q.amountPaid || q.value;
      return `${quotaName} (${quotaType}): $${Number(appliedAmount).toLocaleString('es-CO')}`;
    }).join(' | ');

    const combinedObservations = `Distribución de pago: [ ${breakdownLines} ]. ${attempt.observations || ''}`;

    const receiptData = {
      receiptNumber: attempt.receiptNumber,
      quotaNumber: quotaNumbers,
      amount: attempt.amount,
      date: attempt.fechaPago || attempt.createdAt,
      clientName: firstQuota.contract.client.name,
      clientId: firstQuota.contract.client.idNumber,
      clientPhone: firstQuota.contract.client.phone || '',
      clientAddress: firstQuota.contract.client.address || '',
      clientCity: firstQuota.contract.client.expeditionPlace || '',
      companyName: tenant?.name || company?.name || '',
      companyNit: tenant?.nit || company?.nit || '',
      companyAddress: tenant?.address || company?.address || '',
      companyPhone: tenant?.phone || company?.phone || '',
      companyLogo: company?.projectLogo || company?.logo || '',
      lotInfo: firstQuota.contract.lot 
        ? `Etapa: ${firstQuota.contract.lot.stage || '-'} - Manzana: ${firstQuota.contract.lot.manzana || '-'} - Lote: ${firstQuota.contract.lot.lotNumber || '-'}${firstQuota.contract.lot.nomenclature ? ` (${firstQuota.contract.lot.nomenclature})` : ''}`
        : 'N/A',
      projectName: company?.name || '',
      paymentBank: attempt.banco,
      observations: combinedObservations,
      paymentCapture: attempt.comprobante,
    };

    await generateReceiptStream(receiptData, res);
  } catch (error) {
    console.error('[LOG][PORTAL_GET_RECEIPT_PDF] Error crítico:', error);
    next(error);
  }
};

/**
 * Get contract detail for the logged-in client
 */
export const getPortalContractDetail = async (req, res, next) => {
  try {
    const { clientId, tenantId } = req.user;
    const { id } = req.params;

    if (!clientId) {
      return next(new AppError('No client associated with this account', 400));
    }

    const contract = await Contract.findOne({ _id: id, client: clientId, tenantId })
      .populate({
        path: 'lot',
        populate: { path: 'companyId' }
      })
      .populate('companyId');

    if (!contract) {
      return next(new AppError('Contrato no encontrado o no pertenece a este cliente', 404));
    }

    const quotas = await Quota.find({ contract: contract._id, tenantId }).sort({ type: 1, number: 1 });

    const summary = buildStatementSummary(contract, quotas, { apiUrl: process.env.API_URL || '' });
    const totalPagado = summary.totalPaid;
    const PORTAL_STATUS = { pagada: 'PAGADA', mora: 'VENCIDA', abonada: 'PENDIENTE', pendiente: 'PENDIENTE' };

    const planPagos = summary.quotas.map((q) => ({
      numero: q.number,
      fechaVencimiento: q.dueDate,
      monto: q.value,
      pagado: q.paid,
      pendiente: q.pending,
      status: PORTAL_STATUS[q.state],
      fechaPago: q.paymentDate,
      observaciones: quotas.find((orig) => String(orig._id) === q.id)?.paymentObservations,
    }));

    const data = {
      id: contract._id,
      lote: {
        manzana: contract.lot?.manzana || '',
        nomenclatura: contract.lot?.nomenclature || '',
        areaTotalM2: contract.lot?.area || 0,
        proyecto: contract.companyId?.name || contract.lot?.companyId?.name || '',
        propertyType: contract.lot?.propertyType || 'lotes',
        tower: contract.lot?.tower || '',
        floor: contract.lot?.floor || '',
        lotNumber: contract.lot?.lotNumber || ''
      },
      valorTotal: contract.totalValue || 0,
      totalPagado,
      valorCuota: contract.installmentValue || 0,
      diaPago: contract.paymentDay || 1,
      totalCuotas: quotas.length,
      cuotasPagadas: summary.paidQuotasCount,
      porcentajePagado: summary.percentPaid,
      saldo: summary.balance,
      cuotasEnMora: summary.overdueCount,
      valorEnMora: summary.overdueAmount,
      diasMora: summary.daysOverdue,
      status: contract.status || 'ACTIVO',
      planPagos
    };

    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Generate a PDF account statement for a contract belonging to the authenticated client
 */
export const getPortalStatementPDF = async (req, res, next) => {
  try {
    const { clientId, tenantId } = req.user;
    const { contractId } = req.params;

    if (!clientId) {
      return next(new AppError('No client associated with this account', 400));
    }

    const loaded = mongoose.isValidObjectId(contractId)
      ? await loadStatement({ _id: contractId, client: clientId, tenantId })
      : null;

    if (!loaded) {
      return next(new AppError('Contrato no encontrado o no pertenece a este cliente', 404));
    }

    const statementData = toStatementPdfData(loaded);
    await recordDelivery({ loaded, channel: 'pdf', source: 'portal', req });

    await generateStatementStream(statementData, res);
  } catch (error) {
    console.error('[LOG][PORTAL_GET_STATEMENT_PDF] Error crítico:', error);
    next(error);
  }
};
