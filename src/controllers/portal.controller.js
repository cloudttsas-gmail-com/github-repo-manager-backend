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
import { parseBusinessDate } from '../utils/dates.js';

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
      
      const cuotasPagadas = quotas.filter(q => q.status === 'pagado').length;
      const cuotasPendientes = quotas.filter(q => q.status !== 'pagado').length;
      
      const totalPagado = quotas
        .filter(q => q.status === 'pagado')
        .reduce((sum, q) => sum + (q.amountPaid || q.value || 0), 0);
        
      const totalPendiente = quotas
        .filter(q => q.status !== 'pagado')
        .reduce((sum, q) => sum + (q.value || 0), 0);

      const totalValue = c.totalValue || 0;
      const porcentajePagado = totalValue > 0 ? Math.round((totalPagado / totalValue) * 100) : 0;

      // Oldest unpaid quota (dias de mora)
      const today = new Date();
      const unpaidQuotas = quotas
        .filter(q => q.status !== 'pagado' && q.dueDate)
        .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

      let proximoVencimiento = null;
      let diasMora = 0;

      if (unpaidQuotas.length > 0) {
        proximoVencimiento = unpaidQuotas[0].dueDate;
        
        // Check oldest overdue quota
        const oldestOverdue = unpaidQuotas[0];
        if (new Date(oldestOverdue.dueDate) < today) {
          const diffTime = Math.abs(today - new Date(oldestOverdue.dueDate));
          diasMora = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }
      }

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

    const contractsData = contracts.map(c => {
      const lotNumber = c.lot?.lotNumber;
      const stageName = c.lot?.stage;
      const manzana = c.lot?.manzana;
      const lotInfo = lotNumber 
        ? `Etapa: ${stageName || '-'} - Mz: ${manzana || '-'} - Lote: ${lotNumber}`
        : 'N/A';
      return {
        id: c._id,
        lotInfo,
        projectName: c.companyId?.name || c.lot?.companyId?.name || ''
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
    const { contractId, cuotaNumber, amount, banco, paymentMethod, fechaPago, paymentType } = req.body;
    const file = req.file;

    if (!clientId) {
      return next(new AppError('No hay un cliente asociado a esta cuenta', 400));
    }

    if (!contractId || !cuotaNumber || !amount || !banco || !paymentMethod) {
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
    const paymentAmount = parseFloat(amount);

    // Tipo de pago seleccionado por el cliente: TOTAL / MINIMO / OTRO (o PARCIAL si no llega)
    const VALID_PAYMENT_TYPES = ['TOTAL', 'MINIMO', 'OTRO'];
    const normalizedPaymentType = VALID_PAYMENT_TYPES.includes(String(paymentType || '').toUpperCase())
      ? String(paymentType).toUpperCase()
      : (paymentAmount >= (quota.value - (quota.amountPaid || 0)) ? 'TOTAL' : 'PARCIAL');

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
      banco,
      paymentMethod,
      fechaPago: targetDate,
      comprobante: captureUrl || undefined,
      status: 'PENDIENTE'
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

    const initialQuotas = quotas.filter(q => q.type === 'inicial');
    const normalQuotas = quotas.filter(q => q.type === 'normal');

    const paidInitial = initialQuotas.filter(q => q.status === 'pagado');
    const paidNormal = normalQuotas.filter(q => q.status === 'pagado');

    const totalPagadoFromQuotas = quotas
      .filter(q => q.status === 'pagado')
      .reduce((sum, q) => sum + (q.amountPaid || q.value || 0), 0);

    const totalRecaudadoSiigo = (contract.recaudadoSiigo2024 || 0) + (contract.recaudadoSiigo2025 || 0);
    const totalPagado = Math.max(totalPagadoFromQuotas, totalRecaudadoSiigo);

    const planPagos = quotas.map(q => {
      let statusStr = 'PENDIENTE';
      if (q.status === 'pagado') {
        statusStr = 'PAGADA';
      } else if (q.status === 'mora' || (q.status === 'pendiente' && q.dueDate && new Date(q.dueDate) < new Date())) {
        statusStr = 'VENCIDA';
      }
      return {
        numero: q.number,
        fechaVencimiento: q.dueDate,
        monto: q.value,
        status: statusStr,
        fechaPago: q.paymentDate || q.updatedAt,
        observaciones: q.paymentObservations
      };
    });

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
      cuotasPagadas: quotas.filter(q => q.status === 'pagado').length,
      porcentajePagado: contract.totalValue > 0 ? Math.round((totalPagado / contract.totalValue) * 100) : 0,
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

    const contract = await Contract.findOne({ _id: contractId, client: clientId, tenantId })
      .populate('client')
      .populate('lot');

    if (!contract) {
      return next(new AppError('Contrato no encontrado o no pertenece a este cliente', 404));
    }

    const company = await Company.findById(contract.companyId);

    // Fetch all quotas for the contract sorted by type then number
    const quotas = await Quota.find({ contract: contractId, tenantId })
      .sort({ type: 1, number: 1 });

    // Calculate aggregated metrics
    const totalValue = contract.totalValue || 0;
    const totalPaid = quotas.reduce((sum, q) => sum + (q.amountPaid || 0), 0);
    const totalPending = Math.max(0, totalValue - totalPaid);
    const averageRecaudo = totalValue > 0 ? Math.round((totalPaid / totalValue) * 100) : 0;

    // Breakdown metrics
    const initialQuotas = quotas.filter(q => q.type === 'inicial');
    const normalQuotas = quotas.filter(q => q.type === 'normal');

    const valorTotalInicial = initialQuotas.reduce((sum, q) => sum + (q.value || 0), 0);
    const valorPagadoInicial = initialQuotas.reduce((sum, q) => sum + (q.amountPaid || 0), 0);
    const totalCuotasIniciales = initialQuotas.length;
    const cuotasInicialesPagadas = initialQuotas.filter(q => q.status === 'pagado').length;

    const valorTotalCuotas = normalQuotas.reduce((sum, q) => sum + (q.value || 0), 0);
    const valorPagadoCuotas = normalQuotas.reduce((sum, q) => sum + (q.amountPaid || 0), 0);
    const totalCuotasNormales = normalQuotas.length;
    const cuotasNormalesPagadas = normalQuotas.filter(q => q.status === 'pagado').length;

    const lotInfo = contract.lot 
      ? `Etapa: ${contract.lot.stage || '-'} - Manzana: ${contract.lot.manzana || '-'} - Lote: ${contract.lot.lotNumber || '-'}${contract.lot.nomenclature ? ` (${contract.lot.nomenclature})` : ''}`
      : 'N/A';

    const statementData = {
      contractId: contract._id,
      clientName: contract.client?.name || 'N/A',
      clientId: contract.client?.idNumber || 'N/A',
      clientPhone: contract.client?.phone || '',
      clientEmail: contract.client?.email || '',
      projectName: contract.negotiation || 'Proyecto sin nombre',
      lotInfo,
      companyName: company?.name || '',
      companyNit: company?.nit || '',
      companyAddress: company?.address || '',
      companyPhone: company?.phone || '',
      companyLogo: company?.projectLogo || company?.logo || '',
      // Financial numbers
      totalValue,
      totalPaid,
      totalPending,
      averageRecaudo,
      // Breakdown
      valorTotalInicial,
      valorPagadoInicial,
      totalCuotasIniciales,
      cuotasInicialesPagadas,
      valorTotalCuotas,
      valorPagadoCuotas,
      totalCuotasNormales,
      cuotasNormalesPagadas,
      // Detailed list of quotas
      quotas,
    };

    await generateStatementStream(statementData, res);
  } catch (error) {
    console.error('[LOG][PORTAL_GET_STATEMENT_PDF] Error crítico:', error);
    next(error);
  }
};
