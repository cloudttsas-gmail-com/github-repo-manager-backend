import express from 'express';
import mongoose from 'mongoose';
import Client from '../models/Client.js';
import Contract from '../models/Contract.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';
import { logAudit } from '../utils/auditLogger.js';

import Quota from '../models/Quota.js';
import UserAccount from '../models/UserAccount.js';
import User from '../models/User.js';
import { publicLinkUrl } from '../utils/publicLinks.js';
import { buildStatementSummary, startOfBogotaDay } from '../services/statementSummary.service.js';
import { sendClientStatement, shareClientStatementLink, getClientStatementDeliveries } from '../controllers/statement.controller.js';

const router = express.Router();

// All client routes require auth + tenant
router.use(protect);
router.use(tenantMiddleware);

const DAY_MS = 24 * 60 * 60 * 1000;

// Days in arrears ranges of Cartera, by the oldest overdue quota (same rule as the statement)
const MORA_RANGES = {
  MORA_1_15: [1, 15],
  MORA_16_30: [16, 30],
  MORA_31_60: [31, 60],
  MORA_61_90: [61, 90],
  MORA_90_PLUS: [91, Infinity],
};
const inMoraRange = ([min, max]) => ({ $and: [{ $gte: ['$diasMora', min] }, ...(max === Infinity ? [] : [{ $lte: ['$diasMora', max] }])] });

/**
 * One row per client of the active project (sellers only see their own), with its contracts,
 * totals, arrears and days in arrears. The list and the counters use the same rows.
 */
