import mongoose from 'mongoose';
import Lot from '../models/Lot.js';
import Client from '../models/Client.js';
import Contract from '../models/Contract.js';
import Quota from '../models/Quota.js';
import { uploadToR2, deleteFromR2 } from '../utils/storage.js';
import { logAudit } from '../utils/auditLogger.js';
import { checkLotExpirations } from '../utils/lotExpiration.js';
import { buildUnitKey, buildNomenclature, normalizePropertyType } from '../utils/propertyIdentifier.js';
import AppError from '../utils/AppError.js';
import { parseBusinessDate } from '../utils/dates.js';
import { buildSalePlan, PLAN_RULES_VERSION, toCalendarDate, toISODate } from '../services/paymentPlanRules.js';
import { getPaymentPlanPolicy } from '../services/paymentPlan.service.js';
import { escapeRegex } from '../utils/regex.js';

// What a sale or a reservation may set on a new buyer: contact data only, never consent, verification
// flags or ownership fields
const BUYER_FIELDS = ['name', 'idNumber', 'phone', 'email', 'address', 'behavior'];
const buyerFields = (data = {}) => Object.fromEntries(BUYER_FIELDS.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));

/** A buyer as the panel may see it: the data-validation token only travels in the message to the buyer */
const withoutValidationToken = (client) => {
  if (!client) return client;
  const plain = typeof client.toObject === 'function' ? client.toObject() : { ...client };
  delete plain.validationToken;
  return plain;
};


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
      tower,
      floor,
      sellerId,
      minArea,
      maxArea,
      showDeleted,
      expiresWithinDays,
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
      query.manzana = { $regex: escapeRegex(String(manzana).trim()), $options: 'i' };
    }
    if (stage) {
      query.stage = { $regex: escapeRegex(String(stage).trim()), $options: 'i' };
    }
    if (tower) {
      query.tower = { $regex: escapeRegex(String(tower).trim()), $options: 'i' };
    }
    if (floor) {
      // Floor 1 must not bring 10 or 11; «Piso 1» counts as 1
      query.floor = { $regex: `^(?:piso\\s*)?${escapeRegex(String(floor).trim())}$`, $options: 'i' };
    }
    // Apartados and separados about to be released (the Pendientes row links here with 3 days)
    const expiring = parseInt(expiresWithinDays, 10);
    if (Number.isInteger(expiring) && expiring >= 1 && expiring <= 60) {
      const now = new Date();
      query.expiresAt = { $gte: now, $lte: new Date(now.getTime() + expiring * 24 * 60 * 60 * 1000) };
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
          { stage: { $regex: escapeRegex(search), $options: 'i' } },
          { manzana: { $regex: escapeRegex(search), $options: 'i' } },
          { nomenclature: { $regex: escapeRegex(search), $options: 'i' } },
          { lotNumber: { $regex: escapeRegex(search), $options: 'i' } },
          { reference: { $regex: escapeRegex(search), $options: 'i' } },
          { tower: { $regex: escapeRegex(search), $options: 'i' } },
          { floor: { $regex: escapeRegex(search), $options: 'i' } },
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
        if (lotSellerMap[lotIdStr]) {
          const lotObj = l.toObject();
          lotObj.sellerId = lotSellerMap[lotIdStr];
          return lotObj;
        }
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

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Lote no encontrado' });
    }
    // With ?companyId= (the panel's record) only that project's lot; older callers keep the tenant scope
    const scope = { _id: req.params.id, tenantId };
    if (req.query.companyId && mongoose.isValidObjectId(req.query.companyId)) scope.companyId = req.query.companyId;
    const lot = await Lot.findOne(scope)
      .populate({
        path: 'sellerId',
        populate: { path: 'accountId', select: 'fullName email' },
      })
      // Only what the record shows: never the whole buyer (it carries the data-validation token)
      .populate('reservationBy', 'name idNumber phone email')
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

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Lote no encontrado' });
    }
    // With ?companyId= (the panel's record) only that project's lot; older callers keep the tenant scope
    const scope = { _id: req.params.id, tenantId };
    if (req.query.companyId && mongoose.isValidObjectId(req.query.companyId)) scope.companyId = req.query.companyId;
    const lot = await Lot.findOne(scope);

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

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Lote no encontrado' });
    }
    // With ?companyId= (the panel's record) only that project's lot; older callers keep the tenant scope
    const scope = { _id: req.params.id, tenantId };
    if (req.query.companyId && mongoose.isValidObjectId(req.query.companyId)) scope.companyId = req.query.companyId;
    const lot = await Lot.findOne(scope);

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

