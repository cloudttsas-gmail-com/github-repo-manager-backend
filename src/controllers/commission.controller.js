import Commission from '../models/Commission.js';
import User from '../models/User.js';
import AppError from '../utils/AppError.js';
import { getNextSequence } from '../models/Counter.js';
import { sendEmail } from '../utils/notifications.js';
import { projectAccountants, sendTeamCommissionNotice } from '../services/commission.service.js';
import { uploadToR2 } from '../utils/storage.js';

// POST /commissions/upload-support — uploads a support document (PDF or image) to Cloudflare R2
export const uploadCommissionSupport = async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      return next(new AppError('No se subió ningún archivo', 400));
    }
    const { type } = req.body; // 'invoice', 'social_security', 'rut', 'bank_cert'
    const folder = `commissions/${type || 'soportes'}`;
    const fileUrl = await uploadToR2(file, folder);

    res.json({
      success: true,
      data: { url: fileUrl },
    });
  } catch (error) {
    next(error);
  }
};

// GET /commissions — list commissions with filters.
// Seller roles only see their own commissions.
export const getCommissions = async (req, res, next) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    const { status, contractId, sellerId } = req.query;

    // Auto-sync any contract with seller that doesn't have commission materialized yet
    try {
      const { syncRetroactiveCommissions } = await import('../services/commission.service.js');
      await syncRetroactiveCommissions({ tenantId, companyId });
    } catch (syncErr) {
      console.error('[COMMISSIONS] Auto-sync error:', syncErr);
    }

    const filter = { tenantId, companyId };
    if (role === 'vendedor' || role === 'ejecutivo_comercial' || role === 'agent') {
      filter.sellerId = userId;
    } else if (sellerId) {
      filter.sellerId = sellerId;
    }
    if (contractId) filter.contractId = contractId;

    let commissions = await Commission.find(filter)
      .sort({ createdAt: -1 })
      .populate({
        path: 'contractId',
        populate: [
          { path: 'client', select: 'name idNumber' },
          { path: 'lot', select: 'nomenclature stage manzana lotNumber' },
        ],
      })
      .populate({
        path: 'sellerId',
        select: 'accountId',
        populate: { path: 'accountId', select: 'fullName email' },
      });

    if (status) {
      commissions = commissions.filter((c) =>
        c.installments.some((i) => i.status === status)
      );
    }

    res.json({
      success: true,
      data: { commissions },
    });
  } catch (error) {
    next(error);
  }
};

const getInstallment = (commission, installmentIndex) => {
  const idx = parseInt(installmentIndex, 10);
  if (Number.isNaN(idx) || !commission.installments[idx]) return null;
  return { idx, installment: commission.installments[idx] };
};

// `detail` is the WhatsApp version: one lowercase sentence for the operix_aviso_comision template
const notifySeller = async (commission, message, subject, detail) => {
  try {
    const seller = await User.findById(commission.sellerId).populate({
      path: 'accountId',
      select: 'fullName email phone',
    });
    if (!seller?.accountId) return;
    if (seller.accountId.email) {
      await sendEmail(seller.accountId.email, subject, `<p>${message}</p>`);
    }
    await sendTeamCommissionNotice({ companyId: commission.companyId, account: seller.accountId, detail });
  } catch (error) {
    console.error('[COMMISSION] Error notificando al asesor:', error);
  }
};

// Only the accountants of the commission's project, not every one of the inmobiliaria
const notifyAccountants = async ({ tenantId, companyId }, message, subject, detail) => {
  try {
    const accountants = await projectAccountants({ tenantId, companyId });

    for (const acc of accountants) {
      if (!acc.accountId) continue;
      if (acc.accountId.email) {
        await sendEmail(acc.accountId.email, subject, `<p>${message}</p>`);
      }
      await sendTeamCommissionNotice({ companyId, account: acc.accountId, detail });
    }
  } catch (error) {
    console.error('[COMMISSION] Error notificando a contabilidad:', error);
  }
};

