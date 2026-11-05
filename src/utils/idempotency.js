import IdempotencyKey from '../models/IdempotencyKey.js';
import AppError from './AppError.js';

/**
 * Claims the operation id a payment form sends (requestId) before anything is
 * changed. Returns a release function for when the operation fails, so it can
 * be retried. Requests without an id keep working as before.
 */
export const claimPaymentRequest = async (scope, requestId) => {
  if (!requestId) return async () => {};
  const key = `${scope}:${String(requestId).slice(0, 100)}`;
  try {
    await IdempotencyKey.create({ key });
  } catch (error) {
    if (error?.code === 11000) {
      throw new AppError('Este pago ya fue enviado. Revisa el historial antes de intentarlo de nuevo.', 409);
    }
    throw error;
  }
  return async () => {
    await IdempotencyKey.deleteOne({ key }).catch(() => {});
  };
};