/** Takes one photo off a lot's catalog and deletes its file */
export const removeLotImage = async (req, res, next) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') return next(new AppError('Falta la imagen que quieres quitar', 400));

    const lot = await Lot.findOne({ _id: req.params.id, tenantId: req.user.tenantId });
    if (!lot) return next(new AppError('Lote no encontrado', 404));
    if (lot.isDeleted) return next(new AppError('No se pueden quitar imágenes de un lote eliminado', 400));
    if (!(lot.images || []).includes(url)) return next(new AppError('Esa imagen no está en el lote', 404));

    lot.images = lot.images.filter((image) => image !== url);
    await lot.save();

    // The lot no longer shows it; a file left behind in storage is not worth failing the request
    deleteFromR2(url).catch((error) => console.error('[lots] could not delete image file:', error.message));

    await logAudit(req, {
      action: 'REMOVE_LOT_IMAGE',
      module: 'LOTS',
      targetId: lot._id,
      details: { lotNumber: lot.lotNumber, nomenclature: lot.nomenclature },
    });

    res.status(200).json({ success: true, data: lot });
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
        { stage: { $regex: escapeRegex(search), $options: 'i' } },
        { nomenclature: { $regex: escapeRegex(search), $options: 'i' } },
        { lotNumber: { $regex: escapeRegex(search), $options: 'i' } },
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

const SELLER_ROLES = ['vendedor', 'ejecutivo_comercial', 'agent'];

/**
 * A seller may sell in their own name under the same rules as the office, but not with an
 * office exception: only their own reservations, at the list price, dated today and with the
 * separation recorded when the unit was separated. Returns the message that blocks it, or null.
 */
const sellerSaleBlock = ({ lot, body, userId }) => {
  const reserved = ['apartado', 'separado'].includes(lot.status);
  if (reserved && lot.sellerId && String(lot.sellerId) !== String(userId)) {
    return 'Este inmueble está reservado a nombre de otro asesor';
  }
  if (body.totalValue != null && Number(body.totalValue) !== Number(lot.price || 0)) {
    return 'Vende al precio de lista (o con un bono activo); cambiar el valor lo hace la oficina';
  }
  if (body.contractDate) {
    const today = toISODate(toCalendarDate(new Date()));
    if (toISODate(toCalendarDate(parseBusinessDate(body.contractDate))) !== today) {
      return 'La venta queda con la fecha de hoy; una venta con otra fecha la registra la oficina';
    }
  }
  const recorded = lot.status === 'separado' ? (lot.reservationAmount || 0) : 0;
  if ((parseFloat(body.separationAmount) || 0) !== recorded) {
    return recorded
      ? `El abono de separación es el que quedó registrado al separar ($${recorded.toLocaleString('es-CO')}); otro valor lo corrige la oficina`
      : 'Sin una separación registrada la venta no lleva abono de separación; el pago de la cuota inicial lo valida cartera';
  }
  return null;
};

/**
 * Resolves the bonus and the project policy of a sale and builds its payment plan.
 * Shared by the sale and its preview so the rules live in one place.
 */
const buildPlanForSale = async ({ lot, body, tenantId, companyId }) => {
  const {
    totalValue,
    installmentsCount = 0,
    initialQuotaPercentage = 0,
    initialQuotasCount = 1,
    contractDate,
    separationAmount = 0,
    paymentDay,
    initialQuotaMode,
    earlyStart = false,
    bonusId,
  } = body;

  let bonus = null;
  if (bonusId) {
    const Bonus = (await import('../models/Bonus.js')).default;
    let dbBonus = null;
    try {
      dbBonus = await Bonus.findOne({ _id: bonusId, tenantId, companyId, isActive: true });
    } catch (bonusError) {
      throw new AppError('Error al validar el bono seleccionado', 400);
    }
    if (!dbBonus) throw new AppError('El bono seleccionado no es válido o no está activo', 400);
    bonus = { id: dbBonus._id, name: dbBonus.name, value: dbBonus.value };
  }

  const baseTotalValue = totalValue || lot.price || 0;
  const finalTotalValue = baseTotalValue - (bonus?.value || 0);
  const saleDate = parseBusinessDate(contractDate, new Date());
  const policy = await getPaymentPlanPolicy({ tenantId, companyId });

  const plan = buildSalePlan({
    saleDate,
    totalValue: finalTotalValue,
    initialQuotaPercentage,
    separationAmount,
    installmentsCount,
    paymentDay,
    policy,
    initialQuotaMode,
    initialQuotasCount,
    earlyStart,
    maxInstallments: lot.maxInstallments !== undefined ? lot.maxInstallments : 24,
  });
  return { plan, bonus, finalTotalValue, saleDate };
};

