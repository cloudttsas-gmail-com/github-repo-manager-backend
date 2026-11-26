import PDFDocument from 'pdfkit';
import { loadPdfImage } from './pdfImage.js';

/**
 * Convert number to Spanish words.
 * @param {number} num - The number to convert
 * @returns {string} The number in words
 */
function numeroALetras(num) {
  const Unidades = (num) => {
    switch (num) {
      case 1: return 'UN';
      case 2: return 'DOS';
      case 3: return 'TRES';
      case 4: return 'CUATRO';
      case 5: return 'CINCO';
      case 6: return 'SEIS';
      case 7: return 'SIETE';
      case 8: return 'OCHO';
      case 9: return 'NUEVE';
      default: return '';
    }
  };

  const Decenas = (num) => {
    const decena = Math.floor(num / 10);
    const unidad = num - (decena * 10);
    switch (decena) {
      case 1:
        switch (unidad) {
          case 0: return 'DIEZ';
          case 1: return 'ONCE';
          case 2: return 'DOCE';
          case 3: return 'TRECE';
          case 4: return 'CATORCE';
          case 5: return 'QUINCE';
          default: return 'DIECI' + Unidades(unidad);
        }
      case 2:
        if (unidad === 0) return 'VEINTE';
        return 'VEINTI' + Unidades(unidad);
      case 3: return DecenasY('TREINTA', unidad);
      case 4: return DecenasY('CUARENTA', unidad);
      case 5: return DecenasY('CINCUENTA', unidad);
      case 6: return DecenasY('SESENTA', unidad);
      case 7: return DecenasY('SETENTA', unidad);
      case 8: return DecenasY('OCHENTA', unidad);
      case 9: return DecenasY('NOVENTA', unidad);
      case 0: return Unidades(unidad);
    }
  };

  const DecenasY = (strSin, numUnidad) => {
    if (numUnidad > 0) return strSin + ' Y ' + Unidades(numUnidad);
    return strSin;
  };

  const Centenas = (num) => {
    const centenas = Math.floor(num / 100);
    const decenas = num - (centenas * 100);
    switch (centenas) {
      case 1:
        if (decenas > 0) return 'CIENTO ' + Decenas(decenas);
        return 'CIEN';
      case 2: return 'DOSCIENTOS ' + Decenas(decenas);
      case 3: return 'TRESCIENTOS ' + Decenas(decenas);
      case 4: return 'CUATROCIENTOS ' + Decenas(decenas);
      case 5: return 'QUINIENTOS ' + Decenas(decenas);
      case 6: return 'SEISCIENTOS ' + Decenas(decenas);
      case 7: return 'SETECIENTOS ' + Decenas(decenas);
      case 8: return 'OCHOCIENTOS ' + Decenas(decenas);
      case 9: return 'NOVECIENTOS ' + Decenas(decenas);
      case 0: return Decenas(decenas);
    }
  };

  const Seccion = (num, divisor, strSingular, strPlural) => {
    const cientos = Math.floor(num / divisor);
    const resto = num - (cientos * divisor);
    let letras = '';
    if (cientos > 0) {
      if (cientos > 1) letras = Centenas(cientos) + ' ' + strPlural;
      else letras = strSingular;
    } else {
      letras = Centenas(resto);
    }
    if (resto > 0) letras += '';
    return letras;
  };

  const Miles = (num) => {
    const divisor = 1000;
    const cientos = Math.floor(num / divisor);
    const resto = num - (cientos * divisor);
    const strMiles = Seccion(num, divisor, 'UN MIL', 'MIL');
    const strCentenas = Centenas(resto);
    if (strMiles === '') return strCentenas;
    return strMiles + ' ' + strCentenas;
  };

  const Millones = (num) => {
    const divisor = 1000000;
    const cientos = Math.floor(num / divisor);
    const resto = num - (cientos * divisor);
    const strMillones = Seccion(num, divisor, 'UN MILLON', 'MILLONES');
    const strMiles = Miles(resto);
    if (strMillones === '') return strMiles;
    return strMillones + ' ' + strMiles;
  };

  const entero = Math.floor(num);
  let resultado = Millones(entero);
  
  if (resultado.trim() === '') resultado = 'CERO';
  
  return resultado + ' PESOS M/CTE';
}

