import PDFDocument from 'pdfkit';
import { fileDisposition } from '../services/statementSummary.service.js';
import { loadPdfImage as loadImage } from './pdfImage.js';

/**
 * The buyer's account statement as a PDF. The inmobiliaria issues it (name, NIT, contact and
 * logo); the title names the lot, block and project. Same numbers as every other channel: they
 * all come from the statement summary.
 */

const PAGE = { width: 612, height: 792, margin: 40 };
const CONTENT = PAGE.width - PAGE.margin * 2;
const FOOTER_Y = 752;

// Operix palette (the app's light theme)
const C = {
  ink: '#0B1B33',
  text: '#3B4759',
  muted: '#6B7585',
  line: '#E3E0D8',
  surface: '#F7F5F0',
  brand: '#0A7258',
  green: '#0A7258',
  greenBg: '#E6F2EE',
  red: '#9A3A27',
  redBg: '#F7EAE6',
  amber: '#7A5300',
  amberBg: '#F6EEDB',
  blue: '#1C56C4',
  blueBg: '#E8EEFA',
};

const STATE_STYLE = {
  pagada: { label: 'Pagada', color: C.green, bg: C.greenBg },
  mora: { label: 'Vencida', color: C.red, bg: C.redBg },
  abonada: { label: 'Abonada', color: C.amber, bg: C.amberBg },
  pendiente: { label: 'Pendiente', color: C.text, bg: C.surface },
};

