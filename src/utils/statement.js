import PDFDocument from 'pdfkit';

/**
 * Helper to format currency values as COP
 * @param {number} value - The numeric value to format
 * @returns {string} Formatted currency string
 */
const formatCurrency = (value) => {
  return `$ ${Number(value || 0).toLocaleString('es-CO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
};

/**
 * Generate a professional PDF account statement and stream it to the response.
 * @param {Object} data - Contract, client, lot, and quotas data
 * @param {Object} res - Express response object
 */
export const generateStatementStream = async (data, res) => {
  const {
    contractId,
    clientName,
    clientId,
    clientPhone,
    clientEmail,
    projectName,
    lotInfo,
    companyName,
    companyNit,
    companyAddress,
    companyPhone,
    companyLogo,
    // Financial numbers
    totalValue,
    totalPaid,
    totalPending,
    averageRecaudo,
    overdueCount = 0,
    overdueAmount = 0,
    daysOverdue = 0,
    // Breakdown
    valorTotalInicial,
    valorPagadoInicial,
    totalCuotasIniciales,
    cuotasInicialesPagadas,
    valorTotalCuotas,
    valorPagadoCuotas,
    totalCuotasNormales,
    cuotasNormalesPagadas,
    // Detailed list of quotas
    quotas,
  } = data;

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 35, bottom: 0, left: 35, right: 35 },
    bufferPages: true,
  });

  // Stream directly to response
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=estado_cuenta_${contractId}.pdf`);
  doc.pipe(res);

  // Helper to draw standard header on any page
  const drawPageHeader = (pageNumber, isFirstPage) => {
    // Top border accent bar
    doc.save();
    doc.fillColor('#2c3e50'); // Deep navy
    doc.rect(35, 15, 542, 6).fill();
    doc.restore();

    if (isFirstPage) {
      // ================= COMPANY LOGO =================
      if (companyLogo) {
        try {
          doc.image(companyLogo, 35, 35, { width: 75, height: 50 });
        } catch (err) {
          drawLogoPlaceholder();
        }
      } else {
        drawLogoPlaceholder();
      }

      // ================= COMPANY METADATA (Center-Left) =================
      doc.fillColor('#2c3e50');
      doc.fontSize(11)
         .font('Helvetica-Bold')
         .text((companyName || 'INMOBILIARIA').toUpperCase(), 125, 40, { width: 280, align: 'center' });
      
      doc.fontSize(8.5)
         .font('Helvetica')
         .fillColor('#757575');
      
      if (companyNit) {
        doc.text(`NIT ${companyNit}`, 125, 54, { width: 280, align: 'center' });
      }
      if (companyAddress) {
        doc.text(companyAddress, 125, 65, { width: 280, align: 'center' });
      }
      if (companyPhone) {
        doc.text(`Tel: ${companyPhone}`, 125, 76, { width: 280, align: 'center' });
      }

      // ================= DOCUMENT TITLE (Right) =================
      doc.fontSize(13)
         .font('Helvetica-Bold')
         .fillColor('#2c3e50')
         .text('ESTADO DE CUENTA', 410, 42, { width: 167, align: 'right' });

      const dateStr = new Date().toLocaleDateString('es-CO', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      doc.fontSize(7.5)
         .font('Helvetica')
         .fillColor('#757575')
         .text(`Generado: ${dateStr}`, 410, 58, { width: 167, align: 'right' });
         
      doc.fontSize(8.5)
         .font('Helvetica-Bold')
         .fillColor('#2e7d32')
         .text(`ID CONTRATO: ${contractId.toString().slice(-6).toUpperCase()}`, 410, 72, { width: 167, align: 'right' });
    } else {
      // Header for secondary pages
      doc.fillColor('#2c3e50');
      doc.fontSize(9)
         .font('Helvetica-Bold')
         .text(`ESTADO DE CUENTA - ${clientName.toUpperCase()}`, 35, 30, { width: 400 });
      
      doc.fontSize(8)
         .font('Helvetica')
         .fillColor('#757575')
         .text(`Contrato: #${contractId.toString().slice(-6).toUpperCase()} | Proyecto: ${projectName}`, 35, 42, { width: 400 });

      doc.moveTo(35, 53).lineTo(577, 53).lineWidth(0.5).strokeColor('#cccccc').stroke();
    }
  };

  const drawLogoPlaceholder = () => {
    doc.save();
    doc.lineWidth(0.5);
    doc.strokeColor('#cccccc');
    doc.dash(3, { space: 3 });
    doc.rect(35, 35, 75, 50).stroke();
    doc.fillColor('#757575');
    doc.fontSize(8);
    doc.font('Helvetica-Oblique');
    doc.text('Logo', 35, 56, { width: 75, align: 'center' });
    doc.restore();
  };

  // Draw first page header
  drawPageHeader(1, true);

  // ================= 1. CLIENT & PROJECT INFO CARD =================
  let currentY = 110;

  // Background and borders for Info Card
  doc.save();
  doc.fillColor('#f8f9fa');
  doc.rect(35, currentY, 542, 54).fill();
  doc.strokeColor('#e9ecef');
  doc.lineWidth(1);
  doc.rect(35, currentY, 542, 54).stroke();
  doc.restore();

  // Print Details inside Info Card
  doc.fontSize(8.5).fillColor('#495057');
  
  // Left Column
  doc.font('Helvetica-Bold').text('Nombre del Cliente:', 45, currentY + 10);
  doc.font('Helvetica').text(clientName || 'N/A', 150, currentY + 10);
  
  doc.font('Helvetica-Bold').text('Identificación / NIT:', 45, currentY + 22);
  doc.font('Helvetica').text(clientId || 'N/A', 150, currentY + 22);
  
  doc.font('Helvetica-Bold').text('Teléfono de Contacto:', 45, currentY + 34);
  doc.font('Helvetica').text(clientPhone || 'N/A', 150, currentY + 34);

  // Right Column
  doc.font('Helvetica-Bold').text('Proyecto / Negocio:', 310, currentY + 10);
  doc.font('Helvetica').text(projectName || 'N/A', 415, currentY + 10, { width: 155, height: 11, ellipsis: true });
  
  doc.font('Helvetica-Bold').text('Ubicación del Lote:', 310, currentY + 22);
  doc.font('Helvetica').text(lotInfo || 'N/A', 415, currentY + 22, { width: 155, height: 11, ellipsis: true });

  doc.font('Helvetica-Bold').text('Email:', 310, currentY + 34);
  doc.font('Helvetica').text(clientEmail || 'N/A', 415, currentY + 34, { width: 155, height: 11, ellipsis: true });

  currentY += 66;

  // ================= 2. FINANCIAL SUMMARY CARDS =================
  const cardWidth = 125;
  const cardHeight = 38;
  const gap = 14;

  const summaryData = [
    { label: 'Valor Total Cartera', val: formatCurrency(totalValue), color: '#2c3e50', bg: '#f8f9fa' },
    { label: 'Total Recaudado', val: formatCurrency(totalPaid), color: '#2e7d32', bg: '#e8f5e9' },
    { label: 'Saldo Pendiente', val: formatCurrency(totalPending), color: '#c62828', bg: '#ffebee' },
    { label: 'Porcentaje Recaudo', val: `${averageRecaudo}%`, color: '#6a1b9a', bg: '#f3e5f5' }
  ];

  summaryData.forEach((card, idx) => {
    const cardX = 35 + idx * (cardWidth + gap);
    
    doc.save();
    doc.fillColor(card.bg);
    doc.rect(cardX, currentY, cardWidth, cardHeight).fill();
    doc.strokeColor('#e9ecef');
    doc.lineWidth(0.8);
    doc.rect(cardX, currentY, cardWidth, cardHeight).stroke();
    doc.restore();

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#757575').text(card.label.toUpperCase(), cardX + 8, currentY + 8, { width: cardWidth - 16, align: 'center' });
    doc.fontSize(11).font('Helvetica-Bold').fillColor(card.color).text(card.val, cardX + 8, currentY + 20, { width: cardWidth - 16, align: 'center' });
  });

  currentY += 52;

  if (overdueCount > 0) {
    const plural = overdueCount === 1 ? 'cuota vencida' : 'cuotas vencidas';
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#c62828')
      .text(`EN MORA: ${overdueCount} ${plural} por ${formatCurrency(overdueAmount)}, ${daysOverdue} ${daysOverdue === 1 ? 'día' : 'días'} de atraso`, 35, currentY, { width: 542 });
    currentY += 16;
  }

  // ================= 3. FINANCING BREAKDOWN (SIDE-BY-SIDE BLOCKS) =================
  const blockW = 264;
  const blockH = 68;

  // Initial Quotas Block
  doc.save();
  doc.fillColor('#f3e5f5'); // Subtle purple-magenta hue
  doc.rect(35, currentY, blockW, blockH).fill();
  doc.strokeColor('#e1bee7');
  doc.rect(35, currentY, blockW, blockH).stroke();
  doc.restore();

  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#6a1b9a').text('CUOTAS INICIALES / SEPARACIÓN', 45, currentY + 8);
  doc.fontSize(8).font('Helvetica').fillColor('#495057');
  doc.text(`Cuotas pagadas:`, 45, currentY + 22);
  doc.font('Helvetica-Bold').text(`${cuotasInicialesPagadas} / ${totalCuotasIniciales}`, 150, currentY + 22);
  
  doc.font('Helvetica').text(`Monto recaudado:`, 45, currentY + 34);
  doc.font('Helvetica-Bold').fillColor('#2e7d32').text(formatCurrency(valorPagadoInicial), 150, currentY + 34);
  
  doc.font('Helvetica').fillColor('#495057').text(`Monto total inicial:`, 45, currentY + 46);
  doc.font('Helvetica-Bold').text(formatCurrency(valorTotalInicial), 150, currentY + 46);

  // Ordinary Quotas Block
  doc.save();
  doc.fillColor('#e3f2fd'); // Subtle blue hue
  doc.rect(313, currentY, blockW, blockH).fill();
  doc.strokeColor('#bbdefb');
  doc.rect(313, currentY, blockW, blockH).stroke();
  doc.restore();

  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#1565c0').text('CUOTAS ORDINARIAS / MENSUALES', 323, currentY + 8);
  doc.fontSize(8).font('Helvetica').fillColor('#495057');
  doc.text(`Cuotas pagadas:`, 323, currentY + 22);
  doc.font('Helvetica-Bold').text(`${cuotasNormalesPagadas} / ${totalCuotasNormales}`, 435, currentY + 22);
  
  doc.font('Helvetica').text(`Monto recaudado:`, 323, currentY + 34);
  doc.font('Helvetica-Bold').fillColor('#2e7d32').text(formatCurrency(valorPagadoCuotas), 435, currentY + 34);
  
  doc.font('Helvetica').fillColor('#495057').text(`Monto total ordinarias:`, 323, currentY + 46);
  doc.font('Helvetica-Bold').text(formatCurrency(valorTotalCuotas), 435, currentY + 46);

  currentY += 82;

  // ================= 4. TABLE PLAN DE PAGOS HEADERS =================
  doc.fontSize(10.5).font('Helvetica-Bold').fillColor('#2c3e50').text('DETALLE DEL PLAN DE PAGOS (CUOTAS)', 35, currentY);
  currentY += 14;

  const columns = {
    number: { x: 35, w: 40, align: 'center', label: 'CUOTA' },
    type: { x: 75, w: 90, align: 'left', label: 'TIPO' },
    dueDate: { x: 165, w: 85, align: 'center', label: 'VENCIMIENTO' },
    value: { x: 250, w: 95, align: 'right', label: 'VALOR CUOTA' },
    amountPaid: { x: 345, w: 95, align: 'right', label: 'VALOR PAGADO' },
    paymentDate: { x: 440, w: 75, align: 'center', label: 'FECHA PAGO' },
    status: { x: 515, w: 62, align: 'center', label: 'ESTADO' }
  };

  const drawTableHeader = (y) => {
    // Background bar
    doc.save();
    doc.fillColor('#2c3e50');
    doc.rect(35, y, 542, 18).fill();
    doc.restore();

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#ffffff');
    Object.values(columns).forEach(col => {
      doc.text(col.label, col.x, y + 5, { width: col.w, align: col.align });
    });
  };

  drawTableHeader(currentY);
  currentY += 18;

  // ================= 5. DRAW TABLE ROWS =================
  const rowHeight = 16;
  let pageIndex = 1;

  quotas.forEach((q, index) => {
    // If the next row is going to overflow, trigger page break
    // Bottom margin is 40 points, so max Y is 792 - 40 = 752. 
    // We check if currentY + rowHeight > 740 to be absolutely safe.
    if (currentY + rowHeight > 740) {
      doc.addPage();
      pageIndex++;
      drawPageHeader(pageIndex, false);
      currentY = 68; // Start below the secondary header
      drawTableHeader(currentY);
      currentY += 18;
    }

    // Zebra striping background
    if (index % 2 === 1) {
      doc.save();
      doc.fillColor('#f8f9fa');
      doc.rect(35, currentY, 542, rowHeight).fill();
      doc.restore();
    }

    // Row borders bottom line
    doc.save();
    doc.lineWidth(0.3);
    doc.strokeColor('#e9ecef');
    doc.moveTo(35, currentY + rowHeight).lineTo(577, currentY + rowHeight).stroke();
    doc.restore();

    // Map Quota details
    const isSeparation = q.number === 0 || q.number === '0';
    const numText = isSeparation ? 'SEPAR.' : `${q.number}`;
    const typeText = q.type === 'inicial' ? (isSeparation ? 'Separación' : 'Cuota Inicial') : 'Ordinaria';
    const dueStr = q.dueDate ? new Date(q.dueDate).toISOString().split('T')[0] : 'N/A';
    
    let payDateStr = '-';
    if (q.status === 'pagado') {
      const pDate = q.paymentDate || q.updatedAt;
      payDateStr = pDate ? new Date(pDate).toISOString().split('T')[0] : 'N/A';
    }

    const valueStr = formatCurrency(q.value);
    const amountPaidStr = formatCurrency(q.amountPaid || 0);

    // Color and text for status
    let statusText = 'PENDIENTE';
    let statusColor = '#6c757d'; // Grey

    // Labels from the statement summary win, so the PDF says what every other channel says
    if (q.statusLabel) {
      statusText = q.statusLabel;
      if (q.statusLabel === 'PAGADA') statusColor = '#2e7d32';
      else if (q.statusLabel === 'EN MORA') statusColor = '#c62828';
      else if (q.statusLabel === 'ABONADA') statusColor = '#ef6c00';
    } else if (q.status === 'pagado') {
      statusText = 'PAGADA';
      statusColor = '#2e7d32'; // Green
    } else if (q.status === 'mora' || (q.status === 'pendiente' && q.dueDate && new Date(q.dueDate) < new Date())) {
      statusText = 'EN MORA';
      statusColor = '#c62828'; // Red
    }

    doc.fontSize(7.5).font('Helvetica').fillColor('#495057');

    // Draw row cell values
    doc.text(numText, columns.number.x, currentY + 4, { width: columns.number.w, align: columns.number.align });
    doc.text(typeText, columns.type.x, currentY + 4, { width: columns.type.w, align: columns.type.align });
    doc.text(dueStr, columns.dueDate.x, currentY + 4, { width: columns.dueDate.w, align: columns.dueDate.align });
    
    doc.font('Helvetica-Bold');
    doc.text(valueStr, columns.value.x, currentY + 4, { width: columns.value.w, align: columns.value.align });
    
    doc.font('Helvetica').fillColor(q.status === 'pagado' ? '#2e7d32' : '#495057');
    doc.text(amountPaidStr, columns.amountPaid.x, currentY + 4, { width: columns.amountPaid.w, align: columns.amountPaid.align });
    
    doc.font('Helvetica').fillColor('#495057');
    doc.text(payDateStr, columns.paymentDate.x, currentY + 4, { width: columns.paymentDate.w, align: columns.paymentDate.align });
    
    // Status text colored with bold style
    doc.font('Helvetica-Bold').fillColor(statusColor);
    doc.text(statusText, columns.status.x, currentY + 4, { width: columns.status.w, align: columns.status.align });

    currentY += rowHeight;
  });

  // ================= 6. GENERATE PAGE NUMBERS & FOOTER ON ALL PAGES =================
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    
    // Page footer background or lines
    doc.save();
    doc.lineWidth(0.5);
    doc.strokeColor('#cccccc');
    doc.moveTo(35, 755).lineTo(577, 755).stroke();
    doc.restore();

    doc.fontSize(7).font('Helvetica').fillColor('#757575');
    doc.text(
      'Este documento es una representación del estado de cuenta de su financiación a la fecha y hora indicadas. No constituye un paz y salvo total.',
      35,
      762,
      { width: 440 }
    );
    
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#2c3e50');
    doc.text(
      `Página ${i + 1} de ${range.count}`,
      480,
      762,
      { width: 97, align: 'right' }
    );
  }

  // End and finalize the document
  doc.end();
};
