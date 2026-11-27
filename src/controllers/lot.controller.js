import mongoose from 'mongoose';
import Lot from '../models/Lot.js';
import Client from '../models/Client.js';
import Contract from '../models/Contract.js';
import Quota from '../models/Quota.js';
import { uploadToR2 } from '../utils/storage.js';
import { logAudit } from '../utils/auditLogger.js';
import { roundMoney } from '../utils/math.js';
import { checkLotExpirations } from '../utils/lotExpiration.js';
import { buildUnitKey, buildNomenclature, normalizePropertyType } from '../utils/propertyIdentifier.js';

export const createLot = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;

    const { 
      stage, 
      manzana,
      nomenclature, 
      lotNumber, 
      area, 
      price, 
      images, 
      status,
      excelRowId,
      maxInstallments,
      propertyType,
      tower,
      floor,
    } = req.body;

    const resolvedPropertyType = normalizePropertyType(propertyType);
    const resolvedNomenclature = nomenclature && String(nomenclature).trim()
      ? String(nomenclature).trim()
      : buildNomenclature(resolvedPropertyType, { stage, manzana, tower, floor, lotNumber });
    const unitKey = buildUnitKey(resolvedPropertyType, { stage, manzana, tower, floor, lotNumber });

    const duplicate = await Lot.findOne({ tenantId, companyId, unitKey, isDeleted: { $ne: true } });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_UNIT',
        message: `Ya existe un inmueble activo con la misma identidad: ${duplicate.nomenclature || lotNumber}`,
        data: { lotId: duplicate._id, nomenclature: duplicate.nomenclature || null },
      });
    }

    let lot;
    try {
      lot = await Lot.create({
        stage,
        manzana,
        nomenclature: resolvedNomenclature,
        lotNumber,
        area,
        price,
        images: images || [],
        status: status || 'disponible',
        maxInstallments: maxInstallments !== undefined && maxInstallments !== '' ? parseInt(maxInstallments) : 24,
        excelRowId,
        tenantId,
        companyId,
        propertyType: resolvedPropertyType,
        unitKey,
        ...(tower && { tower }),
        ...(floor && { floor }),
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          success: false,
          code: 'DUPLICATE_UNIT',
          message: 'Ya existe un inmueble activo con el mismo identificador.',
        });
      }
      throw error;
    }

    await logAudit(req, {
      action: 'CREATE_LOT',
      module: 'LOTS',
      targetId: lot._id,
      details: { stage, lotNumber, price }
    });

    res.status(201).json({
      success: true,
      data: lot,
    });
  } catch (error) {
    next(error);
  }
};

