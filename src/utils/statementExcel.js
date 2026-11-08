import XLSX from 'xlsx';
import { bogotaDay } from '../services/statementSummary.service.js';

const day = (date) => (date ? bogotaDay(date) : '');

const TYPE_LABELS = { inicial: 'Inicial', normal: 'Ordinaria' };

/**
 * Account statement as an Excel workbook: a summary sheet and the quotas,
 * built from the same summary as the PDF.
 */
export const buildStatementWorkbook = ({ client, company, summary }) => {
  const next = summary.nextQuota;
  const summaryRows = [
    ['Estado de cuenta', ''],
    ['Empresa', company?.name || ''],
    ['Cliente', client?.name || ''],
    ['Identificación', client?.idNumber || ''],
    ['Negociación', summary.projectName || ''],
    ['Inmueble', summary.lotLabel],
    ['Generado', day(summary.generatedAt)],
    ['', ''],
    ['Valor total', summary.totalValue],
    ['Pagado', summary.totalPaid],
    ['Saldo', summary.balance],
    ['Porcentaje pagado', summary.percentPaid / 100],
    ['', ''],
    ['Próxima cuota', next ? next.label : 'Sin cuotas pendientes'],
    ['Fecha de la próxima cuota', next ? day(next.dueDate) : ''],
    ['Valor pendiente de la próxima cuota', next ? next.pending : 0],
    ['', ''],
    ['Cuotas en mora', summary.overdueCount],
    ['Valor en mora', summary.overdueAmount],
    ['Días de atraso', summary.daysOverdue],
  ];

  const quotaRows = [
    ['Cuota', 'Tipo', 'Vencimiento', 'Valor', 'Pagado', 'Pendiente', 'Fecha de pago', 'Estado'],
    ...summary.quotas.map((q) => [
      q.label,
      TYPE_LABELS[q.type] || q.type || '',
      day(q.dueDate),
      q.value,
      q.paid,
      q.pending,
      q.state === 'pagada' ? day(q.paymentDate) : '',
      q.stateLabel,
    ]),
  ];

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet['!cols'] = [{ wch: 36 }, { wch: 48 }];
  // Money with thousands separators and the paid share as a percentage
  [9, 10, 11, 16, 19].forEach((row) => {
    const cell = summarySheet[`B${row}`];
    if (cell) cell.z = '#,##0';
  });
  if (summarySheet.B12) summarySheet.B12.z = '0%';

  const quotasSheet = XLSX.utils.aoa_to_sheet(quotaRows);
  quotasSheet['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 13 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }];
  for (let r = 2; r <= quotaRows.length; r += 1) {
    ['D', 'E', 'F'].forEach((col) => {
      const cell = quotasSheet[`${col}${r}`];
      if (cell) cell.z = '#,##0';
    });
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Resumen');
  XLSX.utils.book_append_sheet(workbook, quotasSheet, 'Cuotas');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

export const statementFileName = (summary, ext) =>
  `estado_cuenta_${summary.contractId.slice(-6).toUpperCase()}.${ext}`;

export const sendStatementWorkbook = (res, loaded) => {
  const buffer = buildStatementWorkbook(loaded);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${statementFileName(loaded.summary, 'xlsx')}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
};