// POST /commissions/:id/radicar — the seller files their billing (cuenta de cobro)
export const radicarComision = async (req, res, next) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    const { id } = req.params;
    const {
      installmentIndex,
      invoiceUrl,
      socialSecurityUrl,
      rutUrl,
      bankCertUrl,
      attachmentUrl,
    } = req.body;

    const commission = await Commission.findOne({ _id: id, tenantId, companyId });
    if (!commission) return next(new AppError('Comisión no encontrada', 404));

    const isOwner = commission.sellerId && commission.sellerId.toString() === userId;
    const isAdminRole = !['vendedor', 'ejecutivo_comercial', 'agent'].includes(role);
    if (!isOwner && !isAdminRole) {
      return next(new AppError('Solo el asesor dueño de la venta puede radicar esta cuenta de cobro', 403));
    }

    const found = getInstallment(commission, installmentIndex);
    if (!found) return next(new AppError('Desembolso no encontrado en la comisión', 400));
    const { installment } = found;

    if (installment.status !== 'AVAILABLE' && installment.status !== 'REJECTED') {
      return next(new AppError('Solo se pueden radicar desembolsos disponibles', 400));
    }

    // Require the 4 mandatory support documents (plan maestro: cuenta de cobro, seguridad social, RUT y certificación bancaria)
    const resolvedInvoice = invoiceUrl || attachmentUrl;
    if (!resolvedInvoice) {
      return next(new AppError('La Cuenta de Cobro o Factura Electrónica es obligatoria', 400));
    }
    if (!socialSecurityUrl) {
      return next(new AppError('La Planilla de Seguridad Social es obligatoria para radicar', 400));
    }
    if (!rutUrl) {
      return next(new AppError('El RUT vigente es obligatorio para radicar', 400));
    }
    if (!bankCertUrl) {
      return next(new AppError('La Certificación Bancaria es obligatoria para radicar', 400));
    }

    const billingSeq = await getNextSequence(companyId, tenantId, 'BILLING');
    const now = new Date();

    // Fetch seller details for stamping
    const sellerUser = await User.findById(commission.sellerId).populate('accountId');
    const sellerName = sellerUser?.accountId?.fullName || 'Asesor Comercial';
    const sellerDoc = sellerUser?.accountId?.idNumber || sellerUser?.accountId?.cedula || 'N/A';
    const milestoneLabel = installment.milestoneKey === 'INITIAL_QUOTA'
      ? 'Comisión Cuota Inicial'
      : `Comisión Cuota #${installment.quotaNumber || 6}`;

    installment.status = 'FILED';
    installment.filedAt = now;
    installment.filedBy = userId;
    installment.billingNumber = billingSeq;
    installment.attachmentUrl = resolvedInvoice;
    installment.invoiceUrl = resolvedInvoice;
    installment.socialSecurityUrl = socialSecurityUrl || '';
    installment.rutUrl = rutUrl || '';
    installment.bankCertUrl = bankCertUrl || '';
    installment.stampedAt = now;
    installment.filingSeal = {
      radNumber: `RAD-${String(billingSeq).padStart(4, '0')}`,
      stampedAt: now,
      sellerName,
      sellerDocument: sellerDoc,
      amount: installment.amount,
      milestoneLabel,
      statusText: 'RECIBIDO / RADICADO',
    };
    installment.rejectedBy = undefined;
    installment.rejectedAt = undefined;
    installment.rejectedReason = undefined;
    await commission.save();

    // Notify accountants
    await notifyAccountants(
      { tenantId, companyId: commission.companyId },
      `Se ha radicado la cuenta de cobro #${installment.billingNumber} por $${installment.amount.toLocaleString('es-CO')} de ${sellerName} (${milestoneLabel}). Ingresa al módulo de Comisiones para aprobarla o rechazarla.`,
      `Cuenta de cobro radicada #${installment.billingNumber}`,
      `${sellerName} radicó la cuenta de cobro n.º ${installment.billingNumber} por $${installment.amount.toLocaleString('es-CO')} (${milestoneLabel}) y está por aprobar o rechazar`,
    );

    // Notify seller with confirmation receipt
    if (sellerUser?.accountId?.email) {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #1e293b;">
          <h2 style="color: #0284c7;">Radicado Exitoso de Cuenta de Cobro</h2>
          <p>Hola <strong>${sellerName}</strong>,</p>
          <p>Tu cuenta de cobro para <strong>${milestoneLabel}</strong> ha sido radicada correctamente con el siguiente comprobante:</p>
          <div style="border: 2px dashed #0284c7; background: #f0f9ff; padding: 15px; border-radius: 8px; margin: 15px 0;">
            <p style="margin: 4px 0;"><strong>No. Radicado:</strong> RAD-${String(billingSeq).padStart(4, '0')}</p>
            <p style="margin: 4px 0;"><strong>Fecha y Hora:</strong> ${now.toLocaleString('es-CO')}</p>
            <p style="margin: 4px 0;"><strong>Valor:</strong> $${installment.amount.toLocaleString('es-CO')}</p>
            <p style="margin: 4px 0;"><strong>Estado:</strong> RECIBIDO</p>
          </div>
          <p>Contabilidad y Gerencia revisarán tus 4 soportes adjuntos para procesar el pago.</p>
        </div>
      `;
      await sendEmail(sellerUser.accountId.email, `Confirmación de Radicado #RAD-${String(billingSeq).padStart(4, '0')}`, emailHtml);
    }

    // Notify seller via WhatsApp (plan maestro: comisiones radicadas por Twilio WhatsApp)
    if (sellerUser?.accountId?.phone) {
      try {
        await sendTeamCommissionNotice({
          companyId: commission.companyId,
          account: sellerUser.accountId,
          detail: `tu cuenta de cobro de ${milestoneLabel} quedó radicada con el n.º RAD-${String(billingSeq).padStart(4, '0')} por $${installment.amount.toLocaleString('es-CO')} y contabilidad revisará los soportes`,
        });
      } catch (waError) {
        console.error('[COMMISSION] Error enviando WhatsApp de radicado:', waError);
      }
    }

    res.json({
      success: true,
      message: 'Cuenta de cobro radicada exitosamente con sello de radicado',
      data: { commission },
    });
  } catch (error) {
    next(error);
  }
};

