import Quota from '../models/Quota.js';
import Company from '../models/Company.js';
import Contract from '../models/Contract.js';
import { sendEmail, sendWhatsApp } from './notifications.js';
import { publicLinkUrl, signReceiptUrl } from './publicLinks.js';

/**
 * Send a single consolidated notification when multiple quotas are paid/processed in cascade
 */
export const sendConsolidatedPaymentNotifications = async (req, paidQuotaIds, companyId) => {
  try {
    if (!paidQuotaIds || paidQuotaIds.length === 0) return false;

    const quotas = await Quota.find({ _id: { $in: paidQuotaIds } })
      .populate({
        path: 'contract',
        populate: [
          { path: 'client' },
          { path: 'lot' },
        ],
      })
      .sort({ type: 1, number: 1 });

    if (quotas.length === 0) return false;

    const firstQuota = quotas[0];
    const contract = firstQuota.contract;
    if (!contract || !contract.client) return false;

    const client = contract.client;
    const company = await Company.findById(companyId);
    const companyName = company?.name || 'Inmobiliaria';

    const apiUrl = process.env.API_URL || `${req.protocol}://${req.get('host')}`;
    const statementUrl = publicLinkUrl('statement', contract._id, apiUrl);

    // Ensure all quotas have receiptUrl set
    const totalAmount = quotas.reduce((sum, q) => sum + (q.amountPaid || q.value), 0);
    const quotaDetailsList = [];

    for (const q of quotas) {
      const signedUrl = q.receiptUrl ? signReceiptUrl(q.receiptUrl) : publicLinkUrl('receipt', q._id, apiUrl);
      if (q.receiptUrl !== signedUrl) {
        q.receiptUrl = signedUrl;
        await Quota.findByIdAndUpdate(q._id, { receiptUrl: q.receiptUrl });
      }
      quotaDetailsList.push(`Cuota #${q.number} (${q.type === 'inicial' ? 'inicial' : 'ordinaria'}): $${(q.amountPaid || q.value).toLocaleString()}`);
    }

    // Send WhatsApp
    if (client.phone) {
      const quotaNumbers = quotas.map(q => `#${q.number}`).join(', ');
      const message = `Cordial saludo ${client.name}, se ha registrado un pago consolidado por $${totalAmount.toLocaleString()} que cubre las cuotas: ${quotaNumbers} de ${companyName}. Estado de Cuenta: ${statementUrl}`;
      await sendWhatsApp(client.phone, message);
    }

    // Send Consolidated Email
    if (client.email) {
      const subject = `Comprobante de Pago Consolidado - ${companyName}`;
      const quotaRowsHtml = quotas.map(q => `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 10px; font-weight: bold;">Cuota #${q.number} (${q.type === 'inicial' ? 'inicial' : 'ordinaria'})</td>
          <td style="padding: 10px; text-align: right;">$${(q.amountPaid || q.value).toLocaleString()}</td>
          <td style="padding: 10px; text-align: center;"><a href="${q.receiptUrl}" style="color: #0284c7; text-decoration: none; font-weight: bold;">Ver Recibo</a></td>
        </tr>
      `).join('');

      const emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 25px; border-radius: 10px;">
          <h2 style="color: #22c55e; text-align: center;">¡Pago Recibido Exitosamente!</h2>
          <p>Hola <strong>${client.name}</strong>,</p>
          <p>Hemos procesado y aprobado un pago para tu inmueble en <strong>${companyName}</strong>. A continuación, te presentamos el resumen consolidado de las cuotas cubiertas por este pago:</p>
          
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
            <thead>
              <tr style="background: #f8fafc; border-bottom: 2px solid #cbd5e1;">
                <th style="padding: 10px; text-align: left;">Cuota</th>
                <th style="padding: 10px; text-align: right;">Monto</th>
                <th style="padding: 10px; text-align: center;">Recibo</th>
              </tr>
            </thead>
            <tbody>
              ${quotaRowsHtml}
            </tbody>
            <tfoot>
              <tr style="font-weight: bold; border-top: 2px solid #cbd5e1; background: #f8fafc;">
                <td style="padding: 10px;">TOTAL PAGADO:</td>
                <td style="padding: 10px; text-align: right;">$${totalAmount.toLocaleString()}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>

          <div style="text-align: center; margin: 25px 0;">
            <a href="${statementUrl}" style="background: #2e7d32; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 14px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
              VER ESTADO DE CUENTA COMPLETO
            </a>
          </div>

          <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 15px; margin-top: 25px;">
            Gracias por tu cumplimiento.<br>
            <strong>${companyName}</strong>
          </p>
        </div>
      `;
      await sendEmail(client.email, subject, emailHtml);
    }

    return true;
  } catch (error) {
    console.error('Error sending consolidated payment notifications:', error);
    return false;
  }
};
