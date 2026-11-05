import crypto from 'crypto';
import { isValidPublicLink } from '../utils/publicLinks.js';
import Client from '../models/Client.js';
import Company from '../models/Company.js';
import Contract from '../models/Contract.js';
import Quota from '../models/Quota.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import AppError from '../utils/AppError.js';
import { uploadToR2 } from '../utils/storage.js';
import { generateReceiptStream } from '../utils/receipt.js';
import { getNextSequence } from '../models/Counter.js';
import { generateStatementStream } from '../utils/statement.js';

/**
 * Generate a dynamic PDF receipt for a paid quota (Public endpoint)
 */
export const getReceiptPDF = async (req, res, next) => {
  try {
    // Prevent browser caching so the most recent receipt is always generated fresh
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    let { quotaId, attemptId } = req.params;
    if (quotaId) quotaId = quotaId.replace(/[^a-fA-F0-9]/g, '');
    if (attemptId) attemptId = attemptId.replace(/[^a-fA-F0-9]/g, '');

    const { receiptNumber, attemptId: queryAttemptId, s: signature } = req.query;
    const effectiveAttemptId = attemptId || (queryAttemptId ? queryAttemptId.replace(/[^a-fA-F0-9]/g, '') : null);

    const signedOk = effectiveAttemptId
      ? isValidPublicLink('receipt-attempt', effectiveAttemptId, signature)
      : isValidPublicLink('receipt', quotaId, signature);
    if (!signedOk) {
      return next(new AppError('Enlace no válido. Pide a tu inmobiliaria que te reenvíe el recibo.', 403));
    }

    let attempt = null;
    let quota = null;

    // 1. Direct search by PaymentAttempt ID if specified
    if (effectiveAttemptId) {
      attempt = await PaymentAttempt.findOne({ _id: effectiveAttemptId, status: 'APROBADO' });
    }

    // 2. If quotaId is provided, retrieve quota
    if (quotaId) {
      quota = await Quota.findById(quotaId)
        .populate({
          path: 'contract',
          populate: [
            { path: 'client' },
            { path: 'lot' },
          ],
        });
    }

    // 3. Search attempt by specific receiptNumber if provided in query or on the quota
    const targetReceiptNumber = receiptNumber ? Number(receiptNumber) : (quota?.receiptNumber || null);

    if (!attempt && targetReceiptNumber) {
      if (quota) {
        attempt = await PaymentAttempt.findOne({
          'quotas.quotaId': quota._id,
          receiptNumber: targetReceiptNumber,
          status: 'APROBADO',
        });
      }
      if (!attempt) {
        attempt = await PaymentAttempt.findOne({
          receiptNumber: targetReceiptNumber,
          status: 'APROBADO',
        });
      }
    }

    // 4. Fallback: Search attempt matching this quotaId (most recent approved attempt)
    if (!attempt && quota) {
      attempt = await PaymentAttempt.findOne({
        'quotas.quotaId': quota._id,
        status: 'APROBADO',
      }).sort({ createdAt: -1 });
    }

    if (attempt) {
      // If a matching payment attempt is found, generate the consolidated receipt for the entire transaction!
      const quotaIds = attempt.quotas.map(q => q.quotaId);
      const quotas = await Quota.find({ _id: { $in: quotaIds } })
        .populate({
          path: 'contract',
          populate: [
            { path: 'client' },
            { path: 'lot' },
          ],
        })
        .sort({ type: 1, number: 1 });

      if (quotas.length > 0) {
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

        const quotaNumbers = quotas.map(q => {
          const isSeparation = q.number === 0 || q.number === '0';
          return isSeparation ? 'SEPARACIÓN' : `${q.number}`;
        }).join(', ');

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

        return await generateReceiptStream(receiptData, res);
      }
    }

    // Fallback to legacy single quota receipt if no PaymentAttempt is found
    if (!quota && quotaId) {
      quota = await Quota.findById(quotaId)
        .populate({
          path: 'contract',
          populate: [
            { path: 'client' },
            { path: 'lot' },
          ],
        });
    }

    if (!quota) {
      return next(new AppError('Cuota no encontrada', 404));
    }

    if (quota.status !== 'pagado' && (!quota.amountPaid || quota.amountPaid === 0)) {
      return next(new AppError('El recibo solo está disponible para cuotas con pagos o abonos registrados', 400));
    }

    if (!quota.receiptNumber) {
      quota.receiptNumber = await getNextSequence(quota.companyId, quota.tenantId, 'RECEIPT');
      await quota.save();
    }

    const company = await Company.findById(quota.companyId);
    
    // Load Tenant (Matriz) info from Settings
    const Tenant = (await import('../models/Tenant.js')).default;
    const tenant = await Tenant.findById(quota.tenantId);

    const receiptData = {
      receiptNumber: quota.receiptNumber,
      quotaNumber: quota.number,
      amount: quota.amountPaid || quota.value,
      date: quota.paymentDate || quota.updatedAt,
      clientName: quota.contract.client.name,
      clientId: quota.contract.client.idNumber,
      clientPhone: quota.contract.client.phone || '',
      clientAddress: quota.contract.client.address || '',
      clientCity: quota.contract.client.expeditionPlace || '',
      companyName: tenant?.name || company?.name || '',
      companyNit: tenant?.nit || company?.nit || '',
      companyAddress: tenant?.address || company?.address || '',
      companyPhone: tenant?.phone || company?.phone || '',
      companyLogo: company?.projectLogo || company?.logo || '',
      lotInfo: quota.contract.lot 
        ? `Etapa: ${quota.contract.lot.stage || '-'} - Manzana: ${quota.contract.lot.manzana || '-'} - Lote: ${quota.contract.lot.lotNumber || '-'}${quota.contract.lot.nomenclature ? ` (${quota.contract.lot.nomenclature})` : ''}`
        : 'N/A',
      projectName: company?.name || '',
      paymentBank: quota.paymentBank,
      observations: quota.paymentObservations,
      paymentCapture: quota.paymentCapture,
    };

    await generateReceiptStream(receiptData, res);
  } catch (error) {
    next(error);
  }
};

