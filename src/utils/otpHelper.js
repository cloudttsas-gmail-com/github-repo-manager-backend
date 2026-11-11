import VerificationToken from '../models/VerificationToken.js';
import Client from '../models/Client.js';
import Company from '../models/Company.js';
import Contract from '../models/Contract.js';
import Quota from '../models/Quota.js';
import crypto from 'crypto';
import AppError from './AppError.js';
import { sendEmail } from './notifications.js';
import { sendCompanyNotice } from '../services/whatsappTemplates.service.js';

const OTP_WINDOW_MS = 10 * 60 * 1000;
const MAX_OTPS_PER_WINDOW = 3;

export const sendOTPCode = async (tenantId, companyId, clientId, type, destination, companyName, purpose = 'payment') => {
  // Anyone who knows an id number can ask for a code, so cap how many reach the same client
  const recent = await VerificationToken.countDocuments({
    clientId,
    createdAt: { $gt: new Date(Date.now() - OTP_WINDOW_MS) },
  });
  if (recent >= MAX_OTPS_PER_WINDOW) {
    throw new AppError('Ya enviamos varios códigos. Espera unos minutos antes de pedir otro.', 429);
  }

  // Generate 6-digit code
  const code = crypto.randomInt(100000, 1000000).toString();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins validity

  const verification = await VerificationToken.create({
    tenantId,
    companyId,
    clientId,
    token,
    code,
    type,
    destination,
    purpose,
    expiresAt,
  });

  const EMAIL_ACTIONS = {
    login: 'entrar a tu portal de cliente',
    statement: 'consultar tu estado de cuenta',
    payment: 'reportar el pago de tu inmueble',
  };
  const emailAction = EMAIL_ACTIONS[purpose] || EMAIL_ACTIONS.payment;

  let result;
  if (type === 'email') {
    const subject = `Código de verificación de seguridad - ${companyName}`;
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 500px; margin: 0 auto; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
        <h3 style="color: #0284c7; text-align: center;">Código de Seguridad</h3>
        <p>Hola,</p>
        <p>Pediste un código para ${emailAction}. Usa este código de verificación:</p>
        <div style="text-align: center; margin: 25px 0;">
          <span style="font-family: monospace; font-size: 28px; font-weight: bold; background: #f1f5f9; padding: 10px 20px; border-radius: 6px; letter-spacing: 4px; border: 1px solid #cbd5e1;">${code}</span>
        </div>
        <p style="font-size: 13px; color: #64748b; text-align: center;">Este código es válido por 15 minutos. No compartas este código con nadie.</p>
      </div>
    `;
    result = await sendEmail(destination, subject, emailHtml);
  } else if (type === 'phone') {
    // From the company's own number, with its approved authentication template
    const company = await Company.findById(companyId);
    result = await sendCompanyNotice({ company, to: destination, notice: 'codigo', values: { code } });
  }

  // The providers log failures and return { success: false } instead of throwing
  if (result && result.success === false) {
    verification.isUsed = true;
    await verification.save();
    throw new AppError('No pudimos enviar el código. Intenta de nuevo o elige otro medio de envío.', 502);
  }

  return token;
};
