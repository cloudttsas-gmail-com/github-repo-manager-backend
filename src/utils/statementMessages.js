/**
 * WhatsApp and email texts of the account statement, built from the summary.
 */

const money = (value) => `$${Number(value || 0).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;

const shortDate = (date) => (date
  ? new Date(date).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' })
  : '');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const firstName = (client) => (client?.name || '').trim().split(/\s+/)[0] || 'cliente';

const nextQuotaLine = (summary) => {
  const next = summary.nextQuota;
  if (!next) return 'No tienes cuotas pendientes.';
  const due = next.dueDate ? `, ${next.overdue ? 'venció' : 'vence'} el ${shortDate(next.dueDate)}` : '';
  return `${next.label}${due}, por ${money(next.pending)}`;
};

const overdueLine = (summary) => {
  if (summary.overdueCount === 0) return null;
  const quotas = summary.overdueCount === 1 ? '1 cuota' : `${summary.overdueCount} cuotas`;
  const days = summary.daysOverdue === 1 ? '1 día' : `${summary.daysOverdue} días`;
  return `${quotas} en mora por ${money(summary.overdueAmount)} (${days} de atraso)`;
};

export const statementWhatsAppText = ({ client, companyName, summary }) => {
  const lines = [
    `Hola ${firstName(client)}, este es tu estado de cuenta de ${companyName}${summary.lotLabel !== 'N/A' ? ` (${summary.lotLabel})` : ''}:`,
    `Valor total: ${money(summary.totalValue)}`,
    `Pagado: ${money(summary.totalPaid)}`,
    `Saldo: ${money(summary.balance)}`,
    `Próxima cuota: ${nextQuotaLine(summary)}`,
  ];
  const overdue = overdueLine(summary);
  if (overdue) lines.push(`En mora: ${overdue}`);
  lines.push(`Descárgalo en PDF: ${summary.statementUrl}`);
  return lines.join('\n');
};

export const statementEmail = ({ client, companyName, summary }) => {
  const overdue = overdueLine(summary);
  const row = (label, value, color = '#333') => `
          <tr>
            <td style="padding: 8px 10px; border-bottom: 1px solid #eee; color: #64748b;">${label}</td>
            <td style="padding: 8px 10px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: ${color};">${value}</td>
          </tr>`;

  const html = `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 560px; margin: 0 auto; border: 1px solid #eee; padding: 24px; border-radius: 8px;">
      <h2 style="color: #2c3e50; margin-top: 0;">Estado de cuenta</h2>
      <p>Hola ${escapeHtml(firstName(client))},</p>
      <p>Este es el estado de cuenta de tu inmueble con ${escapeHtml(companyName)}${summary.lotLabel !== 'N/A' ? ` (${escapeHtml(summary.lotLabel)})` : ''}.</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin: 16px 0;">
        ${row('Valor total', money(summary.totalValue))}
        ${row('Pagado', money(summary.totalPaid), '#2e7d32')}
        ${row('Saldo', money(summary.balance), '#c62828')}
        ${row('Próxima cuota', escapeHtml(nextQuotaLine(summary)))}
        ${overdue ? row('En mora', escapeHtml(overdue), '#c62828') : ''}
      </table>
      <div style="text-align: center; margin: 24px 0;">
        <a href="${summary.statementUrl}" style="background: #2e7d32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin: 4px;">Descargar PDF</a>
        <a href="${summary.excelUrl}" style="background: #1565c0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin: 4px;">Descargar Excel</a>
      </div>
      <p style="font-size: 12px; color: #64748b;">Este resumen muestra tu estado de cuenta en la fecha de envío. No es un paz y salvo.</p>
    </div>
  `;

  const lotPart = summary?.lotNumber ? ` - Lote ${summary.lotNumber}` : '';
  return { subject: `Tu estado de cuenta${lotPart} - ${companyName}`, html };
};
