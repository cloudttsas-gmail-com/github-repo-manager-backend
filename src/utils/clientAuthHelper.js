import crypto from 'crypto';
import UserAccount from '../models/UserAccount.js';
import User from '../models/User.js';
import Company from '../models/Company.js';
import { sendEmail, sendWhatsApp } from './notifications.js';

/**
 * Registers a portal user account for a client, generates a validation token,
 * and sends welcome notifications with access credentials.
 */
const PASSWORD_HINTS = {
  document: 'Tu contraseña inicial es tu número de documento. Al entrar te enviaremos un código a tu celular para confirmar que eres tú.',
  given: 'Usa la contraseña que te entregó tu asesor.',
  existing: 'Usa la contraseña con la que ya entras al portal.',
};

export const registerPortalUserForClient = async (client, tenantId, companyId, passwordInput = null, quotas = null, contract = null) => {
  try {
    // 1. Generate validation token for the client if they don't have one
    if (!client.validationToken) {
      client.validationToken = crypto.randomBytes(32).toString('hex');
      await client.save();
    }

    const company = await Company.findById(companyId);
    const companyName = company?.name || 'Inmobiliaria';
    const companySlug = company?.slug || companyId.toString();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
    
    // Unique validation link
    const validationUrl = `${frontendUrl}/p/${companySlug}/validate-client?token=${client.validationToken}`;

    // 2. Check if a User membership for this client already exists
    const existingMembership = await User.findOne({
      tenantId,
      role: 'cliente',
      clientId: client._id,
    });

    if (existingMembership) {
      console.log(`[CLIENT_AUTH_HELPER] Client portal user already exists for client: ${client.name}`);
      return;
    }

    // 3. Create or find UserAccount
    let account = null;
    let generatedPin = null;
    // How the buyer signs in the first time, for the welcome message
    let passwordSource = 'existing';

    if (client.idNumber) {
      account = await UserAccount.findOne({ documentoIdentidad: client.idNumber });
    }
    if (!account && client.email) {
      account = await UserAccount.findOne({ email: client.email });
    }

    if (!account) {
      // Use document (idNumber) as default password if no passwordInput is provided, otherwise generate random PIN
      const defaultPassword = passwordInput || client.idNumber || Math.floor(100000 + Math.random() * 900000).toString();
      if (!passwordInput && !client.idNumber) {
        generatedPin = defaultPassword;
      }
      passwordSource = passwordInput ? 'given' : client.idNumber ? 'document' : 'pin';
      
      const emailValue = client.email || `${client.idNumber || Math.floor(100000 + Math.random() * 900000)}@portal.com`;

      account = await UserAccount.create({
        email: emailValue,
        passwordHash: defaultPassword,
        fullName: client.name,
        documentoIdentidad: client.idNumber,
      });
      console.log(`[CLIENT_AUTH_HELPER] Created UserAccount for: ${emailValue}`);
    } else {
      console.log(`[CLIENT_AUTH_HELPER] Found existing UserAccount for: ${account.email}`);
      if (!account.documentoIdentidad && client.idNumber) {
        account.documentoIdentidad = client.idNumber;
        await account.save({ validateBeforeSave: false });
      }
    }

    // 4. Create User membership
    if (account) {
      await User.create({
        accountId: account._id,
        tenantId,
        role: 'cliente',
        clientId: client._id,
      });
      console.log(`[CLIENT_AUTH_HELPER] Created User membership (role: cliente) linking account: ${account._id} to client: ${client._id}`);
    }

    // 5. Send Welcome & Validation Notifications
    const finalPin = passwordInput || generatedPin;
    
    // Generate payment plan table if quotas are provided
    let planHtml = '';
    if (quotas && quotas.length > 0) {
      const sortedQuotas = [...quotas].sort((a, b) => {
        if (a.number === 0) return -1;
        if (b.number === 0) return 1;
        if (a.type !== b.type) {
          return a.type === 'inicial' ? -1 : 1;
        }
        return a.number - b.number;
      });

      const rows = sortedQuotas.map((q) => {
        const typeStr = q.number === 0 ? 'Separación' : q.type === 'inicial' ? `Inicial #${q.number}` : `Ordinaria #${q.number}`;
        const formattedDueDate = q.dueDate
          ? new Date(q.dueDate).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' })
          : 'N/A';
        const formattedValue = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(q.value);
        return `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">${typeStr}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">${formattedDueDate}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 13px; font-weight: bold; text-align: right;">${formattedValue}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 13px; text-align: center;">${q.status === 'pagado' ? '✅ PAGADO' : '⏳ Pendiente'}</td>
          </tr>
        `;
      }).join('');

      planHtml = `
        <div style="margin: 25px 0; border-top: 1px solid #e2e8f0; padding-top: 20px;">
          <h4 style="margin: 0 0 10px 0; color: #0f172a;">Resumen de tu Plan de Pagos:</h4>
          <table style="width: 100%; border-collapse: collapse; text-align: left;">
            <thead>
              <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                <th style="padding: 8px; font-size: 12px; color: #64748b;">Concepto</th>
                <th style="padding: 8px; font-size: 12px; color: #64748b;">Vencimiento</th>
                <th style="padding: 8px; font-size: 12px; color: #64748b; text-align: right;">Valor</th>
                <th style="padding: 8px; font-size: 12px; color: #64748b; text-align: center;">Estado</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      `;
    }

    // Email Notification
    if (client.email) {
      const subject = `Bienvenido a tu Portal de Cliente - ${companyName}`;
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 25px; border-radius: 10px;">
          <h2 style="color: #0284c7; text-align: center;">¡Bienvenido a ${companyName}!</h2>
          <p>Hola <strong>${client.name}</strong>,</p>
          <p>Tu cuenta de cliente ha sido registrada exitosamente en nuestro sistema de recaudo y cobranza inmobiliaria.</p>
          
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <h4 style="margin: 0 0 10px 0; color: #0f172a;">Tus Datos de Acceso al Portal:</h4>
            <p style="margin: 5px 0;"><strong>Usuario:</strong> ${client.email}</p>
            ${generatedPin ? `<p style="margin: 5px 0;"><strong>PIN / Contraseña Temporal:</strong> <span style="font-family: monospace; font-size: 16px; font-weight: bold; background: #e2e8f0; padding: 2px 6px; rounded: 4px;">${generatedPin}</span></p>` : `<p style="margin: 5px 0; font-size: 12px; color: #64748b;">${PASSWORD_HINTS[passwordSource] || ''}</p>`}
          </div>

          <p style="font-weight: bold; color: #0f172a; margin-top: 25px;">IMPORTANTE: Validación de tus Datos de Contacto</p>
          <p>Para asegurar que recibas tus estados de cuenta, recordatorios y comprobantes de pago sin inconvenientes, por favor verifica y valida tus datos haciendo clic en el siguiente botón:</p>
          
          <div style="text-align: center; margin: 25px 0;">
            <a href="${validationUrl}" style="background: #22c55e; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 14px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
              VALIDAR MIS DATOS
            </a>
          </div>

          <p style="font-size: 13px; color: #64748b;">
            O copia y pega esta dirección en tu navegador:<br>
            <a href="${validationUrl}" style="color: #0284c7; word-break: break-all;">${validationUrl}</a>
          </p>

          <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 15px; margin-top: 25px;">
            Este mensaje fue enviado automáticamente. Por favor no respondas a esta dirección.<br>
            <strong>Operix Cobranza Inmobiliaria</strong>
          </p>
        </div>
      `;
      
      await sendEmail(client.email, subject, emailHtml);
    }

    // WhatsApp Notification
    if (client.phone) {
      const smsMessage = `Hola ${client.name}, bienvenido a ${companyName}. Tu portal de cliente está listo. Valida tus datos en: ${validationUrl} ${generatedPin ? `. Tu PIN temporal de acceso es ${generatedPin}` : ''}`;
      await sendWhatsApp(client.phone, smsMessage);
    }

  } catch (error) {
    console.error('[CLIENT_AUTH_HELPER] Error registering portal user for client:', error);
  }
};

/**
 * Sends a separate email containing the client's payment plan.
 */
// updateReason: why an already sent plan changed (e.g. the initial was paid or an otrosí); empty on the first plan
export const sendPaymentPlanEmail = async (client, quotas, contract, companyId, updateReason = '') => {
  if (!client.email || !quotas || quotas.length === 0) return;
  
  try {
    const company = await Company.findById(companyId);
    const companyName = company?.name || 'Inmobiliaria';
    
    const sortedQuotas = [...quotas].sort((a, b) => {
      if (a.number === 0) return -1;
      if (b.number === 0) return 1;
      if (a.type !== b.type) {
        return a.type === 'inicial' ? -1 : 1;
      }
      return a.number - b.number;
    });

    const rows = sortedQuotas.map((q) => {
      const typeStr = q.number === 0 ? 'Separación' : q.type === 'inicial' ? `Inicial #${q.number}` : `Ordinaria #${q.number}`;
      const formattedDueDate = q.dueDate
        ? new Date(q.dueDate).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' })
        : 'N/A';
      const formattedValue = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(q.value);
      return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">${typeStr}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">${formattedDueDate}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 13px; font-weight: bold; text-align: right;">${formattedValue}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 13px; text-align: center;">${q.status === 'pagado' ? '✅ PAGADO' : '⏳ Pendiente'}</td>
        </tr>
      `;
    }).join('');

    let lotNumber = contract?.lot?.lotNumber;
    if (!lotNumber && contract?.lot) {
      const Lot = (await import('../models/Lot.js')).default;
      lotNumber = (await Lot.findById(contract.lot).select('lotNumber'))?.lotNumber;
    }
    const lotLabel = lotNumber ? ` - Lote ${lotNumber}` : '';
    const subject = updateReason
      ? `Tu plan de pagos se actualizó${lotLabel} - ${companyName}`
      : `Tu Plan de Pagos${lotLabel} - ${companyName}`;
    const intro = updateReason
      ? `Tu plan de pagos se actualizó: ${updateReason}. Este es el plan vigente; reemplaza al que recibiste antes:`
      : 'A continuación adjuntamos el detalle de tu plan de pagos acordado para la compra de tu inmueble:';
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 25px; border-radius: 10px;">
        <h2 style="color: #0284c7; text-align: center;">Tu Plan de Pagos - ${companyName}</h2>
        <p>Hola <strong>${client.name}</strong>,</p>
        <p>${intro}</p>
        
        <div style="margin: 25px 0;">
          <table style="width: 100%; border-collapse: collapse; text-align: left;">
            <thead>
              <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                <th style="padding: 8px; font-size: 12px; color: #64748b;">Concepto</th>
                <th style="padding: 8px; font-size: 12px; color: #64748b;">Vencimiento</th>
                <th style="padding: 8px; font-size: 12px; color: #64748b; text-align: right;">Valor</th>
                <th style="padding: 8px; font-size: 12px; color: #64748b; text-align: center;">Estado</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>

        <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 15px; margin-top: 25px;">
          Este mensaje fue enviado automáticamente. Por favor no respondas a esta dirección.<br>
          <strong>Operix Cobranza Inmobiliaria</strong>
        </p>
      </div>
    `;

    await sendEmail(client.email, subject, emailHtml);
    console.log(`[CLIENT_AUTH_HELPER] Payment plan email sent to: ${client.email}`);
  } catch (error) {
    console.error('[CLIENT_AUTH_HELPER] Error sending payment plan email:', error);
  }
};

/**
 * Force regenerates a validation token and sends welcome validation message via email, SMS, and WhatsApp.
 */
export const resendWelcomeNotification = async (client, tenantId, companyId) => {
  try {
    // Force generate new validation token
    client.validationToken = crypto.randomBytes(32).toString('hex');
    await client.save();

    const company = await Company.findById(companyId);
    const companyName = company?.name || 'Inmobiliaria';
    const companySlug = company?.slug || companyId.toString();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
    
    // Unique validation link
    const validationUrl = `${frontendUrl}/p/${companySlug}/validate-client?token=${client.validationToken}`;

    // Email Notification
    if (client.email) {
      const subject = `Verificación de Datos y Acceso al Portal - ${companyName}`;
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 25px; border-radius: 10px;">
          <h2 style="color: #0284c7; text-align: center;">¡Acceso a tu Portal - ${companyName}!</h2>
          <p>Hola <strong>${client.name}</strong>,</p>
          <p>Este es un recordatorio para validar tus datos de contacto y acceder a tu portal de cliente.</p>
          
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <h4 style="margin: 0 0 10px 0; color: #0f172a;">Tus Datos de Acceso al Portal:</h4>
            <p style="margin: 5px 0;"><strong>Usuario:</strong> ${client.email}</p>
            <p style="margin: 5px 0; font-size: 12px; color: #64748b;">(Usa tu contraseña o PIN temporal para ingresar)</p>
          </div>

          <p style="font-weight: bold; color: #0f172a; margin-top: 25px;">IMPORTANTE: Validación de tus Datos de Contacto</p>
          <p>Para asegurar que recibas tus estados de cuenta, recordatorios y comprobantes de pago sin inconvenientes, por favor verifica y valida tus datos haciendo clic en el siguiente botón:</p>
          
          <div style="text-align: center; margin: 25px 0;">
            <a href="${validationUrl}" style="background: #22c55e; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 14px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
              VALIDAR MIS DATOS
            </a>
          </div>

          <p style="font-size: 13px; color: #64748b;">
            O copia y pega esta dirección en tu navegador:<br>
            <a href="${validationUrl}" style="color: #0284c7; word-break: break-all;">${validationUrl}</a>
          </p>

          <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 15px; margin-top: 25px;">
            Este mensaje fue enviado automáticamente. Por favor no respondas a esta dirección.<br>
            <strong>Operix Cobranza Inmobiliaria</strong>
          </p>
        </div>
      `;
      
      await sendEmail(client.email, subject, emailHtml);
      console.log(`[CLIENT_AUTH_HELPER] Resent welcome validation email to: ${client.email}`);
    }

    // WhatsApp Notification
    if (client.phone) {
      const smsMessage = `Hola ${client.name}, recuerda validar tus datos de cliente para ${companyName} en: ${validationUrl}`;
      await sendWhatsApp(client.phone, smsMessage);
      console.log(`[CLIENT_AUTH_HELPER] Resent welcome validation WhatsApp to: ${client.phone}`);
    }
  } catch (error) {
    console.error('[CLIENT_AUTH_HELPER] Error in resendWelcomeNotification:', error);
    throw error;
  }
};
