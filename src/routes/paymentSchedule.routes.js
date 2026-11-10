import express from 'express';
import { protect, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';
import { logAudit } from '../utils/auditLogger.js';
import { simulateScheduleAdjustment, applyScheduleAdjustment, generateContractSchedule } from '../services/paymentSchedule.service.js';

const router = express.Router();

router.use(protect);
router.use(tenantMiddleware);
router.use(companyMiddleware);

// POST /api/payment-schedule/simulate
router.post('/simulate', checkPermission(PERMISSIONS.CLIENTES_EDIT || 'CLIENTES_EDIT'), async (req, res) => {
  try {
    const { tenantId, companyId } = req.user;
    const { contractId, changes, strategy } = req.body;

    if (!contractId) {
      return res.status(400).json({ success: false, message: 'El contractId es requerido' });
    }

    const simulation = await simulateScheduleAdjustment({
      contractId,
      tenantId,
      companyId,
      changes,
      strategy
    });

    return res.json({ success: true, data: simulation });
  } catch (error) {
    console.error('[PAYMENT_SCHEDULE] Error simulating:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/payment-schedule/apply
router.post('/apply', checkPermission(PERMISSIONS.CLIENTES_EDIT || 'CLIENTES_EDIT'), async (req, res) => {
  try {
    const { tenantId, companyId, _id: userId } = req.user;
    const { contractId, updatedQuotas, reason } = req.body;

    if (!contractId || !updatedQuotas || !Array.isArray(updatedQuotas)) {
      return res.status(400).json({ success: false, message: 'Datos incompletos para reestructurar el plan de pagos' });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'La Nota de Ajuste es obligatoria para registrar los cambios.' });
    }

    const result = await applyScheduleAdjustment({
      contractId,
      tenantId,
      companyId,
      updatedQuotas,
      reason: reason.trim(),
      auditUser: userId
    });

    await logAudit(req, {
      action: 'RESTRUCTURA_PLAN_PAGOS',
      module: 'CONTRACTS',
      targetId: contractId,
      details: { count: updatedQuotas.length, reason: reason.trim() }
    });

    return res.json({ success: true, message: result.message });
  } catch (error) {
    console.error('[PAYMENT_SCHEDULE] Error applying adjustment:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

// POST /api/payment-schedule/generate
router.post('/generate', checkPermission(PERMISSIONS.CLIENTES_EDIT || 'CLIENTES_EDIT'), async (req, res) => {
  try {
    const { tenantId, companyId, _id: userId } = req.user;
    const {
      contractId,
      totalValue,
      installmentsCount,
      installmentValue,
      startDate,
      paymentDay,
      balloonInterval,
      balloonValue,
      initialQuotasCount,
      initialQuotaValue,
      preserveExistingPayments,
      reason
    } = req.body;

    if (!contractId || !totalValue || !installmentsCount || !installmentValue) {
      return res.status(400).json({
        success: false,
        message: 'Parámetros obligatorios faltantes: contractId, totalValue, installmentsCount, installmentValue'
      });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: 'La Nota de Ajuste es obligatoria para registrar los cambios.'
      });
    }

    const result = await generateContractSchedule({
      contractId,
      tenantId,
      companyId,
      totalValue,
      installmentsCount,
      installmentValue,
      startDate,
      paymentDay,
      balloonInterval,
      balloonValue,
      initialQuotasCount,
      initialQuotaValue,
      preserveExistingPayments,
      reason: reason.trim(),
      auditUser: userId
    });

    await logAudit(req, {
      action: 'GENERATE_PLAN_PAGOS',
      module: 'CONTRACTS',
      targetId: contractId,
      details: { totalValue, installmentsCount, installmentValue, balloonInterval, balloonValue, reason: reason.trim() }
    });

    return res.json({ success: true, message: result.message, data: result });
  } catch (error) {
    console.error('[PAYMENT_SCHEDULE] Error generating schedule:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

export default router;