const buildClientRowsPipeline = async (req, { search = '', behaviorFilter } = {}) => {
  const { tenantId, companyId, role, userId } = req.user;
  const today = startOfBogotaDay();
  let matchQuery = { 
    tenantId: new mongoose.Types.ObjectId(tenantId), 
    companyId: new mongoose.Types.ObjectId(companyId), 
  };

  if (role === 'vendedor' || role === 'ejecutivo_comercial' || role === 'agent') {
    const sellerClients = await Contract.find({ tenantId, companyId, sellerId: userId }).distinct('client');
    matchQuery.$or = [
      { _id: { $in: sellerClients } },
      { createdBy: new mongoose.Types.ObjectId(userId) },
    ];
  }
  
  if (search) {
    const searchFilter = {
      $or: [
        { name: { $regex: search, $options: 'i' } },
        { idNumber: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ],
    };

    if (matchQuery.$or) {
      // If we already have a role filter, wrap in $and
      const roleFilter = { $or: matchQuery.$or };
      delete matchQuery.$or;
      matchQuery.$and = [roleFilter, searchFilter];
    } else {
      matchQuery.$or = searchFilter.$or;
    }
  }

  if (behaviorFilter && behaviorFilter !== 'ALL') {
    matchQuery.behavior = behaviorFilter;
  }

  const aggregatePipeline = [
    { $match: matchQuery },
    // Join with Contracts
    {
      $lookup: {
        from: 'contracts',
        localField: '_id',
        foreignField: 'client',
        as: 'contracts',
      },
    },
    // Join with Quotas (unwind contracts first to join, then group back)
    { $unwind: { path: '$contracts', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'quotas',
        let: { contractId: '$contracts._id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$contract', '$$contractId'] } } },
        ],
        as: 'allQuotas',
      },
    },
    {
      $addFields: {
        // Overdue and paid follow the statement summary (statementSummary.service.js):
        // an unpaid balance with a due day before today is overdue, whatever the stored status says
        'contracts.moraQuotas': {
          $filter: {
            input: '$allQuotas',
            as: 'q',
            cond: {
              $and: [
                { $ne: ['$$q.status', 'pagado'] },
                { $lt: ['$$q.dueDate', today] },
                { $gt: [{ $subtract: [{ $ifNull: ['$$q.value', 0] }, { $ifNull: ['$$q.amountPaid', 0] }] }, 0] },
              ],
            },
          },
        },
        'contracts.paidAmounts': {
          $map: {
            input: '$allQuotas',
            as: 'q',
            in: {
              $cond: [
                { $eq: ['$$q.status', 'pagado'] },
                { $cond: [{ $gt: [{ $ifNull: ['$$q.amountPaid', 0] }, 0] }, '$$q.amountPaid', { $ifNull: ['$$q.value', 0] }] },
                { $ifNull: ['$$q.amountPaid', 0] },
              ],
            },
          },
        },
      },
    },
    {
      $addFields: {
        'contracts.totalPagadoQuotas': { $sum: '$contracts.paidAmounts' },
        'contracts.hasMora': { $gt: [{ $size: '$contracts.moraQuotas' }, 0] },
        'contracts.oldestMoraDue': { $min: '$contracts.moraQuotas.dueDate' },
      },
    },
    {
      $addFields: {
        'contracts.realPaid': {
          $max: [
            '$contracts.totalPagadoQuotas',
            {
              $add: [
                { $ifNull: ['$contracts.recaudadoSiigo2024', 0] },
                { $ifNull: ['$contracts.recaudadoSiigo2025', 0] },
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: '$_id',
        name: { $first: '$name' },
        idNumber: { $first: '$idNumber' },
        phone: { $first: '$phone' },
        email: { $first: '$email' },
        address: { $first: '$address' },
        behavior: { $first: '$behavior' },
        createdAt: { $first: '$createdAt' },
        totalValue: { $sum: '$contracts.totalValue' },
        totalPaid: { $sum: '$contracts.realPaid' },
        hasMora: { $max: '$contracts.hasMora' },
        oldestMoraDue: { $min: '$contracts.oldestMoraDue' },
        contracts: { $push: '$contracts' },
      },
    },
    {
      $addFields: {
        totalContracts: {
          $cond: [
            { $eq: [{ $arrayElemAt: ['$contracts', 0] }, {}] },
            0,
            { $size: '$contracts' },
          ],
        },
        totalPending: { $subtract: ['$totalValue', '$totalPaid'] },
        porcentajeRecaudo: {
          $cond: [
            { $gt: ['$totalValue', 0] },
            { $multiply: [{ $divide: ['$totalPaid', '$totalValue'] }, 100] },
            0,
          ],
        },
        diasMora: {
          $cond: [
            { $ifNull: ['$oldestMoraDue', false] },
            { $max: [1, { $ceil: { $divide: [{ $subtract: [today, '$oldestMoraDue'] }, DAY_MS] } }] },
            0,
          ],
        },
      },
    },
  ];
  return aggregatePipeline;
};

// Company-scoped: GET /clients?companyId=xxx
router.get('/', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_VIEW), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy;
    const order = req.query.order;
    const behaviorFilter = req.query.behavior;
    const moraOnly = req.query.moraOnly === 'true';
    const alDiaOnly = req.query.alDiaOnly === 'true';
    const moraRange = MORA_RANGES[req.query.moraRange];

    // Dynamic sort
    let sortObj = { createdAt: -1 };
    if (sortBy) {
      sortObj = { [sortBy]: order === 'asc' ? 1 : -1 };
    }

    const aggregatePipeline = await buildClientRowsPipeline(req, { search, behaviorFilter });

    if (moraRange) {
      aggregatePipeline.push({ $match: { $expr: inMoraRange(moraRange) } });
    } else if (moraOnly) {
      aggregatePipeline.push({ $match: { hasMora: true } });
    } else if (alDiaOnly) {
      aggregatePipeline.push({ $match: { totalContracts: { $gt: 0 }, hasMora: false } });
    }

    // Capture total for pagination before skip/limit
    const countPipeline = [...aggregatePipeline, { $count: 'total' }];
    const countResults = await Client.aggregate(countPipeline);
    const total = countResults[0]?.total || 0;

    // Apply sort, skip, limit
    aggregatePipeline.push({ $sort: sortObj });
    aggregatePipeline.push({ $skip: skip });
    aggregatePipeline.push({ $limit: limit });

    const clients = await Client.aggregate(aggregatePipeline);

    // Enrich each client with its advisors (derived from Contract.sellerId)
    const sellerIds = [...new Set(
      clients.flatMap((c) => (c.contracts || []).map((ct) => ct.sellerId?.toString()).filter(Boolean))
    )];
    if (sellerIds.length > 0) {
      const sellerUsers = await User.find({ _id: { $in: sellerIds } }).populate({
        path: 'accountId',
        select: 'fullName',
      });
      const sellerMap = new Map(sellerUsers.map((u) => [u._id.toString(), u.accountId?.fullName || 'N/A']));
      clients.forEach((c) => {
        c.sellerNames = [...new Set(
          (c.contracts || [])
            .map((ct) => sellerMap.get(ct.sellerId?.toString()))
            .filter(Boolean)
        )];
      });
    } else {
      clients.forEach((c) => { c.sellerNames = []; });
    }

    res.json({
      success: true,
      data: {
        clients,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /clients/stats?companyId=xxx - Counters of Clientes and Cartera over all the project's clients
router.get('/stats', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_VIEW), async (req, res) => {
  try {
    const pipeline = await buildClientRowsPipeline(req);
    const rangeCounts = Object.fromEntries(Object.entries(MORA_RANGES).map(([key, range]) => [
      key, { $sum: { $cond: [inMoraRange(range), 1, 0] } },
    ]));
    pipeline.push({
      $group: {
        _id: null,
        total: { $sum: 1 },
        alDia: { $sum: { $cond: [{ $and: [{ $gt: ['$totalContracts', 0] }, { $ne: ['$hasMora', true] }] }, 1, 0] } },
        enMora: { $sum: { $cond: [{ $eq: ['$hasMora', true] }, 1, 0] } },
        DISPUESTO: { $sum: { $cond: [{ $eq: ['$behavior', 'DISPUESTO'] }, 1, 0] } },
        EVASIVO: { $sum: { $cond: [{ $eq: ['$behavior', 'EVASIVO'] }, 1, 0] } },
        INDECISO: { $sum: { $cond: [{ $eq: ['$behavior', 'INDECISO'] }, 1, 0] } },
        ...rangeCounts,
      },
    });
    const [row = {}] = await Client.aggregate(pipeline);
    res.json({
      success: true,
      data: {
        total: row.total || 0,
        alDia: row.alDia || 0,
        enMora: row.enMora || 0,
        behavior: { DISPUESTO: row.DISPUESTO || 0, EVASIVO: row.EVASIVO || 0, INDECISO: row.INDECISO || 0 },
        moraRanges: Object.fromEntries(Object.keys(MORA_RANGES).map((key) => [key, row[key] || 0])),
      },
    });
  } catch (error) {
    console.error('Error fetching client stats:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /clients/:id - Detail with contracts
router.get('/:id', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_DETAILS), async (req, res) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    const { id } = req.params;

    const query = { _id: id, tenantId, companyId };
    if (role === 'vendedor' || role === 'ejecutivo_comercial' || role === 'agent') {
      const hasContract = await Contract.exists({ client: id, sellerId: userId, tenantId, companyId });
      if (!hasContract) {
        return res.status(403).json({ success: false, message: 'No tienes permiso para ver este cliente' });
      }
    }

    const client = await Client.findOne(query);
    if (!client) {
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    // Get contracts for this client
    const contracts = await Contract.find({ client: id, tenantId, companyId })
      .populate('lot')
      .populate({
        path: 'sellerId',
        select: 'accountId',
        populate: { path: 'accountId', select: 'fullName email' },
      });
    
    const apiUrl = process.env.API_URL || `${req.protocol}://${req.get('host')}`;

    // For each contract, get stats
    const contractsWithStats = await Promise.all(contracts.map(async (contract) => {
      const contractId = new mongoose.Types.ObjectId(contract._id);
      
      // Find all quotas for this contract
      const allQuotas = await Quota.find({
        contract: contractId,
        tenantId,
        companyId,
      }).sort({ type: 1, number: 1 });
      
      // Same numbers as the PDF, the portal and the messages
      const { quotas: _summaryQuotas, ...statement } = buildStatementSummary(contract, allQuotas, { apiUrl });
      const { initial, normal } = statement.breakdown;

      return {
        ...contract.toObject(),
        initialQuotaPercentage: contract.initialQuotaPercentage || (contract.totalValue > 0 ? (initial.total / contract.totalValue) * 100 : 0),
        totalPagado: statement.totalPaid,
        valorTotalInicial: initial.total,
        valorPagadoInicial: initial.paid,
        valorTotalCuotas: normal.total,
        valorPagadoCuotas: normal.paid,
        // Detailed counts
        cuotasInicialesPagadas: initial.paidCount,
        totalCuotasIniciales: initial.count,
        cuotasNormalesPagadas: normal.paidCount,
        totalCuotasNormales: contract.installmentsCount || normal.count,
        // Legacy compatibility
        cuotasPagadas: normal.paidCount,
        totalCuotas: contract.installmentsCount || normal.count || 0,
        valorCuota: contract.installmentValue || 0,
        diasMora: statement.daysOverdue,
        status: 'ACTIVO',
        statement,
        statementUrl: statement.statementUrl,
        quotas: allQuotas.map((q) => ({ ...q.toObject(), receiptUrl: publicLinkUrl('receipt', q._id, apiUrl) })),
      };
    }));

    res.json({
      success: true,
      data: {
        ...client.toObject(),
        contracts: contractsWithStats,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /clients - Manual creation
router.post('/', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_CREATE), async (req, res) => {
  try {
    const { tenantId, companyId, userId } = req.user;
    const { name, idNumber, phone, email, address, behavior, password } = req.body;

    if (!name || !idNumber) {
      return res.status(400).json({ success: false, message: 'Nombre y Cédula son obligatorios' });
    }

    // Check if client already exists in this company
    const existing = await Client.findOne({ idNumber, tenantId, companyId });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Ya existe un cliente con esta cédula' });
    }

    const client = await Client.create({
      name,
      idNumber,
      phone,
      email,
      address,
      behavior: behavior || 'INDECISO',
      tenantId,
      companyId,
      createdBy: userId,
    });

    // Automatically register client to the portal and send validation token
    try {
      const { registerPortalUserForClient } = await import('../utils/clientAuthHelper.js');
      await registerPortalUserForClient(client, tenantId, companyId, password);
    } catch (authHelperError) {
      console.error('Error executing registerPortalUserForClient:', authHelperError);
    }

    await logAudit(req, {
      action: 'CREATE_CLIENT',
      module: 'CLIENTS',
      targetId: client._id,
      details: { name, idNumber, portalAccess: !!(email && password) }
    });

    res.status(201).json({ success: true, data: client });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /clients/:id - Update client
router.put('/:id', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_CREATE), async (req, res) => {
  try {
    const { tenantId, companyId } = req.user;
    const { id } = req.params;
    const { name, idNumber, phone, email, address, behavior } = req.body;

    const client = await Client.findOneAndUpdate(
      { _id: id, tenantId, companyId },
      { name, idNumber, phone, email, address, behavior },
      { new: true, runValidators: true }
    );

    if (!client) {
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    await logAudit(req, {
      action: 'UPDATE_CLIENT',
      module: 'CLIENTS',
      targetId: client._id,
      details: { name, idNumber }
    });

    res.json({ success: true, data: client });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /clients/:id
router.delete('/:id', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_EXPORT), async (req, res) => {
  try {
    const { tenantId, companyId } = req.user;
    const { id } = req.params;

    const result = await Client.findOneAndDelete({ _id: id, tenantId, companyId });
    if (!result) {
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    await logAudit(req, {
      action: 'DELETE_CLIENT',
      module: 'CLIENTS',
      targetId: result._id,
      details: { name: result.name }
    });

    res.json({ success: true, message: 'Cliente eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Account statement: send it to the registered phone or email, copy its signed link, and its history
router.post('/statement/:contractId/send', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_CONTACT), sendClientStatement);
router.post('/statement/:contractId/link', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_DETAILS), shareClientStatementLink);
router.get('/:id/statement-deliveries', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_DETAILS), getClientStatementDeliveries);

// POST /clients/resend-plan/:contractId
router.post('/resend-plan/:contractId', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_DETAILS), async (req, res) => {
  try {
    const { tenantId, companyId } = req.user;
    const { contractId } = req.params;

    const contract = await Contract.findOne({ _id: contractId, tenantId, companyId });
    if (!contract) {
      return res.status(404).json({ success: false, message: 'Contrato no encontrado' });
    }

    const client = await Client.findOne({ _id: contract.client, tenantId, companyId });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    const quotas = await Quota.find({ contract: contractId, tenantId, companyId }).sort({ type: 1, number: 1 });

    const { sendPaymentPlanEmail } = await import('../utils/clientAuthHelper.js');
    await sendPaymentPlanEmail(client, quotas, contract, companyId);

    await logAudit(req, {
      action: 'RESEND_PAYMENT_PLAN',
      module: 'CLIENTS',
      targetId: contract._id,
      details: { clientId: client._id }
    });

    res.json({ success: true, message: 'Plan de pagos enviado exitosamente al correo del cliente' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /clients/resend-welcome/:clientId
router.post('/resend-welcome/:clientId', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_DETAILS), async (req, res) => {
  try {
    const { tenantId, companyId } = req.user;
    const { clientId } = req.params;

    const client = await Client.findOne({ _id: clientId, tenantId, companyId });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    const { resendWelcomeNotification } = await import('../utils/clientAuthHelper.js');
    await resendWelcomeNotification(client, tenantId, companyId);

    await logAudit(req, {
      action: 'RESEND_WELCOME_VALIDATION',
      module: 'CLIENTS',
      targetId: client._id,
      details: { name: client.name }
    });

    res.json({ success: true, message: 'Mensaje de bienvenida y validación de datos reenviado exitosamente' });
  } catch (error) {
    console.error('Error in resend-welcome:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
