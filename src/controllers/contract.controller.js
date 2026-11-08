import {
  getPaymentPlanPolicy,
  updatePaymentPlanPolicy,
  registerInitialExtension,
  registerOtrosi,
  setContractLegalStatus,
} from '../services/paymentPlan.service.js';

/**
 * Payment plan policy of the active company (project).
 */
export const getPolicy = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const policy = await getPaymentPlanPolicy({ tenantId, companyId });
    res.json({ success: true, data: { policy } });
  } catch (error) {
    next(error);
  }
};

export const updatePolicy = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const policy = await updatePaymentPlanPolicy({ tenantId, companyId, input: req.body.policy || req.body, req });
    res.json({ success: true, message: 'Política del plan de pagos actualizada', data: { policy } });
  } catch (error) {
    next(error);
  }
};

/**
 * Registers the contract's legal state (signed outside Operix).
 */
export const updateLegalStatus = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const contract = await setContractLegalStatus({
      contractId: req.params.id, tenantId, companyId, body: req.body, file: req.file, req,
    });
    res.json({ success: true, message: 'Estado del contrato registrado', data: { contract } });
  } catch (error) {
    next(error);
  }
};

/**
 * «Registrar ampliación del plazo de la inicial» (approved outside Operix).
 */
export const createInitialExtension = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const contract = await registerInitialExtension({
      contractId: req.params.id, tenantId, companyId, body: req.body, req,
    });
    res.json({ success: true, message: 'Ampliación del plazo de la cuota inicial registrada', data: { contract } });
  } catch (error) {
    next(error);
  }
};

/**
 * «Registrar otrosí» (approved and signed outside Operix).
 */
export const createOtrosi = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const contract = await registerOtrosi({
      contractId: req.params.id, tenantId, companyId, body: req.body, file: req.file, req,
    });
    res.json({ success: true, message: 'Otrosí registrado y plan recalculado', data: { contract } });
  } catch (error) {
    next(error);
  }
};