// POST /commissions/:id/aprobar — accountant approves the billing
export const aprobarComision = async (req, res, next) => {
  try {
    const { tenantId, companyId, userId } = req.user;
    const { id } = req.params;
    const { installmentIndex, observacion } = req.body;

    const commission = await Commission.findOne({ _id: id, tenantId, companyId });
    if (!commission) return next(new AppError('Comisión no encontrada', 404));

    const found = getInstallment(commission, installmentIndex);
    if (!found) return next(new AppError('Desembolso no encontrado en la comisión', 400));
    const { installment } = found;

    if (installment.status !== 'FILED') {
      return next(new AppError('Solo se pueden aprobar cuentas de cobro radicadas', 400));
    }

    installment.status = 'APPROVED';
    installment.approvedBy = userId;
    installment.approvedAt = new Date();
    installment.approvalNote = observacion || '';
    await commission.save();

    await notifySeller(
      commission,
      `Tu cuenta de cobro #${installment.billingNumber} por $${installment.amount.toLocaleString('es-CO')} fue APROBADA.`,
      'Cuenta de cobro aprobada',
      `tu cuenta de cobro n.º ${installment.billingNumber} por $${installment.amount.toLocaleString('es-CO')} fue aprobada`,
    );

    res.json({
      success: true,
      message: 'Cuenta de cobro aprobada',
      data: { commission },
    });
  } catch (error) {
    next(error);
  }
};

// POST /commissions/:id/rechazar — accountant rejects the billing (reason required)
export const rechazarComision = async (req, res, next) => {
  try {
    const { tenantId, companyId, userId } = req.user;
    const { id } = req.params;
    const { installmentIndex, rejectedReason } = req.body;

    if (!rejectedReason || !rejectedReason.trim()) {
      return next(new AppError('La observación de rechazo es obligatoria', 400));
    }

    const commission = await Commission.findOne({ _id: id, tenantId, companyId });
    if (!commission) return next(new AppError('Comisión no encontrada', 404));

    const found = getInstallment(commission, installmentIndex);
    if (!found) return next(new AppError('Desembolso no encontrado en la comisión', 400));
    const { installment } = found;

    if (installment.status !== 'FILED') {
      return next(new AppError('Solo se pueden rechazar cuentas de cobro radicadas', 400));
    }

    installment.status = 'REJECTED';
    installment.rejectedBy = userId;
    installment.rejectedAt = new Date();
    installment.rejectedReason = rejectedReason.trim();
    await commission.save();

    await notifySeller(
      commission,
      `Tu cuenta de cobro #${installment.billingNumber} por $${installment.amount.toLocaleString('es-CO')} fue RECHAZADA. Motivo: ${rejectedReason.trim()}. Puedes corregirla y volver a radicarla.`,
      'Cuenta de cobro rechazada',
      `tu cuenta de cobro n.º ${installment.billingNumber} por $${installment.amount.toLocaleString('es-CO')} fue rechazada (motivo: ${rejectedReason.trim().replace(/\s+/g, ' ')}); puedes corregirla y radicarla de nuevo`,
    );

    res.json({
      success: true,
      message: 'Cuenta de cobro rechazada',
      data: { commission },
    });
  } catch (error) {
    next(error);
  }
};

// POST /commissions/:id/pagar — treasury/accountant marks the billing as paid
export const pagarComision = async (req, res, next) => {
  try {
    const { tenantId, companyId, userId } = req.user;
    const { id } = req.params;
    const { installmentIndex } = req.body;

    const commission = await Commission.findOne({ _id: id, tenantId, companyId });
    if (!commission) return next(new AppError('Comisión no encontrada', 404));

    const found = getInstallment(commission, installmentIndex);
    if (!found) return next(new AppError('Desembolso no encontrado en la comisión', 400));
    const { installment } = found;

    if (installment.status !== 'APPROVED') {
      return next(new AppError('Solo se pueden pagar cuentas de cobro aprobadas', 400));
    }

    installment.status = 'PAID';
    installment.paidBy = userId;
    installment.paidAt = new Date();
    await commission.save();

    await notifySeller(
      commission,
      `Tu comisión por $${installment.amount.toLocaleString('es-CO')} (cuenta de cobro #${installment.billingNumber}) fue PAGADA. ¡Felicitaciones!`,
      'Comisión pagada',
      `tu comisión por $${installment.amount.toLocaleString('es-CO')} (cuenta de cobro n.º ${installment.billingNumber}) fue pagada`,
    );

    res.json({
      success: true,
      message: 'Comisión marcada como pagada',
      data: { commission },
    });
  } catch (error) {
    next(error);
  }
};
