import XLSX from 'xlsx';

/**
 * Generates an Excel workbook buffer in Siigo import format for approved payments (PaymentAttempt).
 * 
 * @param {Array} paymentAttempts - Array of populated PaymentAttempt documents
 * @param {Object} config - Config parameters
 * @param {string} config.comprobanteTipo - Default '14'
 * @param {string} config.cuentaCartera - Default '13050502'
 * @param {string} config.centroCostos - Default '001'
 * @param {string} config.defaultCuentaBanco - Default '11200501'
 * @param {Array} config.companyBankAccounts - Company's bank accounts configuration
 * @returns {Buffer} Excel workbook buffer
 */
export const generateSiigoExcel = (paymentAttempts, config = {}) => {
  const {
    comprobanteTipo = '14',
    cuentaCartera = '13050502',
    centroCostos = '001',
    defaultCuentaBanco = '11200501',
    companyBankAccounts = []
  } = config;

  const headers = [
    'Tipo de comprobante',
    'Consecutivo comprobante',
    'Fecha de elaboración',
    'Sigla moneda',
    'Tasa de cambio',
    'Código cuenta contable',
    'Identificación tercero',
    'Sucursal',
    'Código producto',
    'Código bodega',
    'Acción',
    'Cantidad producto',
    'Prefijo',
    'Consecutivo',
    'No. cuota',
    'Fecha vencimiento',
    'Código impuesto',
    'Código grupo',
    'Código activo fijo',
    'Descripción',
    'Código centro/subcentro de costos',
    'Débito',
    'Crédito',
    'Observaciones',
    'Base gravable libro compra/ventas',
    'Base exenta libro compra/ventas',
    'Mes de cierre'
  ];

  const rows = [headers];

  const formatDate = (date) => {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = d.getFullYear();
    return `${month}/${day}/${year}`; // MM/DD/YYYY format
  };

  // Helper to find bank accounting account
  const getBankAccountingAccount = (paymentBanco, bankAccountId) => {
    if (bankAccountId) {
      const byId = companyBankAccounts.find((acc) => acc._id?.toString() === bankAccountId.toString());
      if (byId?.accountingAccount) return byId.accountingAccount;
    }
    if (!paymentBanco) return defaultCuentaBanco;
    
    const cleanBancoName = paymentBanco.trim().toLowerCase();
    
    // Look for matching bank account in company bank accounts config
    const match = companyBankAccounts.find(acc => 
      acc.banco && acc.banco.trim().toLowerCase() === cleanBancoName && acc.accountingAccount
    );

    return match ? match.accountingAccount : defaultCuentaBanco;
  };

  let consecutivoIndex = 1;

  paymentAttempts.forEach((attempt) => {
    const contract = attempt.contractId || {};
    const client = attempt.clientId || contract.client || {};
    const lot = contract.lot || {};
    const company = contract.companyId || {};

    // Dynamic label based on property type
    const propertyLabels = { lotes: 'LOTE', casas: 'CASA', apartamentos: 'APTO', locales: 'LOCAL' };
    const propLabel = propertyLabels[lot.propertyType] || 'LOTE';

    const fechaElaboracion = formatDate(attempt.fechaPago);
    const identificacionTercero = client.idNumber || '';
    const consecutivoContrato = contract.excelRowId || lot.lotNumber || '';
    const cuentaBanco = getBankAccountingAccount(attempt.banco, attempt.bankAccountId);

    // If the payment attempt contains multiple quota payments, split them
    if (attempt.quotas && attempt.quotas.length > 0) {
      attempt.quotas.forEach((qItem) => {
        const quotaDoc = qItem.quotaId || {};
        const cuotaNo = quotaDoc.number || 1;
        const quotaAmount = qItem.amount || attempt.amount;
        const fechaVencimiento = quotaDoc.dueDate ? formatDate(quotaDoc.dueDate) : fechaElaboracion;
        
        const description = `CUOTA ${cuotaNo} ${propLabel} ${lot.lotNumber || ''}`.trim();
        const observaciones = `CUOTA ${cuotaNo} ${propLabel} ${lot.lotNumber || ''} ${company.name || ''}`.trim().substring(0, 100);

        // Row 1: Portfolio (Account 13) - Credit
        rows.push([
          comprobanteTipo,
          consecutivoIndex,
          fechaElaboracion,
          '', // Sigla moneda
          '', // Tasa de cambio
          cuentaCartera,
          identificacionTercero,
          '', // Sucursal
          '', // Código producto
          '', // Código bodega
          '', // Acción
          '', // Cantidad producto
          'CC', // Prefijo - default "CC"
          consecutivoContrato, // Consecutivo (Contract ID / excelRowId)
          cuotaNo, // No. cuota
          fechaVencimiento,
          '', // Código impuesto
          '', // Código grupo
          '', // Código activo fijo
          description,
          centroCostos,
          '', // Débito
          quotaAmount, // Crédito
          observaciones,
          '', // Base gravable
          '', // Base exenta
          ''  // Mes de cierre
        ]);

        // Row 2: Bank (Account 11) - Debit
        rows.push([
          comprobanteTipo,
          consecutivoIndex,
          fechaElaboracion,
          '', // Sigla moneda
          '', // Tasa de cambio
          cuentaBanco,
          identificacionTercero,
          '', // Sucursal
          '', // Código producto
          '', // Código bodega
          '', // Acción
          '', // Cantidad producto
          '', // Prefijo (blank for bank)
          '', // Consecutivo (blank for bank)
          '', // No. cuota (blank for bank)
          fechaVencimiento, // Same vencimiento
          '', // Código impuesto
          '', // Código grupo
          '', // Código activo fijo
          description,
          centroCostos,
          quotaAmount, // Débito
          '', // Crédito
          observaciones,
          '', // Base gravable
          '', // Base exenta
          ''  // Mes de cierre
        ]);

        consecutivoIndex++;
      });
    } else {
      // Fallback if no quotas subdocument
      const description = `CUOTA ${propLabel} ${lot.lotNumber || ''}`.trim();
      const observaciones = `CUOTA ${propLabel} ${lot.lotNumber || ''} ${company.name || ''}`.trim().substring(0, 100);

      // Row 1: Portfolio (Account 13) - Credit
      rows.push([
        comprobanteTipo,
        consecutivoIndex,
        fechaElaboracion,
        '', // Sigla moneda
        '', // Tasa de cambio
        cuentaCartera,
        identificacionTercero,
        '', // Sucursal
        '', // Código producto
        '', // Código bodega
        '', // Acción
        '', // Cantidad producto
        'CC', // Prefijo - default "CC"
        consecutivoContrato,
        1, // No. cuota
        fechaElaboracion, // Fallback
        '', // Código impuesto
        '', // Código grupo
        '', // Código activo fijo
        description,
        centroCostos,
        '', // Débito
        attempt.amount, // Crédito
        observaciones,
        '', // Base gravable
        '', // Base exenta
        ''  // Mes de cierre
      ]);

      // Row 2: Bank (Account 11) - Debit
      rows.push([
        comprobanteTipo,
        consecutivoIndex,
        fechaElaboracion,
        '', // Sigla moneda
        '', // Tasa de cambio
        cuentaBanco,
        identificacionTercero,
        '', // Sucursal
        '', // Código producto
        '', // Código bodega
        '', // Acción
        '', // Cantidad producto
        '', // Prefijo
        '', // Consecutivo
        '', // No. cuota
        fechaElaboracion,
        '', // Código impuesto
        '', // Código grupo
        '', // Código activo fijo
        description,
        centroCostos,
        attempt.amount, // Débito
        '', // Crédito
        observaciones,
        '', // Base gravable
        '', // Base exenta
        ''  // Mes de cierre
      ]);

      consecutivoIndex++;
    }
  });

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Siigo Import');

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};