/**
 * Generate a dynamic PDF account statement for a contract (Public endpoint)
 */
export const getStatementPDF = async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (!isValidPublicLink('statement', req.params.contractId, req.query.s)) {
      return next(new AppError('Enlace no válido. Pide a tu inmobiliaria que te reenvíe el estado de cuenta.', 403));
    }

    let { contractId } = req.params;
    contractId = contractId.replace(/[^a-fA-F0-9]/g, '');

    const contract = await Contract.findById(contractId)
      .populate('client')
      .populate('lot');

    if (!contract) {
      return next(new AppError('Contrato no encontrado', 404));
    }

    const company = await Company.findById(contract.companyId);

    // Fetch all quotas for the contract sorted by type then number
    const quotas = await Quota.find({ contract: contractId })
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
    next(error);
  }
};

/**
 * First step of the public payment flow: tells where the code can be sent.
 * Only masked contact data is returned; contracts and quotas need a verified code.
 */
export const getClientInfo = async (req, res, next) => {
  try {
    const { companySlug, idNumber } = req.params;

    const company = await Company.findOne({ slug: companySlug });
    if (!company) {
      return next(new AppError('Empresa no encontrada', 404));
    }

    const client = await Client.findOne({
      idNumber: String(idNumber),
      companyId: company._id,
    }).select('email phone');

    if (!client) {
      return next(new AppError('Cliente no encontrado en esta empresa', 404));
    }

    const maskEmail = (email) => {
      if (!email || !email.includes('@')) return '';
      const [local, domain] = email.split('@');
      return local.length > 2
        ? `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`
        : `${local[0]}*@${domain}`;
    };

    const maskPhone = (phone) => {
      if (!phone) return '';
      const phStr = phone.toString();
      return phStr.length > 4
        ? '*'.repeat(phStr.length - 4) + phStr.slice(-4)
        : phStr;
    };

    res.json({
      success: true,
      data: {
        client: {
          email: maskEmail(client.email),
          phone: maskPhone(client.phone),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Report a payment for a specific quota (Client Flow)
 */
export const reportPayment = async (req, res, next) => {
  try {
    const { quotaId, amount, bank, observations, paymentDate, fechaPago, paymentMethod, phone, email, otpToken, paymentType } = req.body;
    
    if (bank === 'Cruce de cuentas' || paymentMethod === 'Cruce de cuentas') {
      return next(new AppError('No tienes permiso para reportar pagos con cruce de cuentas', 403));
    }
    const file = req.file;

    if (!file) {
      return next(new AppError('El comprobante de pago es obligatorio', 400));
    }

    console.log('[LOG][PUBLIC_REPORT_PAYMENT] Petición recibida:', {
      quotaId,
      amount,
      bank,
      observations,
      paymentDate,
      fechaPago,
      paymentMethod,
      phone,
      email,
      otpToken,
      hasFile: !!file
    });

    if (!quotaId) {
      console.warn('[LOG][PUBLIC_REPORT_PAYMENT] Error: ID de cuota ausente');
      return next(new AppError('El ID de la cuota es requerido', 400));
    }

    // OTP Token verification
    if (!otpToken) {
      return next(new AppError('Verificación de identidad requerida (token no proporcionado)', 401));
    }

    const VerificationToken = (await import('../models/VerificationToken.js')).default;
    const verifiedSession = await VerificationToken.findOne({
      token: String(otpToken),
      isUsed: false,
      verifiedAt: { $ne: null },
      expiresAt: { $gt: new Date() }
    });

    if (!verifiedSession) {
      return next(new AppError('Sesión o token de verificación expirado, inválido o ya utilizado', 401));
    }

    const quota = await Quota.findById(quotaId);
    if (!quota) {
      console.warn('[LOG][PUBLIC_REPORT_PAYMENT] Error: Cuota no encontrada con ID:', quotaId);
      return next(new AppError('Cuota no encontrada', 404));
    }

    // Verify client matches this quota contract client
    const contract = await Contract.findById(quota.contract);
    if (!contract || contract.client.toString() !== verifiedSession.clientId.toString()) {
      return next(new AppError('La cuota a reportar no pertenece al cliente verificado', 403));
    }

    console.log('[LOG][PUBLIC_REPORT_PAYMENT] Cuota encontrada antes de actualizar:', {
      quotaId: quota._id,
      contract: quota.contract,
      number: quota.number,
      value: quota.value,
      amountPaid: quota.amountPaid,
      status: quota.status,
      prevPaymentDate: quota.paymentDate
    });

    let captureUrl = null;
    if (file) {
      captureUrl = await uploadToR2(file, 'payments');
      console.log('[LOG][PUBLIC_REPORT_PAYMENT] Archivo subido exitosamente:', captureUrl);
    }

    const targetDate = paymentDate || fechaPago || new Date();
    console.log('[LOG][PUBLIC_REPORT_PAYMENT] Fecha determinada para el pago:', targetDate);

    const paymentAmount = parseFloat(amount) || quota.value;

    // Tipo de pago seleccionado por el cliente: TOTAL / MINIMO / OTRO (o PARCIAL si no llega)
    const VALID_PAYMENT_TYPES = ['TOTAL', 'MINIMO', 'OTRO'];
    const normalizedPaymentType = VALID_PAYMENT_TYPES.includes(String(paymentType || '').toUpperCase())
      ? String(paymentType).toUpperCase()
      : (paymentAmount >= (quota.value - (quota.amountPaid || 0)) ? 'TOTAL' : 'PARCIAL');

    const attempt = await PaymentAttempt.create({
      tenantId: quota.tenantId,
      companyId: quota.companyId,
      contractId: quota.contract,
      clientId: verifiedSession.clientId,
      quotas: [{
        quotaId: quota._id,
        amount: paymentAmount
      }],
      amount: paymentAmount,
      paymentType: normalizedPaymentType,
      quotaValue: quota.value,
      banco: bank,
      paymentMethod,
      fechaPago: targetDate,
      comprobante: captureUrl || undefined,
      observations: observations || '',
      status: 'PENDIENTE'
    });
    console.log('[LOG][PUBLIC_REPORT_PAYMENT] Intento de pago creado exitosamente con ID:', attempt._id);

    // Mark the OTP token as used
    verifiedSession.isUsed = true;
    await verifiedSession.save();

    // Update client contact info if provided
    try {
      const client = await Client.findById(contract.client);
      if (client) {
        let updated = false;
        if (phone && phone !== client.phone) {
          console.log(`[LOG][PUBLIC_REPORT_PAYMENT] Actualizando teléfono de ${client.phone} a ${phone}`);
          client.phone = phone;
          updated = true;
        }
        if (email && email !== client.email) {
          console.log(`[LOG][PUBLIC_REPORT_PAYMENT] Actualizando email de ${client.email} a ${email}`);
          client.email = email;
          updated = true;
        }
        if (updated) {
          await client.save();
          console.log('[LOG][PUBLIC_REPORT_PAYMENT] Información del cliente actualizada exitosamente');
        }
      }
    } catch (err) {
      console.error('[LOG][PUBLIC_REPORT_PAYMENT] Error updating client info during payment report:', err);
    }

    res.json({
      success: true,
      message: 'Pago reportado exitosamente. Pendiente de aprobación.',
    });
  } catch (error) {
    console.error('[LOG][PUBLIC_REPORT_PAYMENT] Error crítico:', error);
    next(error);
  }
};

/**
 * Get active company bank accounts with QR codes (Public endpoint)
 */
export const getCompanyAccountsPublic = async (req, res, next) => {
  try {
    const { companySlug } = req.params;

    const company = await Company.findOne({ slug: companySlug }).select('name logo nit address phone bankAccounts');
    if (!company) {
      return next(new AppError('Empresa no encontrada', 404));
    }

    res.json({
      success: true,
      data: {
        name: company.name,
        logo: company.logo || '',
        nit: company.nit || '',
        address: company.address || '',
        phone: company.phone || '',
        bankAccounts: company.bankAccounts ? company.bankAccounts.filter(acc => acc.isActive) : []
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Send OTP Code to client for secure payments page
 */
export const sendOTPCodePublic = async (req, res, next) => {
  try {
    const { companySlug } = req.params;
    const { idNumber, type } = req.body; // type: 'email' | 'phone'

    if (!idNumber || !type) {
      return next(new AppError('Cédula y tipo de envío (email/phone) son requeridos', 400));
    }

    const company = await Company.findOne({ slug: companySlug });
    if (!company) {
      return next(new AppError('Empresa no encontrada', 404));
    }

    const client = await Client.findOne({ idNumber, companyId: company._id });
    if (!client) {
      return next(new AppError('Cliente no encontrado en esta empresa', 404));
    }

    let destination = '';
    if (type === 'email') {
      if (!client.email) {
        return next(new AppError('El cliente no tiene un correo electrónico registrado', 400));
      }
      destination = client.email;
    } else if (type === 'phone') {
      if (!client.phone) {
        return next(new AppError('El cliente no tiene un teléfono registrado', 400));
      }
      destination = client.phone;
    } else {
      return next(new AppError('Tipo de envío no válido', 400));
    }

    const { sendOTPCode } = await import('../utils/otpHelper.js');
    const token = await sendOTPCode(client.tenantId, company._id, client._id, type, destination, company.name);

    res.json({
      success: true,
      message: `Código de verificación enviado exitosamente a tu ${type === 'email' ? 'correo' : 'celular'}.`,
      data: { token }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Verify OTP Code and return client's contracts and details securely
 */
export const verifyOTPCodePublic = async (req, res, next) => {
  try {
    const { companySlug } = req.params;
    const { token, code } = req.body;

    if (!token || !code) {
      return next(new AppError('Token de sesión y código OTP son requeridos', 400));
    }

    const company = await Company.findOne({ slug: companySlug });
    if (!company) {
      return next(new AppError('Empresa no encontrada', 404));
    }

    const VerificationToken = (await import('../models/VerificationToken.js')).default;
    const verification = await VerificationToken.findOne({
      token: String(token),
      companyId: company._id,
      isUsed: false,
      expiresAt: { $gt: new Date() }
    });

    if (!verification) {
      return next(new AppError('Código incorrecto, expirado o ya utilizado', 400));
    }

    const expected = Buffer.from(String(verification.code));
    const received = Buffer.from(String(code));
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      verification.attempts = (verification.attempts || 0) + 1;
      if (verification.attempts >= 5) verification.isUsed = true;
      await verification.save();
      return next(new AppError('Código incorrecto, expirado o ya utilizado', 400));
    }

    if (!verification.verifiedAt) {
      verification.verifiedAt = new Date();
      await verification.save();
    }

    // Load client info since they verified their identity
    const client = await Client.findById(verification.clientId);
    if (!client) {
      return next(new AppError('Cliente no encontrado', 404));
    }

    const contracts = await Contract.find({ 
      client: client._id,
      companyId: company._id,
    }).populate('lot').lean();

    const contractIds = contracts.map(c => c._id);
    const allQuotas = await Quota.find({ contract: { $in: contractIds } })
      .sort({ type: 1, number: 1 })
      .lean();

    const contractsWithQuotas = contracts.map((contract) => {
      const contractQuotas = allQuotas.filter(q => q.contract.toString() === contract._id.toString());
      
      return {
        ...contract,
        quotas: contractQuotas.map((q) => ({
          _id: q._id,
          number: q.number,
          type: q.type,
          value: q.value,
          dueDate: q.dueDate,
          status: q.status,
        })),
      };
    });

    res.json({
      success: true,
      message: 'Código verificado correctamente',
      data: {
        otpToken: token, // This will be sent back during reportPayment
        client: {
          name: client.name,
          idNumber: client.idNumber,
          phone: client.phone,
          email: client.email,
        },
        contracts: contractsWithQuotas
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Retrieve client details by verification token (Client Validation Flow)
 */
export const getClientByValidationToken = async (req, res, next) => {
  try {
    const { companySlug, token } = req.params;

    const company = await Company.findOne({ slug: companySlug });
    if (!company) {
      return next(new AppError('Empresa no encontrada', 404));
    }

    const client = await Client.findOne({
      validationToken: token,
      companyId: company._id
    });

    if (!client) {
      return next(new AppError('Enlace de validación inválido o expirado', 404));
    }

    res.json({
      success: true,
      data: {
        name: client.name,
        idNumber: client.idNumber,
        email: client.email || '',
        phone: client.phone || '',
        isEmailVerified: client.isEmailVerified || false,
        isPhoneVerified: client.isPhoneVerified || false,
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Confirm and save validated client info
 */
export const confirmClientValidation = async (req, res, next) => {
  try {
    const { companySlug } = req.params;
    const { token, email, phone } = req.body;

    if (!token) {
      return next(new AppError('Token es requerido', 400));
    }

    const company = await Company.findOne({ slug: companySlug });
    if (!company) {
      return next(new AppError('Empresa no encontrada', 404));
    }

    const client = await Client.findOne({
      validationToken: token,
      companyId: company._id
    });

    if (!client) {
      return next(new AppError('Enlace de validación inválido', 404));
    }

    let emailChanged = false;
    let phoneChanged = false;

    if (email && email.toLowerCase() !== (client.email || '').toLowerCase()) {
      client.email = email;
      emailChanged = true;
    }
    if (phone && phone !== client.phone) {
      client.phone = phone;
      phoneChanged = true;
    }

    client.isEmailVerified = true;
    client.isPhoneVerified = true;

    // Reset validation token so it's a one-time link, but keep it so they can't reuse
    client.validationToken = undefined; 
    await client.save();

    res.json({
      success: true,
      message: 'Tus datos de contacto han sido validados e ingresados exitosamente.',
      data: {
        email: client.email,
        phone: client.phone,
        isEmailVerified: client.isEmailVerified,
        isPhoneVerified: client.isPhoneVerified
      }
    });
  } catch (error) {
    next(error);
  }
};