const money = (value) => `$${Number(value || 0).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** «15 mar 2027» in Bogotá. */
const date = (value) => {
  if (!value) return '—';
  const [y, m, d] = new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};

const initials = (name) => String(name || 'O').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/**
 * Generates the statement and streams it to the response.
 * @param {Object} data - from `toStatementPdfData`: { title, contractId, issuer, projectName, lotInfo, client, summary }
 */
export const generateStatementStream = async (data, res) => {
  const { title = 'Estado de cuenta', contractId, issuer = {}, projectName, lotInfo, client = {}, summary } = data;
  const [logo, projectLogo] = await Promise.all([loadImage(issuer.logo), loadImage(issuer.projectLogo)]);

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: PAGE.margin, bottom: 0, left: PAGE.margin, right: PAGE.margin },
    bufferPages: true,
    info: { Title: title, Author: issuer.name || 'Operix' },
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', fileDisposition('inline', title, 'pdf'));
  doc.pipe(res);

  const L = PAGE.margin;
  const R = PAGE.width - PAGE.margin;
  const text = (value, x, y, options = {}) => doc.text(String(value ?? ''), x, y, { lineBreak: false, ellipsis: true, ...options });
  const font = (name, size, color) => doc.font(name).fontSize(size).fillColor(color);
  const rule = (y, color = C.line, width = 0.6) => doc.save().moveTo(L, y).lineTo(R, y).lineWidth(width).strokeColor(color).stroke().restore();
  const box = (x, y, w, h, fill, radius = 6) => doc.save().roundedRect(x, y, w, h, radius).fill(fill).restore();
  const label = (value, x, y, w) => { font('Helvetica-Bold', 7, C.muted); text(value.toUpperCase(), x, y, { width: w, characterSpacing: 0.6 }); };

  // ---------------------------------------------------------------- header (first page)
  let y = PAGE.margin;
  if (logo) {
    try { doc.image(logo, L, y, { fit: [96, 44], valign: 'center' }); } catch { /* unreadable image: keep the text */ }
  } else {
    box(L, y + 2, 40, 40, C.ink, 8);
    font('Helvetica-Bold', 14, '#FFFFFF');
    text(initials(issuer.name), L, y + 15, { width: 40, align: 'center' });
  }
  const issuerX = L + (logo ? 108 : 52);
  font('Helvetica-Bold', 12, C.ink);
  text(issuer.name || 'Inmobiliaria', issuerX, y + 4, { width: 230 });
  font('Helvetica', 8, C.muted);
  const contact = [issuer.nit && `NIT ${issuer.nit}`, issuer.address, issuer.phone && `Tel. ${issuer.phone}`, issuer.email].filter(Boolean);
  text(contact.slice(0, 2).join('  ·  '), issuerX, y + 20, { width: 230 });
  text(contact.slice(2).join('  ·  '), issuerX, y + 31, { width: 230 });

  // Title on the right: «ESTADO DE CUENTA» and the property it is about
  font('Helvetica-Bold', 7.5, C.brand);
  text('ESTADO DE CUENTA', R - 220, y + 2, { width: 220, align: 'right', characterSpacing: 1 });
  font('Helvetica-Bold', 12.5, C.ink);
  const subject = title.replace(/^Estado de cuenta\s*/i, '') || projectName;
  doc.text(subject.charAt(0).toUpperCase() + subject.slice(1), R - 220, y + 14, { width: 220, align: 'right' });
  font('Helvetica', 8, C.muted);
  text(`Corte al ${date(summary.generatedAt)}  ·  Contrato ${String(contractId).slice(-6).toUpperCase()}`, R - 220, Math.max(doc.y + 3, y + 32), { width: 220, align: 'right' });

  y = Math.max(doc.y, y + 50) + 14;
  rule(y);
  y += 16;

  // ---------------------------------------------------------------- buyer and property
  const colW = (CONTENT - 24) / 2;
  const facts = (x, heading, rows) => {
    label(heading, x, y, colW);
    let rowY = y + 14;
    rows.filter(([, value]) => value).forEach(([name, value]) => {
      font('Helvetica', 8.5, C.muted);
      text(name, x, rowY, { width: 70 });
      font('Helvetica', 8.5, C.ink);
      text(value, x + 72, rowY, { width: colW - 72 });
      rowY += 13;
    });
    return rowY;
  };
  const leftEnd = facts(L, 'Comprador', [['Nombre', client.name || '—'], ['Documento', client.idNumber], ['Celular', client.phone], ['Correo', client.email]]);
  const projectX = L + colW + 24;
  const rightEnd = facts(projectX, 'Inmueble', [['Proyecto', projectName || '—'], ['Ubicación', lotInfo !== 'N/A' ? lotInfo : ''], ['Valor', money(summary.totalValue)]]);
  if (projectLogo) {
    try { doc.image(projectLogo, R - 60, y - 2, { fit: [60, 30], align: 'right' }); } catch { /* skip */ }
  }
  y = Math.max(leftEnd, rightEnd) + 14;

  // ---------------------------------------------------------------- balance
  const balanceH = 92;
  box(L, y, CONTENT, balanceH, C.surface, 8);
  label('Saldo pendiente', L + 18, y + 16, 200);
  font('Helvetica-Bold', 24, C.ink);
  text(money(summary.balance), L + 18, y + 30, { width: 230 });
  // Progress of what has been paid
  const barX = L + 18;
  const barW = 220;
  const barY = y + 66;
  const pct = Math.max(0, Math.min(100, summary.percentPaid || 0));
  box(barX, barY, barW, 6, C.line, 3);
  if (pct > 0) box(barX, barY, Math.max(6, (barW * pct) / 100), 6, C.brand, 3);
  font('Helvetica', 7.5, C.muted);
  text(`${pct}% pagado`, barX + barW + 8, barY - 1, { width: 70 });

  // Three figures on the right
  const stats = [
    ['Pagado', money(summary.totalPaid), C.green],
    ['Próxima cuota', summary.nextQuota ? money(summary.nextQuota.pending) : 'Sin cuotas', C.ink],
    ['Vence', summary.nextQuota ? date(summary.nextQuota.dueDate) : '—', summary.nextQuota?.overdue ? C.red : C.ink],
  ];
  const statW = 92;
  stats.forEach(([name, value, color], index) => {
    const x = R - 18 - statW * (3 - index);
    if (index > 0) doc.save().moveTo(x - 6, y + 18).lineTo(x - 6, y + balanceH - 18).lineWidth(0.6).strokeColor(C.line).stroke().restore();
    label(name, x, y + 26, statW - 12);
    font('Helvetica-Bold', 11, color);
    text(value, x, y + 40, { width: statW - 12 });
  });
  y += balanceH + 12;

  // ---------------------------------------------------------------- status
  const overdue = summary.overdueCount > 0;
  const paidOff = summary.status === 'pagado';
  const status = overdue
    ? {
      color: C.red, bg: C.redBg,
      text: `${summary.overdueCount === 1 ? 'Tienes 1 cuota vencida' : `Tienes ${summary.overdueCount} cuotas vencidas`} por ${money(summary.overdueAmount)}, con ${summary.daysOverdue} ${summary.daysOverdue === 1 ? 'día' : 'días'} de atraso.`,
    }
    : paidOff
      ? { color: C.green, bg: C.greenBg, text: 'Tu inmueble está pagado por completo.' }
      : { color: C.green, bg: C.greenBg, text: 'Estás al día con tus pagos.' };
  box(L, y, CONTENT, 26, status.bg, 6);
  doc.save().circle(L + 14, y + 13, 3).fill(status.color).restore();
  font('Helvetica-Bold', 9, status.color);
  text(status.text, L + 24, y + 9, { width: CONTENT - 36 });
  y += 26 + 16;

  // ---------------------------------------------------------------- initial and ordinary quotas
  const { initial, normal } = summary.breakdown;
  const groups = [['Cuota inicial', initial], ['Cuotas ordinarias', normal]].filter(([, g]) => g.count > 0);
  if (groups.length) {
    const groupW = (CONTENT - 12 * (groups.length - 1)) / groups.length;
    groups.forEach(([name, g], index) => {
      const x = L + index * (groupW + 12);
      doc.save().roundedRect(x, y, groupW, 44, 6).lineWidth(0.6).strokeColor(C.line).stroke().restore();
      label(name, x + 12, y + 10, groupW - 24);
      font('Helvetica', 8.5, C.text);
      text(`${g.paidCount} de ${g.count} pagadas  ·  ${money(g.paid)} de ${money(g.total)}`, x + 12, y + 25, { width: groupW - 24 });
    });
    y += 44 + 18;
  }

  // ---------------------------------------------------------------- quotas table
  const cols = [
    { key: 'label', title: 'Cuota', w: 104, align: 'left' },
    { key: 'due', title: 'Vence', w: 72, align: 'left' },
    { key: 'value', title: 'Valor', w: 78, align: 'right' },
    { key: 'paid', title: 'Pagado', w: 78, align: 'right' },
    { key: 'pending', title: 'Saldo', w: 74, align: 'right' },
    { key: 'paidOn', title: 'Pagada el', w: 68, align: 'right' },
    { key: 'state', title: 'Estado', w: CONTENT - 474, align: 'right' },
  ];
  const tableHeader = (top) => {
    font('Helvetica-Bold', 7, C.muted);
    let x = L;
    cols.forEach((col) => {
      text(col.title.toUpperCase(), x + (col.align === 'left' ? 0 : 0), top, { width: col.w - 8, align: col.align, characterSpacing: 0.5 });
      x += col.w;
    });
    rule(top + 13, C.ink, 0.8);
    return top + 20;
  };

  font('Helvetica-Bold', 11, C.ink);
  text('Plan de pagos', L, y, { width: 300 });
  font('Helvetica', 8, C.muted);
  text(`${summary.paidQuotasCount} de ${summary.quotasCount} cuotas pagadas`, R - 200, y + 2, { width: 200, align: 'right' });
  y = tableHeader(y + 22);

  const rowH = 19;
  (summary.quotas || []).forEach((q) => {
    if (y + rowH > FOOTER_Y - 12) {
      doc.addPage();
      // Short header on the following pages
      font('Helvetica-Bold', 9, C.ink);
      text(title, L, PAGE.margin, { width: CONTENT - 120 });
      font('Helvetica', 8, C.muted);
      text(client.name || '', R - 200, PAGE.margin, { width: 200, align: 'right' });
      rule(PAGE.margin + 16);
      y = tableHeader(PAGE.margin + 28);
    }
    const style = STATE_STYLE[q.state] || STATE_STYLE.pendiente;
    const values = {
      label: q.label,
      due: date(q.dueDate),
      value: money(q.value),
      paid: q.paid > 0 ? money(q.paid) : '—',
      pending: q.pending > 0 ? money(q.pending) : '—',
      paidOn: q.state === 'pagada' ? date(q.paymentDate) : '—',
    };
    let x = L;
    cols.forEach((col) => {
      if (col.key === 'state') {
        font('Helvetica-Bold', 7, style.color);
        const pillW = doc.widthOfString(style.label) + 14;
        const pillX = x + col.w - pillW;
        box(pillX, y + 3, pillW, 13, style.bg, 6.5);
        text(style.label, pillX, y + 6.5, { width: pillW, align: 'center' });
      } else {
        const strong = col.key === 'value' || (col.key === 'pending' && q.state === 'mora');
        font(strong ? 'Helvetica-Bold' : 'Helvetica', 8, col.key === 'pending' && q.state === 'mora' ? C.red : col.key === 'label' ? C.ink : C.text);
        text(values[col.key], x, y + 6, { width: col.w - 8, align: col.align });
      }
      x += col.w;
    });
    rule(y + rowH, C.line, 0.4);
    y += rowH;
  });
  if (!summary.quotas?.length) {
    font('Helvetica', 9, C.muted);
    text('Todavía no hay un plan de pagos para este inmueble.', L, y + 6, { width: CONTENT });
  }

  // ---------------------------------------------------------------- footer on every page
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(i);
    rule(FOOTER_Y);
    font('Helvetica', 6.8, C.muted);
    doc.text(
      `Emitido por ${issuer.name || 'la inmobiliaria'}${issuer.nit ? `, NIT ${issuer.nit}` : ''}. Muestra los pagos aprobados hasta la fecha de corte; no es un paz y salvo.`,
      L, FOOTER_Y + 8, { width: CONTENT - 90, lineBreak: true },
    );
    font('Helvetica-Bold', 7, C.text);
    text(`Página ${i + 1} de ${range.count}`, R - 90, FOOTER_Y + 8, { width: 90, align: 'right' });
  }

  doc.end();
};