export const getLots = async (req, res, next) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    
    // Run lazy cleanup for expired reservations
    await checkLotExpirations(tenantId, companyId);

    const { 
      page = 1, 
      limit = 10, 
      search, 
      sortBy, 
      order, 
      status,
      manzana,
      stage,
      sellerId,
      minArea,
      maxArea,
      showDeleted,
    } = req.query;
    const skip = (page - 1) * limit;

    // Dynamic sort
    let sortObj = { createdAt: -1 };
    if (sortBy) {
      sortObj = { [sortBy]: order === 'asc' ? 1 : -1 };
    }

    let query = { tenantId, companyId };

    if (showDeleted === 'true') {
      query.isDeleted = true;
    } else if (showDeleted !== 'all') {
      query.isDeleted = { $ne: true };
    }

    if (status) {
      query.status = status;
    }
    if (manzana) {
      query.manzana = { $regex: manzana.trim(), $options: 'i' };
    }
    if (stage) {
      query.stage = { $regex: stage.trim(), $options: 'i' };
    }
    if (sellerId) {
      query.sellerId = sellerId;
    }
    if (minArea || maxArea) {
      query.area = {};
      if (minArea) query.area.$gte = parseFloat(minArea);
      if (maxArea) query.area.$lte = parseFloat(maxArea);
    }

    // If seller/executive role, show:
    // 1. All available lots (to be sold)
    // 2. Lots sold by THEM
    if (role === 'vendedor' || role === 'ejecutivo_comercial' || role === 'agent') {
      query.$or = [
        { status: 'disponible' },
        { status: 'apartado' },
        { status: 'separado' },
        { sellerId: userId },
      ];
    }

    if (search) {
      const searchFilter = {
        $or: [
          { stage: { $regex: search, $options: 'i' } },
          { manzana: { $regex: search, $options: 'i' } },
          { nomenclature: { $regex: search, $options: 'i' } },
          { lotNumber: { $regex: search, $options: 'i' } },
          { reference: { $regex: search, $options: 'i' } },
        ],
      };

      const searchNum = parseFloat(search);
      if (!isNaN(searchNum)) {
        searchFilter.$or.push({ area: searchNum });
      }
      
      // If we already have a $or from the role check, combine with $and
      if (query.$or) {
        query = { $and: [query, searchFilter] };
      } else {
        query.$or = searchFilter.$or;
      }
    }

    const total = await Lot.countDocuments(query);
    let lots = await Lot.find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(parseInt(limit))
      .populate({
        path: 'sellerId',
        populate: { path: 'accountId', select: 'fullName' },
      })
      .lean();

    // Handle existing sold lots that don't have sellerId stored yet
    const soldLotsWithoutSeller = lots
      .filter((l) => l.status === 'vendido' && !l.sellerId)
      .map((l) => l._id);

    if (soldLotsWithoutSeller.length > 0) {
      const contracts = await Contract.find({ lot: { $in: soldLotsWithoutSeller } })
        .populate({
          path: 'sellerId',
          populate: { path: 'accountId', select: 'fullName' },
        });

      const lotSellerMap = {};
      contracts.forEach((c) => {
        if (c.sellerId) {
          lotSellerMap[c.lot.toString()] = c.sellerId;
        }
      });

      // Map back to lots
      lots = lots.map((l) => {
        const lotIdStr = l._id.toString();
        // The lots come from .lean(): plain objects, no toObject()
        if (lotSellerMap[lotIdStr]) return { ...l, sellerId: lotSellerMap[lotIdStr] };
        return l;
      });
    }

    res.status(200).json({
      success: true,
      data: {
        lots,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getLot = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    
    // Run lazy cleanup for this specific tenant/company
    await checkLotExpirations(tenantId, companyId);

    const lot = await Lot.findOne({ _id: req.params.id, tenantId })
      .populate({
        path: 'sellerId',
        populate: { path: 'accountId', select: 'fullName email' },
      })
      .populate('reservationBy')
      .populate('deletedBy', 'accountId')
      .lean();

    if (!lot) {
      return res.status(404).json({
        success: false,
        message: 'Lote no encontrado',
      });
    }

    res.status(200).json({
      success: true,
      data: lot,
    });
  } catch (error) {
    next(error);
  }
};

export const updateLot = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const existingLot = await Lot.findOne({ _id: req.params.id, tenantId });

    if (!existingLot) {
      return res.status(404).json({
        success: false,
        message: 'Lote no encontrado',
      });
    }

    if (existingLot.isDeleted) {
      return res.status(400).json({
        success: false,
        message: 'No se puede editar un lote que ha sido eliminado o archivado. Debe restaurarlo primero.',
      });
    }

    const { 
      stage, 
      manzana,
      nomenclature, 
      lotNumber, 
      area, 
      price, 
      images, 
      status,
      maxInstallments,
      propertyType,
      tower,
      floor,
    } = req.body;

    const assignments = { stage, manzana, nomenclature, lotNumber, area, price, images, status, propertyType, tower, floor };
    for (const [field, value] of Object.entries(assignments)) {
      if (value !== undefined) existingLot[field] = value;
    }
    if (maxInstallments !== undefined && maxInstallments !== '') {
      existingLot.maxInstallments = parseInt(maxInstallments);
    }

    const resolvedPropertyType = normalizePropertyType(existingLot.propertyType);
    const unitKey = buildUnitKey(resolvedPropertyType, {
      stage: existingLot.stage,
      manzana: existingLot.manzana,
      tower: existingLot.tower,
      floor: existingLot.floor,
      lotNumber: existingLot.lotNumber,
    });

    const duplicate = await Lot.findOne({
      _id: { $ne: existingLot._id },
      companyId: existingLot.companyId,
      unitKey,
      isDeleted: { $ne: true },
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_UNIT',
        message: `Ya existe un inmueble activo con la misma identidad: ${duplicate.nomenclature || duplicate.lotNumber || ''}`,
        data: { lotId: duplicate._id, nomenclature: duplicate.nomenclature || null },
      });
    }

    existingLot.unitKey = unitKey;

    let lot;
    try {
      lot = await existingLot.save();
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          success: false,
          code: 'DUPLICATE_UNIT',
          message: 'Ya existe un inmueble activo con el mismo identificador.',
        });
      }
      throw error;
    }

    await logAudit(req, {
      action: 'UPDATE_LOT',
      module: 'LOTS',
      targetId: lot._id,
      details: { stage, manzana, lotNumber, price, status }
    });

    res.status(200).json({
      success: true,
      data: lot,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteLot = async (req, res, next) => {
  try {
    const { tenantId, userId } = req.user;
    const { reason } = req.body;

    const lot = await Lot.findOne({ _id: req.params.id, tenantId });

    if (!lot) {
      return res.status(404).json({
        success: false,
        message: 'Lote no encontrado',
      });
    }

    if (lot.isDeleted) {
      return res.status(400).json({
        success: false,
        message: 'El lote ya ha sido eliminado/archivado previamente',
      });
    }

    // 1. Check if lot has active contracts with quotas or payments
    const activeContract = await Contract.findOne({ 
      lot: lot._id, 
      tenantId,
      status: { $ne: 'ANULADO' } 
    }).populate('client');

    if (activeContract) {
      const clientName = activeContract.client?.name || 'Cliente registrado';
      return res.status(400).json({
        success: false,
        message: `No se puede eliminar el lote porque tiene un contrato activo asociado (${clientName}). Para dar de baja el lote, anule o gestione el contrato primero.`,
      });
    }

    // 2. Check if lot is reserved
    if (['apartado', 'separado'].includes(lot.status)) {
      return res.status(400).json({
        success: false,
        message: `El lote tiene una reserva activa en estado '${lot.status}'. Por favor libere el lote antes de eliminarlo.`,
      });
    }

    // 3. Perform Soft Delete
    lot.isDeleted = true;
    lot.deletedAt = new Date();
    lot.deletedBy = userId;
    lot.deletedReason = reason || 'Eliminación manual por usuario';
    await lot.save();

    await logAudit(req, {
      action: 'DELETE_LOT',
      module: 'LOTS',
      targetId: lot._id,
      details: { 
        stage: lot.stage, 
        manzana: lot.manzana, 
        lotNumber: lot.lotNumber, 
        nomenclature: lot.nomenclature,
        reason: lot.deletedReason 
      }
    });

    res.status(200).json({
      success: true,
      message: 'Lote eliminado y archivado correctamente',
    });
  } catch (error) {
    next(error);
  }
};

export const restoreLot = async (req, res, next) => {
  try {
    const { tenantId } = req.user;

    const lot = await Lot.findOne({ _id: req.params.id, tenantId });

    if (!lot) {
      return res.status(404).json({
        success: false,
        message: 'Lote no encontrado',
      });
    }

    if (!lot.isDeleted) {
      return res.status(400).json({
        success: false,
        message: 'El lote no se encuentra eliminado',
      });
    }

    const resolvedPropertyType = normalizePropertyType(lot.propertyType);
    const unitKey = lot.unitKey || buildUnitKey(resolvedPropertyType, {
      stage: lot.stage,
      manzana: lot.manzana,
      tower: lot.tower,
      floor: lot.floor,
      lotNumber: lot.lotNumber,
    });

    const duplicate = await Lot.findOne({
      _id: { $ne: lot._id },
      companyId: lot.companyId,
      unitKey,
      isDeleted: { $ne: true },
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_UNIT',
        message: `No se puede restaurar: ya existe un inmueble activo con la misma identidad (${duplicate.nomenclature || duplicate.lotNumber || 'sin nomenclatura'}).`,
        data: { lotId: duplicate._id, nomenclature: duplicate.nomenclature || null },
      });
    }

    lot.isDeleted = false;
    lot.deletedAt = undefined;
    lot.deletedBy = undefined;
    lot.deletedReason = undefined;
    await lot.save();

    await logAudit(req, {
      action: 'RESTORE_LOT',
      module: 'LOTS',
      targetId: lot._id,
      details: { 
        stage: lot.stage, 
        manzana: lot.manzana, 
        lotNumber: lot.lotNumber, 
        nomenclature: lot.nomenclature 
      }
    });

    res.status(200).json({
      success: true,
      message: 'Lote restaurado correctamente y devuelto al inventario',
      data: lot,
    });
  } catch (error) {
    next(error);
  }
};

export const uploadLotImages = async (req, res, next) => {
  try {
    // Permiso ya validado por middleware

    const { id } = req.params;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No se subieron imágenes',
      });
    }

    const lot = await Lot.findOne({ _id: id, tenantId: req.user.tenantId });
    if (!lot) {
      return res.status(404).json({
        success: false,
        message: 'Lote no encontrado',
      });
    }

    if (lot.isDeleted) {
      return res.status(400).json({
        success: false,
        message: 'No se pueden subir imágenes a un lote eliminado',
      });
    }

    // Process files in memory (multer memoryStorage)
    const uploadPromises = files.map((file) => uploadToR2(file, `lots/${id}`));
    const imageUrls = await Promise.all(uploadPromises);

    lot.images = [...(lot.images || []), ...imageUrls];
    await lot.save();

    res.status(200).json({
      success: true,
      data: lot,
    });
  } catch (error) {
    next(error);
  }
};