const serializePlan = (plan) => ({
  ...plan,
  initialDeadline: plan.initialDeadline ? toISODate(toCalendarDate(plan.initialDeadline)) : null,
  firstOrdinaryDate: plan.firstOrdinaryDate ? toISODate(toCalendarDate(plan.firstOrdinaryDate)) : null,
  quotas: plan.quotas.map((q) => ({ ...q, dueDate: toISODate(toCalendarDate(q.dueDate)), paymentDate: undefined })),
});

/**
 * Previews the payment plan of a sale under the project policy, without saving anything.
 */
export const previewLotSale = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const lot = await Lot.findOne({ _id: req.params.id, tenantId, companyId });
    if (!lot) return res.status(404).json({ success: false, message: 'Lote no encontrado' });
    if (SELLER_ROLES.includes(req.user.role)) {
      const blocked = sellerSaleBlock({ lot, body: req.body, userId: req.user.userId });
      if (blocked) return res.status(403).json({ success: false, message: blocked });
    }

    const { plan, bonus, finalTotalValue } = await buildPlanForSale({ lot, body: req.body, tenantId, companyId });
    res.status(200).json({
      success: true,
      data: { ...serializePlan(plan), totalValue: finalTotalValue, bonusValue: bonus?.value || 0 },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Marks a lot as sold, creates a contract and generates quotas under the project payment plan policy
 */
export const sellLot = async (req, res, next) => {
  try {
    const { id } = req.params; // lotId
    const { tenantId, companyId, role, userId } = req.user;
    const { 
      clientId, 
      clientData, 
      initialQuotaPercentage = 0, 
      startDate,
      negotiation = 'Venta Directa',
      sellerId,
    } = req.body;

    const isSellerRole = SELLER_ROLES.includes(role);
    // A seller sells for themselves; anyone else may name an active member of this team
    if (isSellerRole && sellerId && String(sellerId) !== String(userId)) {
      return res.status(403).json({ success: false, message: 'Solo puedes registrar ventas a tu nombre' });
    }
    const effectiveSellerId = isSellerRole ? userId : (sellerId || null);
    if (effectiveSellerId && !isSellerRole) {
      const User = (await import('../models/User.js')).default;
      const seller = mongoose.isValidObjectId(effectiveSellerId)
        ? await User.exists({ _id: effectiveSellerId, tenantId, status: 'active', role: { $ne: 'cliente' } })
        : null;
      if (!seller) return res.status(400).json({ success: false, message: 'El asesor seleccionado no es del equipo' });
    }

    const lot = await Lot.findOne({ _id: id, tenantId, companyId });
    if (!lot) return res.status(404).json({ success: false, message: 'Lote no encontrado' });

    if (lot.isDeleted) {
      return res.status(400).json({ success: false, message: 'No se puede vender un lote que ha sido eliminado o archivado' });
    }

    // Allow selling if it's available or reserved by the same client/seller
    if (lot.status === 'vendido') {
      return res.status(400).json({ success: false, message: 'Lote ya está vendido' });
    }
    if (isSellerRole) {
      const blocked = sellerSaleBlock({ lot, body: req.body, userId });
      if (blocked) return res.status(403).json({ success: false, message: blocked });
    }

    // Validate the plan against the project policy before creating anything
    let saleContext;
    try {
      saleContext = await buildPlanForSale({ lot, body: req.body, tenantId, companyId });
    } catch (planError) {
      if (planError.statusCode === 400) {
        return res.status(400).json({ success: false, message: planError.message });
      }
      throw planError;
    }
    const { plan, bonus, finalTotalValue, saleDate } = saleContext;

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
          ...buyerFields(clientData),
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

    // 2. Create Contract (sold under the payment plan rules v2)
    const firstOrdinary = plan.quotas.find((q) => q.type === 'normal');
    const contract = await Contract.create({
      tenantId,
      companyId,
      client: client._id,
      lot: lot._id,
      totalValue: finalTotalValue,
      initialQuotaPercentage: parseFloat(initialQuotaPercentage) || 0,
      initialQuotasCount: plan.initialQuotasCount,
      installmentsCount: plan.installmentsCount,
      installmentValue: plan.installmentValue,
      contractDate: saleDate,
      startDate: startDate || firstOrdinary?.dueDate || saleDate,
      negotiation,
      sellerId: effectiveSellerId,
      bonus: bonus?.name || '',
      bonusId: bonus?.id || null,
      bonusValue: bonus?.value || 0,
      paymentDay: plan.paymentDay,
      status: 'ACTIVO',
      planRules: PLAN_RULES_VERSION,
      planPolicy: {
        initialDeadlineDays: plan.policy.initialDeadlineDays,
        minDaysBeforeFirstOrdinary: plan.policy.minDaysBeforeFirstOrdinary,
        earlyStart: plan.earlyStart,
        initialQuotaMode: plan.initialQuotaMode,
      },
      initialDeadline: plan.initialDeadline,
      legalStatus: 'sin_firmar',
    });

    // 2.1 Create Commission if the company has an active commission plan
    try {
      const { buildCommissionForContract } = await import('../services/commission.service.js');
      await buildCommissionForContract({ contract, tenantId, companyId });
    } catch (commissionError) {
      console.error('[SELL_LOT][COMMISSION] Error al crear comisión:', commissionError);
    }


    // 3. Mark Lot as Sold
    lot.status = 'vendido';
    if (effectiveSellerId) lot.sellerId = effectiveSellerId;
    await lot.save();

    // 4. Generate Quotas from the plan (separation, initial and ordinary quotas)
    const quotas = plan.quotas.map((q) => ({
      tenantId,
      companyId,
      contract: contract._id,
      ...q,
      ...(q.number === 0 && { paymentObservations: 'Abono de separación del lote descontado de la cuota inicial' }),
    }));

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
        installments: plan.installmentsCount,
        contractId: contract._id,
        paymentDay: plan.paymentDay,
        initialDeadline: plan.initialDeadline,
        initialQuotaMode: plan.initialQuotaMode,
        earlyStart: plan.earlyStart,
      }
    });

    res.status(200).json({
      success: true,
      message: 'Lote vendido exitosamente y contrato generado con cuotas',
      data: {
        contract,
        client: withoutValidationToken(client),
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
    const { tenantId, companyId, userId, role } = req.user;
    const { type, clientId, clientData, observations, amount, expirationDays, sellerId } = req.body;

    if (!['apartado', 'separado'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Tipo de reserva inválido' });
    }

    const lot = await Lot.findOne({ _id: id, tenantId, companyId });
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

    // The seller of a reservation is the one the form names, not whoever registers it:
    // a seller reserves for themselves; anyone else may name an active member of this team
    const isSellerRole = SELLER_ROLES.includes(role);
    if (isSellerRole && sellerId && String(sellerId) !== String(userId)) {
      return res.status(403).json({ success: false, message: 'Solo puedes registrar reservas a tu nombre' });
    }
    if (isSellerRole && isUpgrade && lot.sellerId && String(lot.sellerId) !== String(userId)) {
      return res.status(403).json({ success: false, message: 'Este inmueble está reservado a nombre de otro asesor' });
    }
    let reservationSellerId = isSellerRole ? userId : (sellerId || null);
    if (reservationSellerId && !isSellerRole) {
      const User = (await import('../models/User.js')).default;
      const seller = mongoose.isValidObjectId(reservationSellerId)
        ? await User.exists({ _id: reservationSellerId, tenantId, status: 'active', role: { $ne: 'cliente' } })
        : null;
      if (!seller) return res.status(400).json({ success: false, message: 'El asesor seleccionado no es del equipo' });
    }
    // Turning a separation into an apartado keeps its seller unless the form names another
    if (isUpgrade && !reservationSellerId) reservationSellerId = lot.sellerId || null;

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
        client = await Client.create({ ...buyerFields(clientData), tenantId, companyId });
      }
    } else {
      return res.status(400).json({ success: false, message: 'Debe proporcionar datos del cliente' });
    }

    // 2. Separate logic for 'separado' (min $500,000)
    const paidAmount = parseFloat(amount) || 0;
    if (type === 'separado') {
      const minAmount = 500000;
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
    // The separation payment is kept so the sale discounts the real amount; an upgrade keeps it
    if (type === 'separado') lot.reservationAmount = paidAmount;
    else if (!isUpgrade) lot.reservationAmount = undefined;
    lot.sellerId = reservationSellerId || undefined;
    await lot.save();

    await logAudit(req, {
      action: `RESERVE_LOT_${type.toUpperCase()}`,
      module: 'LOTS',
      targetId: lot._id,
      details: { clientId: client._id, type, amount, sellerId: reservationSellerId }
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
    const { tenantId, companyId } = req.user;
    const { reason, observations } = req.body;

    const lot = await Lot.findOne({ _id: id, tenantId, companyId });
    if (!lot) return res.status(404).json({ success: false, message: 'Lote no encontrado' });

    // Only a reservation is released: a sold lot has a contract and payments, and
    // releasing it allowed selling it again
    if (!['apartado', 'separado'].includes(lot.status)) {
      return res.status(400).json({ success: false, message: `Solo se puede liberar un lote apartado o separado; este está ${lot.status}` });
    }

    const previousStatus = lot.status;
    lot.status = 'disponible';
    lot.reservedAt = undefined;
    lot.expiresAt = undefined;
    lot.reservationBy = undefined;
    lot.reservationDetails = undefined;
    lot.reservationAmount = undefined;
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

    // Same rule as a sale: an active member of this team, never a buyer's portal user
    const User = (await import('../models/User.js')).default;
    const seller = mongoose.isValidObjectId(sellerId)
      ? await User.findOne({ _id: sellerId, tenantId, status: 'active', role: { $ne: 'cliente' } }).populate('accountId')
      : null;
    if (!seller) return res.status(400).json({ success: false, message: 'El asesor seleccionado no es del equipo' });

    contract.sellerId = seller._id;
    await contract.save();

    if (lot.status === 'vendido') {
      lot.sellerId = seller._id;
      await lot.save();
    }

    // Generar comisión si el contrato histórico no tiene una (alimenta comisiones e informes)
    // Says whether the commission stayed with the previous seller, so the panel can warn about it
    let commissionWarning = null;
    try {
      const { buildCommissionForContract, evaluateCommissionMilestones } = await import('../services/commission.service.js');
      const Commission = (await import('../models/Commission.js')).default;
      const existing = await Commission.findOne({ contractId: contract._id, tenantId, companyId });
      if (!existing) {
        await buildCommissionForContract({ contract, tenantId, companyId });
      } else if (String(existing.sellerId) !== String(seller._id)
        && existing.installments.every((i) => ['PENDING', 'AVAILABLE'].includes(i.status))) {
        // Nothing filed yet: the commission follows the contract's new seller
        existing.sellerId = seller._id;
        await existing.save();
      } else if (String(existing.sellerId) !== String(seller._id)) {
        commissionWarning = 'La comisión de este contrato ya tiene cuotas radicadas, aprobadas o pagadas y sigue a nombre del asesor anterior.';
      }
      await evaluateCommissionMilestones({ contractId: contract._id, tenantId, companyId });
    } catch (commissionError) {
      console.error('[ASSIGN_SELLER][COMMISSION] Error generando comisión:', commissionError);
      commissionWarning = 'El asesor quedó en el contrato, pero la comisión no se pudo actualizar. Revísala en Comisiones.';
    }

    await logAudit(req, {
      action: 'ASSIGN_SELLER',
      module: 'LOTS',
      targetId: lot._id,
      details: { contractId: contract._id, sellerId: seller._id, ...(commissionWarning ? { commissionWarning } : {}) }
    });

    res.status(200).json({
      success: true,
      message: `Asesor vinculado correctamente al contrato del lote ${lot.nomenclature || lot.lotNumber}`,
      data: {
        contractId: contract._id,
        sellerId: seller._id,
        sellerName: seller.accountId?.fullName || seller.email || 'Asesor',
        commissionWarning,
      },
    });
  } catch (error) {
    next(error);
  }
};