/**
 * Generate a PDF cash receipt and stream it to the response.
 * @param {Object} data - Payment and client data
 * @param {Object} res - Express response object
 */
export const generateReceiptStream = async (data, res) => {
  const {
    receiptNumber,
    quotaNumber,
    amount,
    date,
    clientName,
    clientId,
    clientPhone,
    clientAddress,
    clientCity,
    companyName,
    companyNit,
    companyAddress,
    companyPhone,
    lotInfo,
    projectName,
    propertyType = 'lotes',
    paymentBank,
    observations,
    paymentCapture,
  } = data;

  const doc = new PDFDocument({ 
    size: 'LETTER',
    margins: { top: 35, bottom: 0, left: 35, right: 35 } 
  });

  // Stream directly to response
  const fileNum = receiptNumber !== undefined && receiptNumber !== null ? receiptNumber : quotaNumber;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=recibo_caja_${fileNum}.pdf`);
  doc.pipe(res);

  // ================= INMOBILIARIA LOGO (Dynamic / Placeholder) =================
  const logoImage = await loadPdfImage(data.companyLogo);
  if (logoImage) {
    try {
      // Render the company's logo if provided
      doc.image(logoImage, 35, 35, { fit: [75, 50] });
    } catch (err) {
      // Fallback placeholder on image load/parse error
      doc.save();
      doc.lineWidth(0.5);
      doc.strokeColor('#cccccc');
      doc.dash(3, { space: 3 });
      doc.rect(35, 35, 75, 50).stroke();
      doc.fillColor('#757575');
      doc.fontSize(8);
      doc.font('Helvetica-Oblique');
      doc.text('Logo no cargado', 35, 56, { width: 75, align: 'center' });
      doc.restore();
    }
  } else {
    // Standard clean placeholder when no logo is loaded
    doc.save();
    doc.lineWidth(0.5);
    doc.strokeColor('#cccccc');
    doc.dash(3, { space: 3 });
    doc.rect(35, 35, 75, 50).stroke();
    doc.fillColor('#757575');
    doc.fontSize(8);
    doc.font('Helvetica-Oblique');
    doc.text('Logo no cargado', 35, 56, { width: 75, align: 'center' });
    doc.restore();
  }

  // ================= COMPANY METADATA (Center-Left) =================
  doc.fillColor('#000000');
  doc.fontSize(11)
     .font('Helvetica-Bold')
     .text((companyName || '').toUpperCase(), 125, 40, { width: 280, align: 'center' });
  
  doc.fontSize(9)
     .font('Helvetica');
  
  if (companyNit) {
    doc.text(`NIT ${companyNit}`, 125, 54, { width: 280, align: 'center' });
  }
  if (companyAddress) {
    doc.text(companyAddress, 125, 66, { width: 280, align: 'center' });
  }
  if (companyPhone) {
    doc.text(`Tel: ${companyPhone}`, 125, 78, { width: 280, align: 'center' });
  }

  // ================= RECEIPT TITLE & NUMBER (Right) =================
  doc.fontSize(14)
     .font('Helvetica-Bold')
     .fillColor('#212121')
     .text('Recibo Caja/Ingreso', 410, 45, { width: 167, align: 'right' });
  
  const isSeparation = Number(quotaNumber) === 0 || quotaNumber === '0' || quotaNumber === 'SEPARACIÓN';
  // «SEPARACIÓN, 1» when one payment covered several quotas
  const severalQuotas = String(quotaNumber ?? '').includes(',');
  const receiptLabel = receiptNumber !== undefined && receiptNumber !== null
    ? `No. ${receiptNumber}`
    : (isSeparation ? 'No SEPARACIÓN' : `No ${quotaNumber}`);

  doc.fontSize(12)
     .font('Helvetica-Bold')
     .fillColor('#2e7d32')
     .text(receiptLabel, 410, 68, { width: 167, align: 'right' });

  // ================= GRID CONTAINER (Client & Payment Info) =================
  const gridY = 120;
  
  // Fill background headers with elegant subtle grey
  doc.save();
  doc.fillColor('#f0f0f0');
  doc.rect(35, gridY, 75, 65).fill();      // Left labels vertical column
  doc.rect(230, gridY + 21, 60, 44).fill(); // Middle labels columns
  doc.rect(400, gridY, 177, 21).fill();     // Right column headers
  doc.restore();

  // Draw Grid Borders
  doc.save();
  doc.lineWidth(0.5);
  doc.strokeColor('#999999');
  
  doc.rect(35, gridY, 542, 65).stroke(); // Outer box
  
  // Row dividers
  doc.moveTo(35, gridY + 21).lineTo(400, gridY + 21).stroke();
  doc.moveTo(35, gridY + 43).lineTo(400, gridY + 43).stroke();
  doc.moveTo(400, gridY + 21).lineTo(577, gridY + 21).stroke();
  
  // Vertical column dividers
  doc.moveTo(110, gridY).lineTo(110, gridY + 65).stroke(); // Labels border
  doc.moveTo(230, gridY + 21).lineTo(230, gridY + 65).stroke();
  doc.moveTo(290, gridY + 21).lineTo(290, gridY + 65).stroke();
  doc.moveTo(400, gridY).lineTo(400, gridY + 65).stroke(); // Right block border
  doc.moveTo(488, gridY).lineTo(488, gridY + 65).stroke(); // Right columns separator
  
  doc.restore();

  // Print Texts in Grid
  doc.fontSize(8.5).fillColor('#212121');
  
  // Row 1
  doc.font('Helvetica-Bold').text('Recibimos de', 38, gridY + 6);
  doc.font('Helvetica-Bold').text((clientName || '').toUpperCase(), 115, gridY + 6);
  
  // Row 2
  doc.font('Helvetica-Bold').text('C.C. / NIT', 38, gridY + 27);
  doc.font('Helvetica').text(clientId || '', 115, gridY + 27);
  doc.font('Helvetica-Bold').text('Teléfono', 233, gridY + 27);
  doc.font('Helvetica').text(clientPhone || '', 295, gridY + 27);
  
  // Row 3
  doc.font('Helvetica-Bold').text('Dirección', 38, gridY + 49);
  doc.font('Helvetica').text(clientAddress || '', 115, gridY + 49, { width: 110, height: 14, ellipsis: true });
  doc.font('Helvetica-Bold').text('Ciudad', 233, gridY + 49);
  doc.font('Helvetica').text(clientCity || '', 295, gridY + 49, { width: 100, height: 14, ellipsis: true });
  
  // Right Column Block Header
  doc.font('Helvetica-Bold').text('Fecha recibo', 400, gridY + 6, { width: 88, align: 'center' });
  doc.font('Helvetica-Bold').text('Forma de pago', 488, gridY + 6, { width: 89, align: 'center' });
  
  // Right Column Block Values
  const formattedDate = date ? new Date(date).toISOString().split('T')[0] : '';
  doc.font('Helvetica').text(formattedDate, 400, gridY + 32, { width: 88, align: 'center' });
  doc.font('Helvetica').text(paymentBank || 'Transferencia', 488, gridY + 32, { width: 89, align: 'center' });

  // ================= VALUE ROW =================
  const valueY = 195;
  
  // Background for labels
  doc.save();
  doc.fillColor('#f0f0f0');
  doc.rect(35, valueY, 75, 25).fill();
  doc.restore();

  // Borders
  doc.save();
  doc.lineWidth(0.5);
  doc.strokeColor('#999999');
  doc.rect(35, valueY, 542, 25).stroke();
  doc.moveTo(110, valueY).lineTo(110, valueY + 25).stroke();
  doc.moveTo(477, valueY).lineTo(477, valueY + 25).stroke();
  doc.restore();

  // Print values
  doc.fontSize(8.5).font('Helvetica-Bold').text('El valor de', 38, valueY + 8);
  doc.fontSize(8.5).font('Helvetica').text(numeroALetras(amount), 115, valueY + 8, { width: 355, height: 15, ellipsis: true });
  doc.fontSize(10).font('Helvetica-Bold').text(
    `$ ${amount.toLocaleString('es-CO', { minimumFractionDigits: 2 })}`,
    482, valueY + 7,
    { width: 90, align: 'right' }
  );

  // ================= CONCEPT TABLE =================
  const tableY = 230;
  
  // Table Header Background
  doc.save();
  doc.fillColor('#f0f0f0');
  doc.rect(35, tableY, 542, 20).fill();
  doc.restore();

  // Table Borders
  doc.save();
  doc.lineWidth(0.5);
  doc.strokeColor('#999999');
  doc.rect(35, tableY, 542, 20).stroke(); // Header border
  doc.moveTo(477, tableY).lineTo(477, tableY + 70).stroke(); // Column divider
  doc.rect(35, tableY + 20, 542, 50).stroke(); // Body border
  doc.moveTo(35, tableY + 45).lineTo(577, tableY + 45).stroke(); // Total COP separator
  doc.restore();

  // Headers
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#212121');
  doc.text('Concepto', 35, tableY + 6, { width: 442, align: 'center' });
  doc.text('Valor', 477, tableY + 6, { width: 100, align: 'center' });

  // Rows Content
  doc.fontSize(8.5).font('Helvetica').fillColor('#212121');
  const projectConceptPrefix = projectName ? `Proyecto ${projectName} - ` : '';
  const noun = { lotes: 'Lote', casas: 'Casa', apartamentos: 'Apartamento', locales: 'Local' }[propertyType] || 'Inmueble';
  const concept = severalQuotas ? `Abono cuotas ${String(quotaNumber).replace('SEPARACIÓN', 'separación')}` : isSeparation ? 'Abono de separación' : `Abono cuota ${quotaNumber}`;
  doc.text(`${concept} - ${projectConceptPrefix}${noun}: ${lotInfo}`, 40, tableY + 27, { width: 432, height: 16, ellipsis: true });
  doc.text(
    `$ ${amount.toLocaleString('es-CO', { minimumFractionDigits: 2 })}`,
    477, tableY + 27,
    { width: 95, align: 'right' }
  );

  // Total Row
  doc.fontSize(8.5).font('Helvetica-Bold').text('Total COP', 350, tableY + 53, { width: 120, align: 'right' });
  doc.text(
    `$ ${amount.toLocaleString('es-CO', { minimumFractionDigits: 2 })}`,
    477, tableY + 53,
    { width: 95, align: 'right' }
  );

  // ================= OBSERVATIONS BOX =================
  const obsY = 310;
  
  doc.save();
  doc.lineWidth(0.5);
  doc.strokeColor('#999999');
  doc.rect(35, obsY, 542, 60).stroke();
  doc.restore();

  doc.fontSize(8.5).font('Helvetica-Bold').text('Observaciones:', 40, obsY + 6);
  doc.fontSize(8.5).font('Helvetica').text(
    observations || `Pago registrado el ${formattedDate}.`,
    40, obsY + 18,
    { width: 532, height: 38, lineGap: 2 }
  );

  // ================= GENERAL INFORMATION & ATTACHMENTS (Bottom Panel) =================
  const bottomY = 385;
  
  // Box 1: INFORMACIÓN GENERAL
  doc.save();
  doc.lineWidth(0.5);
  doc.strokeColor('#cccccc');
  doc.rect(35, bottomY, 260, 60).stroke();
  doc.restore();

  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#757575').text('INFORMACIÓN GENERAL', 40, bottomY + 6);
  doc.fontSize(8).font('Helvetica').fillColor('#757575').text('Cliente', 40, bottomY + 18);
  doc.text('Proyecto', 40, bottomY + 30);
  doc.text('Contacto', 40, bottomY + 42);
  
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#2e7d32').text((clientName || '').toUpperCase(), 100, bottomY + 18, { width: 185, ellipsis: true });
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#2c3e50').text((projectName || 'N/A').toUpperCase(), 100, bottomY + 30, { width: 185, ellipsis: true });
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#212121').text(clientPhone || '-', 100, bottomY + 42);

  // Box 2: ANEXOS
  doc.save();
  doc.lineWidth(0.5);
  doc.strokeColor('#cccccc');
  doc.rect(305, bottomY, 272, 60).stroke();
  doc.restore();

  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#757575').text('ANEXOS', 310, bottomY + 6);
  if (paymentCapture) {
    const isPdf = paymentCapture.toLowerCase().endsWith('.pdf') || paymentCapture.toLowerCase().includes('.pdf?');
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#2e7d32').text('COMPROBANTE ADJUNTO  ✓', 310, bottomY + 22);
    if (isPdf) {
      doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#007cba').text('Ver archivo PDF adjunto', 310, bottomY + 38, { link: paymentCapture });
    } else {
      doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#2e7d32').text('Imagen adjunta (Ver pág. 2)', 310, bottomY + 38);
    }
  } else {
    doc.fontSize(8.5).font('Helvetica').fillColor('#757575').text('Sin archivo adjunto  📎', 310, bottomY + 22);
    doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#9e9e9e').text('Comprobante validado electrónicamente en sistema.', 310, bottomY + 38);
  }

  // ================= FOOTER =================
  doc.fontSize(7.5)
     .font('Helvetica')
     .fillColor('#9e9e9e')
     .text('Este documento es un comprobante de pago oficial emitido de manera electrónica.', 35, 740, { align: 'center', width: 542 });
  doc.text(`Generado el ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`, { align: 'center', width: 542 });

  // ================= RENDER ATTACHMENT IF IMAGE =================
  if (paymentCapture) {
    const isPdf = paymentCapture.toLowerCase().endsWith('.pdf') || paymentCapture.toLowerCase().includes('.pdf?');
    if (!isPdf) {
      try {
        const response = await fetch(paymentCapture);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const imageBuffer = Buffer.from(arrayBuffer);

          doc.addPage({
            size: 'LETTER',
            margins: { top: 35, bottom: 0, left: 35, right: 35 }
          });

          // Header for Page 2
          doc.save();
          doc.fillColor('#2c3e50');
          doc.rect(35, 15, 542, 6).fill();
          doc.restore();

          doc.fontSize(11)
             .font('Helvetica-Bold')
             .fillColor('#2c3e50')
             .text('ANEXO: COMPROBANTE DE PAGO', 35, 35);

          doc.fontSize(8.5)
             .font('Helvetica')
             .fillColor('#757575')
             .text(`Recibo No. ${fileNum} | Cliente: ${clientName.toUpperCase()}`, 35, 50);

          doc.moveTo(35, 62).lineTo(577, 62).lineWidth(0.5).strokeColor('#cccccc').stroke();

          // Render the image fitted to the printable area (Letter: 612 x 792)
          doc.image(imageBuffer, 35, 80, {
            fit: [542, 650],
            align: 'center',
            valign: 'center'
          });
        }
      } catch (err) {
        console.error('[RECEIPT_PDF_IMAGE_ATTACH_ERROR]', err);
        // Do not crash, print warning on fallback page
        doc.addPage({
          size: 'LETTER',
          margins: { top: 35, bottom: 0, left: 35, right: 35 }
        });
        doc.fontSize(10).fillColor('#c62828').text('Error al cargar la imagen del comprobante adjunto: ' + err.message, 35, 80);
      }
    }
  }

  doc.end();
};