export const getLotsPublic = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { search } = req.query;

    let query = { companyId, status: 'disponible', isDeleted: { $ne: true } };
    if (search) {
      query.$or = [
        { stage: { $regex: search, $options: 'i' } },
        { nomenclature: { $regex: search, $options: 'i' } },
        { lotNumber: { $regex: search, $options: 'i' } },
      ];
    }

    const lots = await Lot.find(query)
      .select('stage nomenclature lotNumber area price status images manzana propertyType tower floor')
      .sort({ stage: 1, lotNumber: 1 })
      .lean();

    res.status(200).json({
      success: true,
      data: lots,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Marks a lot as sold, creates a contract and generates quotas
 */
export const sellLot = async (req, res, next) => {
  try {
    const { id } = req.params; // lotId
    const { tenantId, companyId, role, userId } = req.user;
    const { 
      clientId, 
      clientData, 
      totalValue, 
      installmentsCount = 0, 
      initialQuotaPercentage = 0, 
      initialQuotasCount = 1, 
      contractDate,
      startDate,
      negotiation = 'Venta Directa',
      sellerId,
      bonus = '',
      bonusValue = 0,
      separationAmount = 0,
      initialQuotaDueDate,
      paymentDay,
    } = req.body;

    const isSellerRole = ['vendedor', 'ejecutivo_comercial', 'agent'].includes(role);
    const effectiveSellerId = sellerId || (isSellerRole ? userId : null);

    const lot = await Lot.findById(id);
    if (!lot) return res.status(404).json({ success: false, message: 'Lote no encontrado' });

    if (lot.isDeleted) {
      return res.status(400).json({ success: false, message: 'No se puede vender un lote que ha sido eliminado o archivado' });
    }
    
    // Validate installments count
    const maxInstallmentsAllowed = lot.maxInstallments !== undefined ? lot.maxInstallments : 24;
    const installmentsCountParsed = parseInt(installmentsCount) || 0;
    if (installmentsCountParsed > maxInstallmentsAllowed) {
      return res.status(400).json({ 
        success: false, 
        message: `El número máximo de cuotas permitido para este lote es ${maxInstallmentsAllowed}. No se puede seleccionar ${installmentsCountParsed} cuotas.` 
      });
    }

    // Allow selling if it's available or reserved by the same client/seller
    if (lot.status === 'vendido') {
      return res.status(400).json({ success: false, message: 'Lote ya está vendido' });
    }

    // 1. Get or Create Client
    let client;
    if (clientId) {
      client = await Client.findOne({ _id: clientId, tenantId, companyId });
      if (!client) return res.status(404).json({ success: false, message: 'Cliente seleccionado no existe' });
    } else if (clientData) {
      // Avoid creating duplicate clients if one with same ID number already exists
      if (clientData.idNumber) {
        client = await Client.findOne({ idNumber: clientData.idNumber, tenantId, companyId });
      }
      
      if (!client) {
        client = await Client.create({
          ...clientData,
          tenantId,
          companyId,
        });
      }
    } else {
      return res.status(400).json({ success: false, message: 'Debe seleccionar un cliente o proporcionar datos para uno nuevo' });
    }

    // CHECK: Reserved lots can only be sold to the client who reserved them
    if (['apartado', 'separado'].includes(lot.status)) {
      if (lot.reservationBy && lot.reservationBy.toString() !== client._id.toString()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Este lote está reservado por otro cliente y no puede ser vendido a terceros.' 
        });
      }
    }

    let bonusValueParsed = 0;
    let bonusName = '';
    let bonusIdUsed = null;

    if (req.body.bonusId) {
      try {
        const Bonus = (await import('../models/Bonus.js')).default;
        const dbBonus = await Bonus.findOne({ _id: req.body.bonusId, tenantId, companyId, isActive: true });
        if (!dbBonus) {
          return res.status(400).json({ success: false, message: 'El bono seleccionado no es válido o no está activo' });
        }
        bonusValueParsed = dbBonus.value;
        bonusName = dbBonus.name;
        bonusIdUsed = dbBonus._id;
      } catch (bonusError) {
        return res.status(400).json({ success: false, message: 'Error al validar el bono seleccionado' });
      }
    }

    const baseTotalValue = totalValue || lot.price || 0;
    const finalTotalValue = baseTotalValue - bonusValueParsed;

    // 2. Initial Calculations
    const rawInitialAmountTotal = roundMoney(finalTotalValue * (initialQuotaPercentage / 100));
    const effectiveSeparationAmount = parseFloat(separationAmount) || 0;
    const initialAmountTotal = Math.max(0, rawInitialAmountTotal - effectiveSeparationAmount);
    const residualAmount = roundMoney(finalTotalValue - rawInitialAmountTotal);
    
    // We'll calculate installments properly in step 5
    const installmentValueEstimate = installmentsCountParsed > 0 ? roundMoney(residualAmount / installmentsCountParsed) : 0;

    // 3. Create Contract
    const contract = await Contract.create({
      tenantId,
      companyId,
      client: client._id,
      lot: lot._id,
      totalValue: finalTotalValue,
      initialQuotaPercentage: parseFloat(initialQuotaPercentage) || 0,
      initialQuotasCount: parseInt(initialQuotasCount) || 1,
      installmentsCount: installmentsCountParsed,
      installmentValue: installmentValueEstimate,
      contractDate: contractDate || new Date(),
      startDate: startDate || new Date(),
      negotiation,
      sellerId: effectiveSellerId,
      bonus: bonusName,
      bonusId: bonusIdUsed,
      bonusValue: bonusValueParsed,
      paymentDay: parseInt(paymentDay) || null,
      status: 'ACTIVO',
    });

    // 3.1 Create Commission if the company has an active commission plan
    try {
      const { buildCommissionForContract } = await import('../services/commission.service.js');
      await buildCommissionForContract({ contract, tenantId, companyId });
    } catch (commissionError) {
      console.error('[SELL_LOT][COMMISSION] Error al crear comisión:', commissionError);
    }


    // 4. Mark Lot as Sold
    lot.status = 'vendido';
    if (effectiveSellerId) lot.sellerId = effectiveSellerId;
    await lot.save();

    // 5. Generate Quotas with precise rounding and proper due dates
    const quotas = [];
    const baseContractDate = contractDate ? new Date(contractDate) : new Date();
    const baseStartDate = startDate ? new Date(startDate) : new Date();

    // Separation Quota: If separationAmount > 0, create it fully paid!
    if (effectiveSeparationAmount > 0) {
      quotas.push({
        tenantId,
        companyId,
        contract: contract._id,
        number: 0,
        type: 'inicial',
        value: effectiveSeparationAmount,
        dueDate: contractDate || new Date(),
        status: 'pagado',
        amountPaid: effectiveSeparationAmount,
        paymentDate: contractDate || new Date(),
        paymentObservations: 'Abono de separación del lote descontado de la cuota inicial',
      });
    }

    // Initial Quotas breakdown
    let currentInitialSum = 0;
    const iCount = parseInt(initialQuotasCount) || 1;
    const baseInitialVal = roundMoney(initialAmountTotal / iCount);
    const baseInitialDueDate = initialQuotaDueDate ? new Date(initialQuotaDueDate) : new Date(baseContractDate);

    for (let i = 1; i <= iCount; i++) {
      let val = baseInitialVal;
      if (i === iCount) {
        val = roundMoney(initialAmountTotal - currentInitialSum);
      }
      currentInitialSum += val;

      const dueDate = new Date(baseInitialDueDate);
      dueDate.setMonth(dueDate.getMonth() + (i - 1));

      if (val > 0) {
        quotas.push({
          tenantId,
          companyId,
          contract: contract._id,
          number: i,
          type: 'inicial',
          value: val,
          dueDate,
          status: 'pendiente',
        });
      }
    }

    // Regular Quotas breakdown
    let currentNormalSum = 0;
    for (let i = 1; i <= installmentsCountParsed; i++) {
      let val = installmentValueEstimate;
      if (i === installmentsCountParsed) {
        val = roundMoney(residualAmount - currentNormalSum);
      }
      currentNormalSum += val;

      const dueDate = new Date(baseStartDate);
      dueDate.setMonth(dueDate.getMonth() + (i - 1));
      
      // If paymentDay is specified, force the day of the month safely
      const effectivePaymentDay = parseInt(paymentDay) || (contract.paymentDay && contract.paymentDay >= 1 && contract.paymentDay <= 31 ? contract.paymentDay : null);
      if (effectivePaymentDay && effectivePaymentDay >= 1 && effectivePaymentDay <= 31) {
        const lastDay = new Date(dueDate.getFullYear(), dueDate.getMonth() + 1, 0).getDate();
        dueDate.setDate(Math.min(effectivePaymentDay, lastDay));
      }

      if (val > 0) {
        quotas.push({
          tenantId,
          companyId,
          contract: contract._id,
          number: i,
          type: 'normal',
          value: val,
          dueDate,
          status: 'pendiente',
        });
      }
    }

    if (quotas.length > 0) {
      await Quota.insertMany(quotas);
    }

    // Automatically register client to the portal and send welcome credentials email
    try {
      const { registerPortalUserForClient, sendPaymentPlanEmail } = await import('../utils/clientAuthHelper.js');
      await registerPortalUserForClient(client, tenantId, companyId);
      await sendPaymentPlanEmail(client, quotas, contract, companyId);
    } catch (authHelperError) {
      console.error('Error executing welcome notifications in sellLot:', authHelperError);
    }

    await logAudit(req, {
      action: 'SELL_LOT',
      module: 'LOTS',
      targetId: lot._id,
      details: { 
        clientId: client._id, 
        totalValue: finalTotalValue, 
        installments: installmentsCount,
        contractId: contract._id
      }
    });

    res.status(200).json({
      success: true,
      message: 'Lote vendido exitosamente y contrato generado con cuotas',
      data: {
        contract,
        client,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Gets the sale/contract details for a specific lot.
 */
export const getLotSaleDetail = async (req, res, next) => {
  try {
    const { id } = req.params; // lotId
    const { tenantId, companyId } = req.user; 

    const contract = await Contract.findOne({ lot: id, companyId, tenantId })
      .sort({ createdAt: -1 })
      .populate({
        path: 'client',
        select: 'name idNumber phone address email',
      })
      .populate({
        path: 'sellerId',
        populate: { path: 'accountId', select: 'fullName email' },
      })
      .populate({
        path: 'lot',
        select: 'sellerId',
        populate: {
          path: 'sellerId',
          populate: { path: 'accountId', select: 'fullName email' },
        },
      });

    if (!contract) {
      return res.status(404).json({
        success: false,
        message: 'No se encontró un contrato para este lote',
      });
    }

    // Fallback: if contract doesn't have sellerId, take it from lot
    if (!contract.sellerId && contract.lot?.sellerId) {
      const contractObj = contract.toObject();
      contractObj.sellerId = contract.lot.sellerId;
      // Replace contract with the object containing the fallback seller
      res.status(200).json({
        success: true,
        data: {
          contract: contractObj,
          quotas: await Quota.find({ contract: contract._id }).sort({ type: 1, number: 1 }),
        },
      });
      return;
    }

    // Get quotas for this contract
    const quotas = await Quota.find({ contract: contract._id })
      .sort({ type: 1, number: 1 });

    res.status(200).json({
      success: true,
      data: {
        contract,
        quotas,
      },
    });
  } catch (error) {
    next(error);
  }
};
/**
 * Reserves a lot in 'apartado' or 'separado' status
 */
export const reserveLot = async (req, res, next) => {
  try {

    const { id } = req.params;
    const { tenantId, companyId, userId } = req.user;
    const { type, clientId, clientData, observations, amount, expirationDays } = req.body;

    if (!['apartado', 'separado'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Tipo de reserva inválido' });
    }

    const lot = await Lot.findById(id);
    if (!lot) return res.status(404).json({ success: false, message: 'Lote no encontrado' });

    if (lot.isDeleted) {
      return res.status(400).json({ success: false, message: 'No se puede apartar ni separar un lote que ha sido eliminado o archivado' });
    }

    // Check if lot is already reserved/sold
    if (lot.status === 'vendido') {
      return res.status(400).json({ success: false, message: 'El lote ya está vendido' });
    }

    // Logic for transition from 'separado' to 'apartado' for the same client
    const isUpgrade = lot.status === 'separado' && type === 'apartado' && clientId && lot.reservationBy?.toString() === clientId;

    if (lot.status !== 'disponible' && !isUpgrade) {
      return res.status(400).json({ 
        success: false, 
        message: `El lote ya se encuentra en estado '${lot.status}' y no puede ser ${type === 'separado' ? 'separado' : 'apartado'} por otro cliente o nuevamente.` 
      });
    }

    // 1. Get or Create Client
    let client;
    if (clientId) {
      client = await Client.findOne({ _id: clientId, tenantId, companyId });
      if (!client) return res.status(404).json({ success: false, message: 'Cliente seleccionado no existe' });
    } else if (clientData) {
      if (clientData.idNumber) {
        client = await Client.findOne({ idNumber: clientData.idNumber, tenantId, companyId });
      }
      if (!client) {
        client = await Client.create({ ...clientData, tenantId, companyId });
      }
    } else {
      return res.status(400).json({ success: false, message: 'Debe proporcionar datos del cliente' });
    }

    // 2. Separate logic for 'separado' (min $500,000)
    if (type === 'separado') {
      const minAmount = 500000;
      const paidAmount = parseFloat(amount) || 0;
      if (paidAmount < minAmount) {
        return res.status(400).json({ 
          success: false, 
          message: `Para separar el lote se requiere un monto mínimo de $${minAmount.toLocaleString()}` 
        });
      }
    }

    // 3. Update Lot
    const days = parseInt(expirationDays) || (type === 'separado' ? 30 : 5);
    if (type === 'separado' && days > 30) {
      return res.status(400).json({ 
        success: false, 
        message: 'El plazo de separación no puede superar los 30 días' 
      });
    }
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    lot.status = type;
    lot.reservedAt = new Date();
    lot.expiresAt = expiresAt;
    lot.reservationBy = client._id;
    lot.reservationDetails = observations;
    lot.sellerId = userId;
    await lot.save();

    await logAudit(req, {
      action: `RESERVE_LOT_${type.toUpperCase()}`,
      module: 'LOTS',
      targetId: lot._id,
      details: { clientId: client._id, type, amount }
    });

    res.status(200).json({
      success: true,
      message: `Lote ${type} exitosamente`,
      data: lot
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Manually releases a lot back to 'disponible'
 */
export const releaseLot = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason, observations } = req.body;

    const lot = await Lot.findById(id);
    if (!lot) return res.status(404).json({ success: false, message: 'Lote no encontrado' });

    const previousStatus = lot.status;
    lot.status = 'disponible';
    lot.reservedAt = undefined;
    lot.expiresAt = undefined;
    lot.reservationBy = undefined;
    lot.reservationDetails = undefined;
    lot.sellerId = undefined;
    await lot.save();

    await logAudit(req, {
      action: 'RELEASE_LOT',
      module: 'LOTS',
      targetId: lot._id,
      details: { previousStatus, reason, observations }
    });

    res.status(200).json({
      success: true,
      message: 'Lote liberado correctamente y ya está disponible',
      data: lot
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Carga histórica de asesores: vincula un asesor comercial a un contrato/lote ya
 * vendido (p.ej. Reserva de Alicante). Si el contrato no tiene comisión creada,
 * la genera y evalúa los hitos ya cumplidos para que el histórico alimente de
 * inmediato los informes consolidados y el cálculo de comisiones.
 * POST /lots/:id/assign-seller  { sellerId }
 */
export const assignLotSeller = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const { id } = req.params;
    const { sellerId } = req.body;

    if (!sellerId) {
      return res.status(400).json({ success: false, message: 'Debe seleccionar un asesor' });
    }

    const lot = await Lot.findOne({ _id: id, tenantId, companyId });
    if (!lot) return res.status(404).json({ success: false, message: 'Lote no encontrado' });

    if (lot.isDeleted) {
      return res.status(400).json({ success: false, message: 'No se puede vincular asesor a un lote eliminado' });
    }

    const contract = await Contract.findOne({ lot: lot._id, tenantId, companyId });
    if (!contract) {
      return res.status(400).json({ success: false, message: 'Este lote no tiene un contrato asociado para vincular asesor' });
    }

    const User = (await import('../models/User.js')).default;
    const seller = await User.findById(sellerId).populate('accountId');
    if (!seller) return res.status(400).json({ success: false, message: 'El asesor seleccionado no existe' });

    contract.sellerId = seller._id;
    await contract.save();

    if (lot.status === 'vendido') {
      lot.sellerId = seller._id;
      await lot.save();
    }

    // Generar comisión si el contrato histórico no tiene una (alimenta comisiones e informes)
    try {
      const { buildCommissionForContract, evaluateCommissionMilestones } = await import('../services/commission.service.js');
      const Commission = (await import('../models/Commission.js')).default;
      const existing = await Commission.findOne({ contractId: contract._id, tenantId, companyId });
      if (!existing) {
        await buildCommissionForContract({ contract, tenantId, companyId });
      }
      await evaluateCommissionMilestones({ contractId: contract._id, tenantId, companyId });
    } catch (commissionError) {
      console.error('[ASSIGN_SELLER][COMMISSION] Error generando comisión:', commissionError);
    }

    await logAudit(req, {
      action: 'ASSIGN_SELLER',
      module: 'LOTS',
      targetId: lot._id,
      details: { contractId: contract._id, sellerId: seller._id }
    });

    res.status(200).json({
      success: true,
      message: `Asesor vinculado correctamente al contrato del lote ${lot.nomenclature || lot.lotNumber}`,
      data: {
        contractId: contract._id,
        sellerId: seller._id,
        sellerName: seller.accountId?.fullName || seller.email || 'Asesor',
      },
    });
  } catch (error) {
    next(error);
  }
};
