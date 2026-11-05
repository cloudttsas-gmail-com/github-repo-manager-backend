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

const router = express.Router();

// All client routes require auth + tenant
router.use(protect);
router.use(tenantMiddleware);

// Company-scoped: GET /clients?companyId=xxx
router.get('/', companyMiddleware, checkPermission(PERMISSIONS.CLIENTES_VIEW), async (req, res) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy;
    const order = req.query.order;
    const behaviorFilter = req.query.behavior;
    const moraOnly = req.query.moraOnly === 'true';
    const alDiaOnly = req.query.alDiaOnly === 'true';

    // Dynamic sort
    let sortObj = { createdAt: -1 };
    if (sortBy) {
      sortObj = { [sortBy]: order === 'asc' ? 1 : -1 };
    }

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
          'contracts.paidQuotas': {
            $filter: { input: '$allQuotas', as: 'q', cond: { $eq: ['$$q.status', 'pagado'] } },
          },
          'contracts.moraQuotas': {
            $filter: { input: '$allQuotas', as: 'q', cond: { $eq: ['$$q.status', 'mora'] } },
          },
        },
      },
      {
        $addFields: {
          'contracts.totalPagadoQuotas': { $sum: '$contracts.paidQuotas.value' },
          'contracts.hasMora': { $gt: [{ $size: '$contracts.moraQuotas' }, 0] },
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
        },
      },
    ];

    if (moraOnly) {
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
      }).sort({ type: 1, number: 1 });
      
      const initialQuotas = allQuotas.filter((q) => q.type === 'inicial');
      const normalQuotas = allQuotas.filter((q) => q.type === 'normal');

      const paidInitial = initialQuotas.filter((q) => q.status === 'pagado');
      const paidNormal = normalQuotas.filter((q) => q.status === 'pagado');
      
      const totalPagadoFromQuotas = allQuotas
        .filter((q) => q.status === 'pagado')
        .reduce((sum, q) => sum + (q.value || 0), 0);

      // Use the larger of: paid quotas total OR RECAUDADO SIIGO total.
      // Since the import marks quotas as 'pagado' based on RECAUDADO SIIGO data,
      // these should be equivalent. We use Math.max to account for any SIIGO 
      // remainder that didn't fully cover a quota (partial payment case).
      const totalRecaudadoSiigo = (contract.recaudadoSiigo2024 || 0) + 
                                  (contract.recaudadoSiigo2025 || 0);
      const totalPagado = Math.max(totalPagadoFromQuotas, totalRecaudadoSiigo);

      // Value breakdown
      const valorTotalInicial = initialQuotas.reduce((sum, q) => sum + (q.value || 0), 0);
      const valorPagadoInicial = paidInitial.reduce((sum, q) => sum + (q.value || 0), 0);
      const valorTotalCuotas = normalQuotas.reduce((sum, q) => sum + (q.value || 0), 0);
      const valorPagadoCuotas = paidNormal.reduce((sum, q) => sum + (q.value || 0), 0);

      return {
        ...contract.toObject(),
        initialQuotaPercentage: contract.initialQuotaPercentage || (contract.totalValue > 0 ? (valorTotalInicial / contract.totalValue) * 100 : 0),
        totalPagado,
        valorTotalInicial,
        valorPagadoInicial,
        valorTotalCuotas,
        valorPagadoCuotas,
        // Detailed counts
        cuotasInicialesPagadas: paidInitial.length,
        totalCuotasIniciales: initialQuotas.length,
        cuotasNormalesPagadas: paidNormal.length,
        totalCuotasNormales: contract.installmentsCount || normalQuotas.length,
        // Legacy compatibility
        cuotasPagadas: paidNormal.length,
        totalCuotas: contract.installmentsCount || normalQuotas.length || 0,
        valorCuota: contract.installmentValue || 0,
        diasMora: 0, 
        status: 'ACTIVO',
        statementUrl: publicLinkUrl('statement', contract._id, apiUrl),
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
