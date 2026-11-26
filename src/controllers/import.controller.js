import mongoose from 'mongoose';
import XLSX from 'xlsx';
import Client from '../models/Client.js';
import Lot from '../models/Lot.js';
import Contract from '../models/Contract.js';
import Quota from '../models/Quota.js';
import Company from '../models/Company.js';
import { buildUnitKey, buildNomenclature, missingIdentityFields, normalizePropertyType, stripFieldPrefix, identityFieldLabel } from '../utils/propertyIdentifier.js';
import { parseNumStringWithLocalization } from '../utils/math.js';
import { parseExcelDate, formatDateSmall } from '../utils/date.js';

/**
 * Parses an Excel file and imports clients, lots, contracts and quotas
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
export const importExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No se subió ningún archivo' });
    }

    const { tenantId, companyId } = req.user;
    const includeSiigo = req.query.includeSiigo !== 'false'; // Default true
    const createClientsWithoutName = req.query.createClientsWithoutName !== 'false'; // Default true

    const company = await Company.findById(companyId).select('name propertyType');
    if (!company) {
      return res.status(404).json({ success: false, message: 'Empresa no encontrada' });
    }
    const companyPropertyType = normalizePropertyType(company.propertyType);

    // Read workbook from buffer
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    // Convert to JSON for processing rows
    const data = XLSX.utils.sheet_to_json(sheet, { defval: null });

    let summary = {
      totalRows: data.length,
      clientsCreated: 0,
      clientsUpdated: 0,
      lotsCreated: 0,
      contractsCreated: 0,
      initialQuotasCreated: 0,
      normalQuotasCreated: 0,
      quotasMarkedPaid: 0,
      paymentsRegistered: 0,
      rowsProcessed: 0,
      rowsSkipped: 0,
      firmadoRows: 0,
    };

    let errors = [];
    let warnings = [];

    const getVal = (row, keyName) => {
      const keys = Object.keys(row);
      const targetClean = keyName.toLowerCase().replace(/\s+/g, ' ').trim();
      
      // Try exact match first to avoid "mixing" (e.g. LOTE vs LOTE.1)
      const exactKey = keys.find((k) => {
        const kClean = k.toLowerCase().replace(/\s+/g, ' ').trim();
        return kClean === targetClean;
      });
      
      if (exactKey) return row[exactKey];

      // Fallback to startsWith for cases with suffixes like .1, .2
      const prefixKey = keys.find((k) => {
        const kClean = k.toLowerCase().replace(/\s+/g, ' ').trim();
        return kClean.startsWith(targetClean + '.');
      });
      
      return prefixKey ? row[prefixKey] : undefined;
    };

    // Helper: tries multiple column name aliases and returns the first found value
    const getValMulti = (row, ...keys) => {
      for (const key of keys) {
        const val = getVal(row, key);
        if (val !== undefined && val !== null && val !== '') return val;
      }
      return undefined;
    };

    // 1. PRE-LOAD CATALOGS for O(1) lookup and batch optimization
    const [existingLots, existingClients, existingContracts] = await Promise.all([
      Lot.find({ tenantId, companyId }),
      Client.find({ tenantId, companyId }),
      Contract.find({ tenantId, companyId }),
    ]);

    // Index maps
    const lotMap = new Map(); // key: reference|nomenclature
    existingLots.forEach((l) => {
      const ref = (l.reference || '').toString().trim().toLowerCase();
      const nom = (l.nomenclature || '').toString().trim().toLowerCase();
      const key = `${ref}|${nom}`;
      lotMap.set(key, l);
      lotMap.set(buildUnitKey(l.propertyType || companyPropertyType, {
        stage: l.stage,
        manzana: l.manzana,
        tower: l.tower,
        floor: l.floor,
        lotNumber: l.lotNumber,
      }), l);
    });

    const clientByCedula = new Map();
    const clientByExcelId = new Map();
    existingClients.forEach((c) => {
      if (c.idNumber) clientByCedula.set(c.idNumber, c);
      if (c.excelRowId) clientByExcelId.set(c.excelRowId.toString(), c);
    });

    const contractMap = new Map(); // key: clientId|lotId
    existingContracts.forEach((c) => contractMap.set(`${c.client}|${c.lot}`, c));

    // Operations collectors for bulkWrite
    const lotOps = [];
    const clientOps = [];
    const contractOps = [];
    const quotasToInsert = [];
    const contractIdsToClearQuotas = new Set();

    // Process each row of the Excel file
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 2;
      const excelRowId = getValMulti(row, 'No.', '#') || rowNum;

      try {
        const realCedula = getValMulti(row, 'CEDULA')?.toString().trim() || undefined;
        // New format uses 'NOMBRE', old format uses 'CLIENTE'
        const clienteNombre = getValMulti(row, 'CLIENTE', 'NOMBRE')?.toString().trim();

        const stage = getVal(row, 'ETAPA')?.toString().trim() || 'Desconocida';
        const manzana = getValMulti(row, 'MANZANA', 'Manzana', 'Block', 'block', 'Manzana (Block)')?.toString().trim() || undefined;
        const tower = getValMulti(row, 'TORRE', 'Torre', 'tower', 'BLOQUE', 'Bloque', 'EDIFICIO', 'Edificio')?.toString().trim() || undefined;
        const floor = getValMulti(row, 'PISO', 'Piso', 'floor', 'NIVEL', 'Nivel')?.toString().trim() || undefined;
        const lotNumber = getValMulti(
          row,
          'LOTE', 'Lote', 'CASA', 'Casa', 'APARTAMENTO', 'Apartamento', 'APTO', 'Apto', 'LOCAL', 'Local', 'UNIDAD', 'Unidad', 'Número'
        )?.toString().trim() || 'N/A';

        const referenceInput = getValMulti(row, 'REFERENCIA', 'Referencia')?.toString().trim() || undefined;
        const nomenclatureInput = getValMulti(row, 'NOMENCLATURA', 'Nomenclatura')?.toString() || undefined;

        if ((!lotNumber || lotNumber === 'N/A') && !referenceInput) {
          summary.rowsSkipped++;
          summary.rowsProcessed++;
          continue;
        }

        const identity = { stage, manzana, tower, floor, lotNumber };
        const unitKey = buildUnitKey(companyPropertyType, identity);
        const nomenclature = nomenclatureInput || (companyPropertyType === 'lotes'
          ? `Mz ${manzana || '0'} Lt ${lotNumber}`
          : buildNomenclature(companyPropertyType, identity));
        const reference = referenceInput || (companyPropertyType === 'lotes'
          ? `MZ_${manzana || '0'}_LT_${lotNumber}`
          : unitKey);

        // Identification is by combination of reference and nomenclature
        const refClean = (reference || '').toString().trim().toLowerCase();
        const nomClean = (nomenclature || '').toString().trim().toLowerCase();
        const lotKey = `${refClean}|${nomClean}`;
        
        let contratoStatus = getValMulti(row, 'CONTRATOS', 'CONTRATO', 'ESTADO CONTRATO', 'ESTADO')?.toString().trim();
        if (!contratoStatus) {
          contratoStatus = 'FIRMADO'; // Default to FIRMADO if column is omitted
        }
        const contratoStatusUpper = contratoStatus.toUpperCase();
        
        let lotStatus = 'disponible';
        if (contratoStatusUpper === 'FIRMADO' || contratoStatusUpper === 'FIRMADO SOLO RL') {
          lotStatus = 'vendido';
        } else if (contratoStatusUpper && contratoStatusUpper !== 'DISPONIBLE' && contratoStatusUpper !== 'SIN REGISTRO') {
          lotStatus = 'apartado';
        }

        let lot = lotMap.get(unitKey) || lotMap.get(lotKey);
        // New format: 'AREA TOTAL', old format: 'METROS 2'
        const areaValue = parseNumStringWithLocalization(getValMulti(row, 'METROS 2', 'AREA TOTAL'));
        // New format: 'VALOR TOTAL', old: 'VALOR DEL CONTRATO'
        const priceValue = parseNumStringWithLocalization(getValMulti(row, 'VALOR TOTAL', 'VALOR DEL CONTRATO'));
        const lotData = {
          stage,
          manzana,
          nomenclature,
          lotNumber,
          reference,
          propertyType: companyPropertyType,
          unitKey,
          ...(tower && { tower }),
          ...(floor && { floor }),
          ...(areaValue > 0 && { area: areaValue }),
          ...(priceValue > 0 && { price: priceValue }),
          status: lotStatus,
          isDeleted: false,
          deletedAt: undefined,
          deletedBy: undefined,
          deletedReason: undefined,
          excelRowId: excelRowId,
          tenantId,
          companyId,
        };

        if (!lot) {
          const newId = new mongoose.Types.ObjectId();
          lot = { ...lotData, _id: newId };
          lotMap.set(lotKey, lot);
          lotMap.set(unitKey, lot);
          lotOps.push({
            insertOne: { document: lot },
          });
          summary.lotsCreated++;
        } else {
          lotOps.push({
            updateOne: {
              filter: { _id: lot._id },
              update: { $set: lotData },
            },
          });
        }

        // Check if there are any initial or normal quotas in this row
        // New format: CUOTA INICIAL 1/2/3. (4, 5 and CONSOLIDADA are now ignored per instructions)
        const hasInitialQuotas = [1, 2, 3].some((j) => {
          return parseNumStringWithLocalization(getVal(row, `CUOTA INICIAL ${j}`)) > 0;
        });
        // New format: CUOTA #1..#36. Old format: CUOTA 1..24. Supported up to 36.
        const maxQuotas = 36;
        const hasNormalQuotas = Array.from({ length: maxQuotas }, (_, i) => i + 1).some((j) =>
          parseNumStringWithLocalization(getValMulti(row, `CUOTA ${j}`, `CUOTA #${j}`)) > 0
        );
        // SIIGO is disabled for bulk upload per instructions
        const hasSiigoRecord = false;

        const hasAnyPayments = hasInitialQuotas || hasNormalQuotas || hasSiigoRecord;

        // Skip client/contract creation if:
        // 1. There is no real ID and no payments recorded (User requirement)
        // 2. There is no name and no real ID, and the option to create nameless clients is disabled
        if ((!realCedula && !hasAnyPayments) || (!clienteNombre && !realCedula && !createClientsWithoutName)) {
          summary.rowsProcessed++;
          continue;
        }

        const cedula = realCedula || `SIN_CEDULA_${reference || nomenclature || rowNum}`;

        // Determine an effective name if missing
        const effectiveName = clienteNombre || (realCedula ? `CLIENTE_CEDULA_${realCedula}` : `CLIENTE_REF_${reference || nomenclature}`);

        // 2. Client Management (Logic: cedula or excelRowId)
        let client = cedula ? clientByCedula.get(cedula) : clientByExcelId.get(excelRowId.toString());
        
        // Handle Multiple Phones
        const phoneN1 = getValMulti(row, 'TELEFONO N1', 'Teléfono N1', 'Telefono N1')?.toString().trim();
        const phoneN2 = getValMulti(row, 'TELEFONO N2', 'Teléfono N2', 'Telefono N2')?.toString().trim();
        const phoneGeneral = getValMulti(row, 'TELEFONO', 'Teléfono', 'Telefono')?.toString().trim();
        
        let phones = [];
        if (phoneN1) phones.push(phoneN1);
        if (phoneN2) phones.push(phoneN2);
        if (phones.length === 0 && phoneGeneral) phones.push(phoneGeneral);

        const clientData = {
          name: effectiveName,
          idNumber: cedula,
          phone: phones[0] || undefined, // Keep primary phone for compatibility
          phones: phones,
          address: getValMulti(row, 'DIRECCION', 'Dirección')?.toString(),
          expeditionPlace: getValMulti(row, 'Lugar de expedición', 'LUGAR DE EXPEDICIÓN')?.toString(),
          email: getValMulti(row, 'CORREO ELECTRONICO', 'Correo electrónico')?.toString(),
          behavior: getValMulti(row, 'COMPORTAMIENTO CLIENTE', 'Comportamiento Cliente'),
          excelRowId: excelRowId,
          tenantId,
          companyId,
        };

        if (!client) {
          const newId = new mongoose.Types.ObjectId();
          client = { ...clientData, _id: newId };
          if (cedula) clientByCedula.set(cedula, client);
          clientByExcelId.set(excelRowId.toString(), client);
          clientOps.push({
            insertOne: { document: client },
          });
          summary.clientsCreated++;
        } else {
          clientOps.push({
            updateOne: {
              filter: { _id: client._id },
              update: { $set: clientData },
            },
          });
          summary.clientsUpdated++;
        }

        // 3. Contract Management (Logic: client|lot)
        const isFirmado = contratoStatusUpper === 'FIRMADO';
        const hasContractStatus = contratoStatus && contratoStatusUpper !== 'DISPONIBLE' && contratoStatusUpper !== 'SIN REGISTRO';

        if (hasContractStatus) {
          summary.firmadoRows++; // Incrementing this as 'processed contract rows'
          const contractKey = `${client._id}|${lot._id}`;
          let contract = contractMap.get(contractKey);
          
          const siigo2024Raw = getValMulti(row, 'RECAUDO REPORTADO EN SIIGO 2024', 'RECAUDADO SIIGO 2024');
          const siigo2025Raw = getValMulti(row, 'RECAUDO REPORTADO EN SIIGO 2025', 'RECAUDADO SIIGO 2025');
          const revisadoPorRaw = getValMulti(row, 'REVISADO POR');

          const contractInfo = {
            client: client._id,
            lot: lot._id,
            status: contratoStatus,
            // New format: 'FECHA CONTRATO (SELECCIONAR)', old: 'FECHA CONTRATO'
            contractDate: parseExcelDate(getValMulti(row, 'FECHA CONTRATO', 'FECHA CONTRATO (SELECCIONAR)')),
            // New format: 'NEGOCIACIÓN' (with accent), old: 'NEGOCIACION'
            negotiation: getValMulti(row, 'NEGOCIACION', 'NEGOCIACIÓN'),
            appendix: getVal(row, 'OTRO SI'),
            // New format: 'VALOR TOTAL', old: 'VALOR DEL CONTRATO'
            totalValue: parseNumStringWithLocalization(getValMulti(row, 'VALOR DEL CONTRATO', 'VALOR TOTAL')),
            // New format: 'NUMERO DE CUOTAS', old: 'NO. CUOTAS'
            installmentsCount: parseInt(getValMulti(row, 'NO. CUOTAS', 'NUMERO DE CUOTAS', 'NUMERO CUOTAS', 'PLAZO CUOTAS')) || 0,
            installmentValue: parseNumStringWithLocalization(getVal(row, 'VALOR CUOTA')),
            paymentDay: parseInt(getVal(row, 'DIA DE PAGO')) || 0,
            startDate: parseExcelDate(getVal(row, 'FECHA INICIO CUOTAS')),
            bonus: getVal(row, 'BONO'),
            bonusValue: parseNumStringWithLocalization(getVal(row, 'VALOR BONO')),
            // New format: 'ASESOR', old: 'COMERCIAL'
            commercial: getValMulti(row, 'COMERCIAL', 'ASESOR'),
            // Legacy columns: only written when present in the file, so templates
            // without them don't overwrite values already stored on the contract.
            ...(siigo2024Raw !== undefined && { recaudadoSiigo2024: parseNumStringWithLocalization(siigo2024Raw) || 0 }),
            ...(siigo2025Raw !== undefined && { recaudadoSiigo2025: parseNumStringWithLocalization(siigo2025Raw) || 0 }),
            ...(revisadoPorRaw !== undefined && { revisadoPor: revisadoPorRaw }),
            // New format: 'Proceso Juridico', old: 'REQUERIMIENTO JURIDICO'
            juridicalRequirement: getValMulti(row, 'REQUERIMIENTO JURIDICO', 'Proceso Juridico'),
            observations: getVal(row, 'OBSERVACIONES'),
            excelRowId: excelRowId,
            tenantId,
            companyId,
          };

          if (!contract) {
            const newId = new mongoose.Types.ObjectId();
            contract = { ...contractInfo, _id: newId };
            contractMap.set(contractKey, contract);
            contractOps.push({
              insertOne: { document: contract },
            });
            summary.contractsCreated++;
          } else {
            contractOps.push({
              updateOne: {
                filter: { _id: contract._id },
                update: { $set: contractInfo },
              },
            });
          }

          // 4. Quotas Preparation (Logic: Only for FIRMADO)
          if (isFirmado) {
            contractIdsToClearQuotas.add(contract._id);

            // Initial Quotas (1 to 3)
            const initialQuotasCount = contractInfo.initialQuotasCount || 1;
            const initialQuotaTotalVal = (contractInfo.totalValue && contractInfo.initialQuotaPercentage)
              ? (contractInfo.totalValue * (contractInfo.initialQuotaPercentage / 100))
              : 0;
            const singleInitialQuotaValue = initialQuotasCount > 0 ? (initialQuotaTotalVal / initialQuotasCount) : 0;

            for (let j = 1; j <= 3; j++) {
              const headerKey = `CUOTA INICIAL ${j}`;
              const quotaKey = getVal(row, headerKey);
              const val = parseNumStringWithLocalization(quotaKey);
              
              if (val > 0) {
                const rowKeys = Object.keys(row);
                const qIdx = rowKeys.findIndex(k => {
                  const kClean = k.toUpperCase().replace(/\s+/g, ' ').trim();
                  return kClean === headerKey.toUpperCase();
                });
                
                let paymentMethod = undefined;
                if (qIdx !== -1 && qIdx + 1 < rowKeys.length) {
                  const nextKey = rowKeys[qIdx + 1];
                  if (nextKey.toUpperCase().includes('METODO') || nextKey.toUpperCase().includes('PAGO')) {
                    paymentMethod = row[nextKey];
                  }
                }

                const targetInitialVal = singleInitialQuotaValue > 0 ? singleInitialQuotaValue : val;
                const isInitialPaid = val >= targetInitialVal;

                quotasToInsert.push({
                  tenantId,
                  companyId,
                  contract: contract._id,
                  number: j,
                  type: 'inicial',
                  value: targetInitialVal,
                  amountPaid: val,
                  status: isInitialPaid ? 'pagado' : 'pendiente',
                  paymentMethod: paymentMethod,
                  excelRowId: excelRowId,
                });
                summary.initialQuotasCreated++;
                if (isInitialPaid) {
                  summary.quotasMarkedPaid++;
                }
              }
            }

            // Regular Quotas (Process all up to installmentsCount)
            const installmentsCount = contractInfo.installmentsCount || 0;
            const installmentValue = contractInfo.installmentValue || 0;
            const startDate = contractInfo.startDate || new Date();
            const paymentDay = contractInfo.paymentDay;

            for (let j = 1; j <= installmentsCount; j++) {
              const quotaHeader = `CUOTA #${j}`;
              const quotaVal = getValMulti(row, `CUOTA ${j}`, quotaHeader);
              const valFromExcel = parseNumStringWithLocalization(quotaVal);
              
              const dueDate = new Date(startDate);
              dueDate.setMonth(dueDate.getMonth() + (j - 1));
              if (paymentDay && paymentDay >= 1 && paymentDay <= 31) {
                dueDate.setDate(paymentDay);
              }

              if (valFromExcel > 0) {
                const rowKeys = Object.keys(row);
                const qIdx = rowKeys.findIndex(k => k.toUpperCase().includes(`CUOTA #${j}`) || k.toUpperCase().includes(`CUOTA ${j}`));
                let paymentMethod = undefined;
                if (qIdx !== -1 && qIdx + 1 < rowKeys.length) {
                  const nextKey = rowKeys[qIdx + 1];
                  if (nextKey.toUpperCase().includes('METODO') || nextKey.toUpperCase().includes('PAGO')) {
                    paymentMethod = row[nextKey];
                  }
                }

                const targetValue = installmentValue > 0 ? installmentValue : valFromExcel;
                const isFullyPaid = valFromExcel >= targetValue;

                quotasToInsert.push({
                  tenantId,
                  companyId,
                  contract: contract._id,
                  number: j,
                  type: 'normal',
                  value: targetValue,
                  amountPaid: valFromExcel,
                  dueDate,
                  status: isFullyPaid ? 'pagado' : 'pendiente',
                  paymentMethod: paymentMethod,
                  excelRowId: excelRowId,
                });
                summary.normalQuotasCreated++;
                if (isFullyPaid) {
                  summary.quotasMarkedPaid++;
                }
              } else {
                // Generate as PENDING if not in Excel but within installmentsCount
                quotasToInsert.push({
                  tenantId,
                  companyId,
                  contract: contract._id,
                  number: j,
                  type: 'normal',
                  value: installmentValue,
                  amountPaid: 0,
                  dueDate,
                  status: 'pendiente',
                  excelRowId: excelRowId,
                });
                summary.normalQuotasCreated++;
              }
            }

          }
        }


        summary.rowsProcessed++;

      } catch (err) {
        console.error(`Error processing row ${rowNum}:`, err);
        errors.push(`Fila ${rowNum}: ${err.message}`);
      }
    }

    // 5. EXECUTE BULK OPERATIONS
    if (lotOps.length > 0) await Lot.bulkWrite(lotOps);
    if (clientOps.length > 0) await Client.bulkWrite(clientOps);
    if (contractOps.length > 0) await Contract.bulkWrite(contractOps);

    // Replace Quotas in bulk for touched contracts
    if (contractIdsToClearQuotas.size > 0) {
      await Quota.deleteMany({ contract: { $in: Array.from(contractIdsToClearQuotas) } });
      if (quotasToInsert.length > 0) {
        // Use chunks for very large files to avoid memory/packet limits
        const chunk = 1000;
        for (let i = 0; i < quotasToInsert.length; i += chunk) {
          await Quota.insertMany(quotasToInsert.slice(i, i + chunk), { ordered: false });
        }
      }
    }

    res.status(200).json({
      success: true,
      message: 'Importación procesada con éxito',
      summary,
      errors,
      warnings,
    });

  } catch (error) {
    console.error('Import controller error:', error);
    res.status(500).json({
      success: false,
      message: 'Error al procesar el archivo Excel',
      error: error.message,
    });
  }
};

/**
 * Exports all data from the database to an Excel file
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
export const exportExcel = async (req, res) => {
  try {
    const { tenantId, companyId } = req.user;
    console.log(`--- Iniciando Exportación Excel (Todos los lotes): Tenant ${tenantId}, Company ${companyId} ---`);

    const company = await Company.findById(companyId).select('propertyType');
    const companyPropertyType = normalizePropertyType(company?.propertyType);
    const identityColumns = {
      lotes: ['', 'ETAPA', 'MANZANA', 'LOTE'],
      casas: ['', 'ETAPA', 'MANZANA', 'CASA'],
      apartamentos: ['', 'ETAPA', 'TORRE', 'PISO', 'APARTAMENTO'],
      locales: ['', 'ETAPA', 'LOCAL'],
    }[companyPropertyType] || ['', 'ETAPA', 'MANZANA', 'LOTE'];
    const identityValuesOf = (lot) => {
      if (companyPropertyType === 'apartamentos') return ['', emptyIfEmpty(lot.stage), emptyIfEmpty(lot.tower), emptyIfEmpty(lot.floor), emptyIfEmpty(lot.lotNumber)];
      if (companyPropertyType === 'locales') return ['', emptyIfEmpty(lot.stage), emptyIfEmpty(lot.lotNumber)];
      return ['', emptyIfEmpty(lot.stage), emptyIfEmpty(lot.manzana), emptyIfEmpty(lot.lotNumber)];
    };

    // 1. Fetch all Lots
    const lots = await Lot.find({ tenantId, companyId, isDeleted: { $ne: true } })
      .populate({
        path: 'reservationBy',
        select: 'name idNumber phone phones email address expeditionPlace behavior excelRowId'
      })
      .lean();
    
    console.log(`Lotes encontrados: ${lots.length}`);

    // 2. Fetch all Contracts to map to lots
    const contracts = await Contract.find({ tenantId, companyId })
      .populate('client')
      .lean();
    
    const contractMap = {};
    contracts.forEach(c => {
      if (c.lot) contractMap[c.lot.toString()] = c;
    });

    // 3. Fetch all Quotas to map to contracts
    const contractIds = contracts.map(c => c._id);
    const allQuotas = await Quota.find({ contract: { $in: contractIds } })
      .sort({ type: 1, number: 1 })
      .lean();
    
    const quotaMap = {};
    allQuotas.forEach(q => {
      const cid = q.contract.toString();
      if (!quotaMap[cid]) quotaMap[cid] = [];
      quotaMap[cid].push(q);
    });

    // 4. Prepare data for Excel
    const exportData = [];
    
    // Helpers
    const emptyIfZero = (val) => (val === 0 || val === null || val === undefined ? '' : val);
    const emptyIfEmpty = (val) => (val === null || val === undefined ? '' : val);
    const formatDate = (date) => {
      if (!date) return '';
      const d = new Date(date);
      if (isNaN(d.getTime())) return '';
      const day = d.getDate().toString().padStart(2, '0');
      const month = (d.getMonth() + 1).toString().padStart(2, '0');
      const year = d.getFullYear();
      return `${month}/${day}/${year}`;
    };

    for (const lot of lots) {
      const contract = contractMap[lot._id.toString()];
      const quotas = contract ? (quotaMap[contract._id.toString()] || []) : [];
      const client = contract?.client || lot.reservationBy;
      
      const initialQuotas = quotas.filter((q) => q.type === 'inicial');
      const regularQuotas = quotas.filter((q) => q.type === 'normal');
      
      const totalRecaudado = quotas
        .filter((q) => q.status === 'pagado')
        .reduce((sum, q) => sum + (q.value || 0), 0);
        
      const totalPorRecaudar = contract 
        ? Math.max(0, (contract.totalValue || 0) - totalRecaudado)
        : 0;
        
      const percentageRecaudo = (contract && contract.totalValue > 0)
        ? ((totalRecaudado / contract.totalValue) * 100).toFixed(2)
        : 0;
        
      const valorM2 = (lot.area && lot.area > 0)
        ? Math.round(((contract?.totalValue || lot.price || 0) / lot.area) * 100) / 100
        : '';

      // Create row as an array for AOA (Array of Arrays)
      const rowArr = [
        ...identityValuesOf(lot),
        contract ? formatDate(contract.contractDate) : '',
        emptyIfZero(lot.area),
        contract ? (contract.status || 'FIRMADO') : 'DISPONIBLE', // CONTRATOS
        contract ? emptyIfEmpty(contract.appendix) : '',
        contract ? emptyIfEmpty(contract.negotiation) : '',
        contract ? emptyIfZero(contract.totalValue) : emptyIfZero(lot.price),
        valorM2,
        contract ? emptyIfEmpty(contract.commercial) : '',
        emptyIfEmpty(client?.idNumber),
        emptyIfEmpty(client?.expeditionPlace),
        emptyIfEmpty(client?.name),
        emptyIfEmpty(client?.address),
        emptyIfEmpty(client?.email),
        client?.phones?.[0] || emptyIfEmpty(client?.phone),
        client?.phones?.[1] || '',
        contract ? emptyIfZero(contract.installmentsCount) : '', // NUMERO DE CUOTAS 
        contract ? formatDate(contract.startDate) : '',
        contract ? emptyIfZero(contract.installmentValue) : '',
        contract ? emptyIfZero(contract.paymentDay) : '',
        contract ? emptyIfEmpty(contract.bonus) : '',
        contract ? emptyIfZero(contract.bonusValue) : '',
        contract ? emptyIfZero(contract.initialQuotasCount || initialQuotas.length) : '', // # CUOTA INICIAL
      ];

      // Add Initial Quotas (1 to 3) with METODO DE PAGO
      for (let j = 1; j <= 3; j++) {
        const q = initialQuotas.find((iq) => iq.number === j);
        rowArr.push(q ? emptyIfZero(q.value) : '');
        rowArr.push(q?.paymentMethod || ''); 
      }
      
      const totalInitialPaid = initialQuotas.reduce((sum, q) => sum + (q.value || 0), 0);
      rowArr.push(emptyIfZero(totalInitialPaid)); // CUOTA INICIAL CONSOLIDADA
      rowArr.push(''); // METODO DE PAGO (Consolidado)

      // Add Regular Quotas (#1 to #30) with METODO DE PAGO
      for (let j = 1; j <= 30; j++) {
        const q = regularQuotas.find((rq) => rq.number === j);
        rowArr.push(q ? emptyIfZero(q.value) : '');
        rowArr.push(q?.paymentMethod || '');
      }

      // Add trailing fields
      rowArr.push(
        contract ? emptyIfZero(totalRecaudado) : '', // RECAUDADO
        contract ? emptyIfZero(totalPorRecaudar) : '', // POR RECAUDAR
        contract ? `${percentageRecaudo}%` : '', // % RECAUDO
        emptyIfEmpty(client?.behavior),
        contract ? emptyIfEmpty(contract.juridicalRequirement) : '',
        contract ? emptyIfEmpty(contract.observations) : (lot.status !== 'disponible' ? emptyIfEmpty(lot.reservationDetails) : '')
      );

      exportData.push(rowArr);
    }
    
    // Sort by Etapa, Manzana, Torre/Piso y Unidad
    const sortKeyOf = (row) => row.slice(1, identityColumns.length).map((x) => String(x === undefined || x === null ? '' : x)).join('|');
    exportData.sort((a, b) => sortKeyOf(a).localeCompare(sortKeyOf(b), undefined, { numeric: true }));

    // Define the headers exactly as requested
    const headers = [
      ...identityColumns, 'FECHA CONTRATO (SELECCIONAR)', 'AREA TOTAL', 'CONTRATOS', 'OTRO SI', 'NEGOCIACIÓN', 'VALOR TOTAL', 'VALOR M2', 'ASESOR', 'CEDULA', 'LUGAR DE EXPEDICIÓN', 'NOMBRE', 'DIRECCIÓN', 'CORREO ELECTRONICO', 'TELEFONO N1', 'TELEFONO N2', 'NUMERO DE CUOTAS ', 'FECHA INICIO CUOTAS', 'VALOR CUOTA', 'DIA DE PAGO', 'BONO', 'VALOR BONO', '# CUOTA INICIAL', 'CUOTA INICIAL 1', 'METODO DE PAGO', 'CUOTA INICIAL 2', 'METODO DE PAGO', 'CUOTA INICIAL 3', 'METODO DE PAGO', 'CUOTA INICIAL CONSOLIDADA', 'METODO DE PAGO'
    ];
    for (let j = 1; j <= 30; j++) {
      headers.push(`CUOTA #${j}`, 'METODO DE PAGO');
    }
    headers.push(
      'RECAUDADO', 'POR RECAUDAR', '% RECAUDO', 'Comportamiento Cliente', 'Proceso Juridico', 'OBSERVACIONES'
    );

    // 3. Create workbook and sheet
    console.log('Generando archivo XLSX con todos los lotes...');
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...exportData]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Datos Exportados');
    
    // 4. Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    // 5. Send file with proper headers
    console.log('Enviando respuesta...');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=export-cobranza.xlsx');
    res.send(buffer);
    console.log('--- Exportación completada con éxito ---');
    
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al exportar datos del sistema', 
      error: error.message, 
    });
  }
};



/**
 * Generates an Excel template with headers for data import
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
export const downloadTemplate = async (req, res) => {
  try {
    // Define the headers exactly as in exportExcel
    const propertyType = normalizePropertyType(req.query.propertyType);
    const identityColumns = {
      lotes: ['', 'ETAPA', 'MANZANA', 'LOTE'],
      casas: ['', 'ETAPA', 'MANZANA', 'CASA'],
      apartamentos: ['', 'ETAPA', 'TORRE', 'PISO', 'APARTAMENTO'],
      locales: ['', 'ETAPA', 'LOCAL'],
    }[propertyType] || ['', 'ETAPA', 'MANZANA', 'LOTE'];
    const identitySample = {
      lotes: ['', 'Etapa 1', 'Mz A', 'Lote 5'],
      casas: ['', 'Etapa 1', 'Mz A', 'Casa 5'],
      apartamentos: ['', 'Etapa 1', 'Torre A', '3', '301'],
      locales: ['', 'Centro Comercial Plaza', '102-1'],
    }[propertyType] || ['', 'Etapa 1', 'Mz A', 'Lote 5'];

    const headers = [
      ...identityColumns, 'FECHA CONTRATO (SELECCIONAR)', 'AREA TOTAL', 'CONTRATOS', 'OTRO SI', 'NEGOCIACIÓN', 'VALOR TOTAL', 'VALOR M2', 'ASESOR', 'CEDULA', 'LUGAR DE EXPEDICIÓN', 'NOMBRE', 'DIRECCIÓN', 'CORREO ELECTRONICO', 'TELEFONO N1', 'TELEFONO N2', 'NUMERO DE CUOTAS ', 'FECHA INICIO CUOTAS', 'VALOR CUOTA', 'DIA DE PAGO', 'BONO', 'VALOR BONO', '# CUOTA INICIAL', 'CUOTA INICIAL 1', 'METODO DE PAGO', 'CUOTA INICIAL 2', 'METODO DE PAGO', 'CUOTA INICIAL 3', 'METODO DE PAGO', 'CUOTA INICIAL CONSOLIDADA', 'METODO DE PAGO'
    ];
    for (let j = 1; j <= 30; j++) {
      headers.push(`CUOTA #${j}`, 'METODO DE PAGO');
    }
    headers.push(
      'RECAUDADO', 'POR RECAUDAR', '% RECAUDO', 'Comportamiento Cliente', 'Proceso Juridico', 'OBSERVACIONES'
    );

    // Sample data row
    const row = [
      ...identitySample, '15-01-24', 100, 'FIRMADO', '', 'Crédito Directo', 25000000, 375000, 'Asesor 1', '12345678', 'Bogotá', 'Juan Pérez', 'Calle 123', 'juan@email.com', '3101234567', '', 24, '01-02-24', 1000000, 5, 'Bono 1', 500000, 3, 200000, 'Efectivo', 200000, 'Transferencia', 200000, 'Efectivo', 600000, ''
    ];
    // Sample quotas
    for (let j = 1; j <= 30; j++) {
      row.push(j <= 6 ? 1000000 : '', j <= 6 ? 'Efectivo' : '');
    }
    // Sample trailing fields
    row.push(6000000, 19000000, '0%', 'Excelente', '', 'Cliente puntual');

    const templateData = [headers, row];

    // Create workbook and sheet
    const worksheet = XLSX.utils.aoa_to_sheet(templateData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Plantilla Importación');
    
    // Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    // Send file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=plantilla-cobranza.xlsx');
    res.send(buffer);
    
  } catch (error) {
    console.error('Template error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al generar la plantilla', 
      error: error.message, 
    });
  }
};

/**
 * Generates an Excel template with headers for lot-only data import
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
export const downloadLotsOnlyTemplate = async (req, res) => {
  try {
    const propertyType = req.query.propertyType || 'lotes';
    
    let headers, row;
    switch (propertyType) {
      case 'apartamentos':
        headers = ['Etapa', 'Torre', 'Piso', 'Apartamento', 'Area', 'Valor Metro Cuadrado'];
        row = ['Etapa 1', 'A', '3', '301', 65, 4500000];
        break;
      case 'casas':
        headers = ['Etapa', 'Manzana', 'Casa', 'Area', 'Valor Metro Cuadrado'];
        row = ['Etapa 1', 'A', '5', 120, 3750000];
        break;
      case 'locales':
        headers = ['Etapa', 'Local', 'Area', 'Valor Metro Cuadrado'];
        row = ['Centro Comercial Plaza', '102-1', 45, 6000000];
        break;
      default: // lotes
        headers = ['Etapa', 'Manzana', 'Lote', 'Area', 'Valor Metro Cuadrado'];
        row = ['Etapa 1', 'A', '5', 120, 375000];
        break;
    }
    
    const templateData = [headers, row];

    const worksheet = XLSX.utils.aoa_to_sheet(templateData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Plantilla Inventario');
    
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    const labelMap = { lotes: 'lotes', casas: 'casas', apartamentos: 'apartamentos', locales: 'locales' };
    const fileName = `plantilla-${labelMap[propertyType] || 'inventario'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.send(buffer);
  } catch (error) {
    console.error('Template error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al generar la plantilla de lotes', 
      error: error.message, 
    });
  }
};

/**
 * Parses an Excel file containing only lot details for new projects
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
export const importLotsOnly = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No se subió ningún archivo' });
    }

    const { tenantId, companyId } = req.user;

    const company = await Company.findById(companyId).select('name propertyType');
    if (!company) {
      return res.status(404).json({ success: false, message: 'Empresa no encontrada' });
    }
    const companyPropertyType = normalizePropertyType(company.propertyType);

    // Read workbook from buffer
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    // Convert to JSON for processing rows
    const data = XLSX.utils.sheet_to_json(sheet, { defval: null });

    let summary = {
      totalRows: data.length,
      lotsCreated: 0,
      lotsUpdated: 0,
      rowsProcessed: 0,
      rowsSkipped: 0,
      duplicatesInFile: 0,
      archivedSkipped: 0,
    };

    let errors = [];
    let warnings = [];

    const getVal = (row, keyName) => {
      const keys = Object.keys(row);
      const targetClean = keyName.toLowerCase().replace(/\s+/g, ' ').trim();
      
      const exactKey = keys.find((k) => {
        const kClean = k.toLowerCase().replace(/\s+/g, ' ').trim();
        return kClean === targetClean;
      });
      
      if (exactKey) return row[exactKey];

      const prefixKey = keys.find((k) => {
        const kClean = k.toLowerCase().replace(/\s+/g, ' ').trim();
        return kClean.startsWith(targetClean + '.');
      });
      
      return prefixKey ? row[prefixKey] : undefined;
    };

    const getValMulti = (row, ...keys) => {
      for (const key of keys) {
        const val = getVal(row, key);
        if (val !== undefined && val !== null && val !== '') return val;
      }
      return undefined;
    };

    // Load existing lots for duplicate prevention
    const existingLots = await Lot.find({ tenantId, companyId });
    const lotMap = new Map();
    existingLots.forEach((l) => {
      const ref = (l.reference || '').toString().trim().toLowerCase();
      const nom = (l.nomenclature || '').toString().trim().toLowerCase();
      const key = `${ref}|${nom}`;
      lotMap.set(key, l);

      const s = (l.stage || '').toString().trim().toLowerCase();
      const m = (l.manzana || '').toString().trim().toLowerCase();
      const num = (l.lotNumber || '').toString().trim().toLowerCase();
      const tw = (l.tower || '').toString().trim().toLowerCase();
      const fl = (l.floor || '').toString().trim().toLowerCase();
      lotMap.set(`${s}|${m}|${tw}|${fl}|${num}`, l);

      lotMap.set(buildUnitKey(l.propertyType || companyPropertyType, {
        stage: l.stage,
        manzana: l.manzana,
        tower: l.tower,
        floor: l.floor,
        lotNumber: l.lotNumber,
      }), l);
    });

    const lotOps = [];
    const seenUnitKeys = new Map();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 2;

      try {
        const rowTypeRaw = getValMulti(row, 'TIPO', 'Tipo', 'TIPO PROPIEDAD', 'TIPO DE INMUEBLE', 'TIPO_INMUEBLE', 'tipo');
        const rowType = rowTypeRaw ? normalizePropertyType(rowTypeRaw, companyPropertyType) : companyPropertyType;
        if (rowTypeRaw && rowType !== companyPropertyType) {
          errors.push(`Fila ${rowNum}: el tipo "${rowTypeRaw}" no coincide con el tipo del proyecto (${companyPropertyType}).`);
          summary.rowsSkipped++;
          summary.rowsProcessed++;
          continue;
        }

        const stage = getValMulti(row, 'Etapa', 'stage', 'etapa', 'Etapa (Stage)')?.toString().trim() || 'Desconocida';
        // «Mz A» or «Lote 5» in the cell keep only «A» and «5»: the label is added when shown
        const manzana = stripFieldPrefix(getValMulti(row, 'Manzana', 'block', 'manzana', 'Manzana (Block)'), 'manzana');
        const lotNumber = stripFieldPrefix(getValMulti(row, 'Lote', 'lote', 'lot', 'lotNumber', 'Número de lote', 'Número', 'Apartamento', 'Local', 'Casa'), 'unit') || undefined;
        const tower = stripFieldPrefix(getValMulti(row, 'Torre', 'tower'), 'tower');
        const floor = stripFieldPrefix(getValMulti(row, 'Piso', 'floor'), 'floor');

        const identity = { stage, manzana, tower, floor, lotNumber };
        const missing = missingIdentityFields(companyPropertyType, identity);
        if (!lotNumber || missing.length > 0) {
          const missingLabels = (missing.length > 0 ? missing : ['lotNumber']).map((f) => identityFieldLabel(companyPropertyType, f));
          errors.push(`Fila ${rowNum}: faltan columnas obligatorias (${missingLabels.join(', ')}).`);
          summary.rowsSkipped++;
          summary.rowsProcessed++;
          continue;
        }

        let price = parseNumStringWithLocalization(getValMulti(row, 'Valor', 'precio', 'price', 'Valor del lote', 'Valor predio', 'Valor del lote o predio'));
        const area = parseNumStringWithLocalization(getValMulti(row, 'Area', 'área', 'area', 'Área (m²)'));
        const pricePerM2 = parseNumStringWithLocalization(getValMulti(row, 'Valor Metro Cuadrado', 'Valor por metro cuadrado', 'Valor M2', 'pricePerM2', 'Valor metro cuadrado'));

        if (area > 0 && pricePerM2 > 0) {
          price = area * pricePerM2;
        }

        if (!(area > 0)) {
          errors.push(`Fila ${rowNum}: el área debe ser mayor a 0.`);
          summary.rowsSkipped++;
          summary.rowsProcessed++;
          continue;
        }

        const unitKey = buildUnitKey(companyPropertyType, identity);
        if (seenUnitKeys.has(unitKey)) {
          errors.push(`Fila ${rowNum}: duplicado en el archivo, ya aparece en la fila ${seenUnitKeys.get(unitKey)} (${buildNomenclature(companyPropertyType, identity)}).`);
          summary.duplicatesInFile++;
          summary.rowsProcessed++;
          continue;
        }
        seenUnitKeys.set(unitKey, rowNum);

        const nomenclature = buildNomenclature(companyPropertyType, identity);
        const reference = `${stage}-${manzana || tower || '0'}-${lotNumber}`;

        const refClean = reference.toLowerCase();
        const nomClean = nomenclature.toLowerCase();
        const lotKey = `${refClean}|${nomClean}`;
        const naturalKey = `${stage.toLowerCase()}|${manzana.toLowerCase()}|${tower.toLowerCase()}|${floor.toLowerCase()}|${lotNumber.toLowerCase()}`;

        let lot = lotMap.get(unitKey) || lotMap.get(lotKey) || lotMap.get(naturalKey);

        if (lot && lot.isDeleted) {
          warnings.push(`Fila ${rowNum}: el inmueble "${lot.nomenclature || lotNumber}" está archivado; se omite (restáurelo o elimínelo primero).`);
          summary.archivedSkipped++;
          summary.rowsProcessed++;
          continue;
        }

        const lotData = {
          stage,
          manzana,
          nomenclature,
          lotNumber,
          reference,
          propertyType: companyPropertyType,
          unitKey,
          area,
          ...(price > 0 && { price }),
          status: lot?.status || 'disponible',
          ...(tower && { tower }),
          ...(floor && { floor }),
          tenantId,
          companyId,
          excelRowId: rowNum,
        };

        if (!lot) {
          const newId = new mongoose.Types.ObjectId();
          lot = { ...lotData, _id: newId, isDeleted: false };
          lotMap.set(unitKey, lot);
          lotMap.set(lotKey, lot);
          lotOps.push({
            insertOne: { document: lot },
          });
          summary.lotsCreated++;
        } else {
          lotOps.push({
            updateOne: {
              filter: { _id: lot._id },
              update: { $set: lotData },
            },
          });
          summary.lotsUpdated++;
        }

        summary.rowsProcessed++;
      } catch (err) {
        console.error(`Error processing lot row ${rowNum}:`, err);
        errors.push(`Fila ${rowNum}: ${err.message}`);
      }
    }

    if (lotOps.length > 0) {
      await Lot.bulkWrite(lotOps);
    }

    res.status(200).json({
      success: true,
      message: 'Carga masiva de lotes completada con éxito',
      summary,
      errors,
      warnings,
    });
  } catch (error) {
    console.error('Import lots error:', error);
    res.status(500).json({
      success: false,
      message: 'Error al procesar el archivo de lotes',
      error: error.message,
    });
  }
};

