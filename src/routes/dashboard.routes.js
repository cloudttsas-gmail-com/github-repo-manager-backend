import express from 'express';
import Contract from '../models/Contract.js';
import User from '../models/User.js';
import Lot from '../models/Lot.js';
import Quota from '../models/Quota.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import Escalation from '../models/Escalation.js';
import Message from '../models/Message.js';
import CallLog from '../models/CallLog.js';
import { startOfBogotaDay } from '../services/statementSummary.service.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';
import mongoose from 'mongoose';

const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** Start of the Bogotá month `offset` months away from the one `now` falls in. */
const startOfBogotaMonth = (now = new Date(), offset = 0) => {
  const [year, month] = now.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }).split('-').map(Number);
  const index = year * 12 + (month - 1) + offset;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { start: new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00-05:00`), monthIndex: m - 1 };
};

/** The contracts a dashboard reads: the company's, or only the seller's own. */
const dashboardContractIds = async (baseMatch) => (await Contract.find(baseMatch).select('_id').lean()).map((c) => c._id);

/** Money collected (approved payments) between two dates, by payment date. */
const collectedBetween = async (contractIds, from, to) => {
  const [row] = await PaymentAttempt.aggregate([
    { $match: { contractId: { $in: contractIds }, status: 'APROBADO', fechaPago: { $gte: from, $lt: to } } },
    { $group: { _id: null, total: { $sum: { $subtract: [{ $ifNull: ['$amount', 0] }, { $ifNull: ['$unappliedAmount', 0] }] } } } },
  ]);
  return row?.total || 0;
};

/**
 * Overdue figures by contract, with the statement's rule (a quota is overdue from the
 * day after its due date, in Bogotá). Each contract falls in the bucket of its oldest
 * overdue quota.
 */
const overdueByContract = async (contractIds, now = new Date()) => {
  const today = startOfBogotaDay(now);
  const rows = await Quota.aggregate([
    { $match: { contract: { $in: contractIds }, status: { $ne: 'pagado' }, dueDate: { $lt: today } } },
    { $addFields: { pending: { $subtract: [{ $ifNull: ['$value', 0] }, { $ifNull: ['$amountPaid', 0] }] } } },
    { $match: { pending: { $gt: 0 } } },
    { $group: { _id: '$contract', oldestDue: { $min: '$dueDate' }, amount: { $sum: '$pending' } } },
  ]);
  const buckets = { mora1a15: 0, mora16a30: 0, mora31a60: 0, mora60plus: 0 };
  let amount = 0;
  for (const row of rows) {
    amount += row.amount;
    const days = Math.max(1, Math.ceil((today - new Date(row.oldestDue)) / DAY_MS));
    if (days <= 15) buckets.mora1a15 += 1;
    else if (days <= 30) buckets.mora16a30 += 1;
    else if (days <= 60) buckets.mora31a60 += 1;
    else buckets.mora60plus += 1;
  }
  return { contracts: rows.length, amount, ...buckets };
};

router.use(protect);
router.use(tenantMiddleware);

// Dashboard summary — company-scoped
router.get('/summary', companyMiddleware, checkPermission(PERMISSIONS.CARTERA_DASHBOARD), async (req, res) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;

    const baseMatch = { tenantId, companyId };
    if (role === 'vendedor' || role === 'ejecutivo_comercial' || role === 'agent') {
      baseMatch.sellerId = userId;
    }

    const now = new Date();
    const startOfMonth = startOfBogotaMonth(now).start;
    const endOfMonth = new Date(startOfBogotaMonth(now, 1).start.getTime() - 1);

    // 1. Top Advisor of the month
    const topAdvisorAggregate = await Contract.aggregate([
      { 
        $match: { 
          tenantId: new mongoose.Types.ObjectId(tenantId), 
          companyId: new mongoose.Types.ObjectId(companyId),
          contractDate: { $gte: startOfMonth, $lte: endOfMonth }
        } 
      },
      { $group: { _id: '$sellerId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ]);

    let topAdvisor = null;
    if (topAdvisorAggregate.length > 0 && topAdvisorAggregate[0]._id) {
      const advisorUser = await User.findById(topAdvisorAggregate[0]._id)
        .populate({
          path: 'accountId',
          select: 'fullName'
        });
      
      if (advisorUser) {
        topAdvisor = {
          id: advisorUser._id,
          name: advisorUser.accountId?.fullName || 'N/A',
          count: topAdvisorAggregate[0].count
        };
      }
    }

    const totalClientsCount = await Contract.distinct('client', baseMatch).then((clients) => clients.length);

    // Calculate Portfolio / Project Stats
    const stats = await Contract.aggregate([
      { $match: baseMatch },
      {
        $lookup: {
          from: 'quotas',
          localField: '_id',
          foreignField: 'contract',
          as: 'quotas',
        },
      },
      {
        $addFields: {
          paidInQuotas: {
            $sum: {
              $map: {
                input: '$quotas',
                as: 'pq',
                // Partial payments count too; a paid quota without amountPaid counts its value
                in: {
                  $cond: [
                    { $and: [{ $eq: ['$$pq.status', 'pagado'] }, { $lte: [{ $ifNull: ['$$pq.amountPaid', 0] }, 0] }] },
                    { $ifNull: ['$$pq.value', 0] },
                    { $ifNull: ['$$pq.amountPaid', 0] },
                  ],
                },
              },
            },
          },
          siigoTotal: { $add: ['$recaudadoSiigo2024', '$recaudadoSiigo2025'] },
        },
      },
      {
        $addFields: {
          realPaid: '$paidInQuotas',
        },
      },
      {
        $group: {
          _id: null,
          valorTotalCartera: { $sum: '$totalValue' },
          totalRecaudado: { $sum: '$realPaid' },
        },
      },
    ]);

    const result = stats[0] || { valorTotalCartera: 0, totalRecaudado: 0 };
    const totalPendiente = Math.max(0, result.valorTotalCartera - result.totalRecaudado);
    const porcentajeRecaudo = result.valorTotalCartera > 0 
      ? Math.round((result.totalRecaudado / result.valorTotalCartera) * 100) 
      : 0;

    const totalSalesCount = await Contract.countDocuments(baseMatch);
    const teamMembersCount = await User.countDocuments({ tenantId, status: 'active' });

    // Sales this month (scoped to the seller's own contracts for seller roles)
    const isSellerRole = role === 'vendedor' || role === 'ejecutivo_comercial' || role === 'agent';
    const salesThisMonthAgg = await Contract.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          companyId: new mongoose.Types.ObjectId(companyId),
          contractDate: { $gte: startOfMonth, $lte: endOfMonth },
          ...(isSellerRole ? { sellerId: new mongoose.Types.ObjectId(userId) } : {}),
        },
      },
      {
        $group: {
          _id: null,
          ventas: { $sum: 1 },
          valorVendido: { $sum: { $ifNull: ['$totalValue', 0] } },
        },
      },
    ]);
    const salesThisMonth = salesThisMonthAgg[0] || { ventas: 0, valorVendido: 0 };

    // Overdue, collected this month and operation figures
    const contractIds = await dashboardContractIds(baseMatch);
    const overdue = await overdueByContract(contractIds, now);
    const previousMonthStart = startOfBogotaMonth(now, -1).start;
    const [mesActual, mesAnterior] = await Promise.all([
      collectedBetween(contractIds, startOfMonth, new Date(endOfMonth.getTime() + 1)),
      collectedBetween(contractIds, previousMonthStart, startOfMonth),
    ]);
    const companyScope = { tenantId, companyId };
    const [comprobantesPendientes, clientesEscalados, whatsappEnviadosMes, llamadasAIMes] = await Promise.all([
      PaymentAttempt.countDocuments({ contractId: { $in: contractIds }, status: 'PENDIENTE' }),
      Escalation.countDocuments({ ...companyScope, estado: { $ne: 'resuelto' } }),
      // WhatsApp is still one number per tenant (Message has no company)
      Message.countDocuments({ tenantId, direction: 'outbound', createdAt: { $gte: startOfMonth } }),
      CallLog.countDocuments({ ...companyScope, createdAt: { $gte: startOfMonth } }),
    ]);

    // 2. Lot Statistics
    const lotMatch = { ...baseMatch, isDeleted: { $ne: true } };
    const separatedLots = await Lot.countDocuments({ ...lotMatch, status: 'separado' });
    const soldLots = await Lot.countDocuments({ ...lotMatch, status: 'vendido' });
    const availableLots = await Lot.countDocuments({ ...lotMatch, status: 'disponible' });

    const lotStatsByStage = await Lot.aggregate([
      { 
        $match: { 
          tenantId: new mongoose.Types.ObjectId(tenantId), 
          companyId: new mongoose.Types.ObjectId(companyId),
          isDeleted: { $ne: true }
        } 
      },
      {
        $group: {
          _id: '$stage',
          total: { $sum: 1 },
          vendidos: { $sum: { $cond: [{ $eq: ['$status', 'vendido'] }, 1, 0] } },
          disponibles: { $sum: { $cond: [{ $eq: ['$status', 'disponible'] }, 1, 0] } },
          separados: { $sum: { $cond: [{ $eq: ['$status', 'separado'] }, 1, 0] } },
        }
      },
      {
        $project: {
          stage: '$_id',
          total: 1,
          vendidos: 1,
          disponibles: 1,
          separados: 1,
          porcentajeVendido: {
            $round: [{
              $cond: [
                { $gt: ['$total', 0] },
                { $multiply: [{ $divide: ['$vendidos', '$total'] }, 100] },
                0
              ]
            }, 0]
          }
        }
      },
      { $sort: { stage: 1 } }
    ]);

    res.json({
      success: true,
      data: {
        totalClients: totalClientsCount,
        totalSales: totalSalesCount,
        teamMembers: teamMembersCount,
        isSeller: isSellerRole,
        salesThisMonth: {
          count: salesThisMonth.ventas,
          valorVendido: Math.round(salesThisMonth.valorVendido),
        },
        cartera: {
          valorTotalCartera: Math.round(result.valorTotalCartera),
          totalRecaudado: Math.round(result.totalRecaudado),
          totalPendiente: Math.round(totalPendiente),
          porcentajeRecaudo,
        },
        mora: {
          totalContratosActivos: totalSalesCount,
          contratosAlDia: Math.max(0, totalSalesCount - overdue.contracts),
          contratosMora1a15: overdue.mora1a15,
          contratosMora16a30: overdue.mora16a30,
          contratosMora31a60: overdue.mora31a60,
          contratosMora60plus: overdue.mora60plus,
          porcentajeMora: totalSalesCount > 0 ? Math.round((overdue.contracts / totalSalesCount) * 1000) / 10 : 0,
          dineroEnMora: Math.round(overdue.amount),
        },
        recaudoMensual: {
          mesActual: Math.round(mesActual),
          mesAnterior: Math.round(mesAnterior),
          // null when nothing came in last month: there is nothing to compare with
          variacion: mesAnterior > 0 ? Math.round(((mesActual - mesAnterior) / mesAnterior) * 1000) / 10 : null,
        },
        operacion: {
          comprobantesPendientes,
          clientesEscalados,
          whatsappEnviadosMes,
          llamadasAIMes,
        },
        topAdvisor,
        lotStats: {
          separated: separatedLots,
          sold: soldLots,
          available: availableLots,
          byStage: lotStatsByStage
        }
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/ranking-morosos', (req, res) => res.json({ success: true, data: [] }));
// Collected per month (approved payments) against what fell due that month, last 6 months
router.get('/recaudo-mensual', companyMiddleware, checkPermission(PERMISSIONS.CARTERA_DASHBOARD), async (req, res) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    const baseMatch = { tenantId, companyId };
    if (role === 'vendedor' || role === 'ejecutivo_comercial' || role === 'agent') {
      baseMatch.sellerId = userId;
    }
    const contractIds = await dashboardContractIds(baseMatch);
    const now = new Date();
    const data = [];
    for (let offset = -5; offset <= 0; offset += 1) {
      const { start, monthIndex } = startOfBogotaMonth(now, offset);
      const end = startOfBogotaMonth(now, offset + 1).start;
      const [recaudado, [due]] = await Promise.all([
        collectedBetween(contractIds, start, end),
        Quota.aggregate([
          { $match: { contract: { $in: contractIds }, dueDate: { $gte: start, $lt: end } } },
          { $group: { _id: null, total: { $sum: { $ifNull: ['$value', 0] } } } },
        ]),
      ]);
      data.push({ mes: MONTH_NAMES[monthIndex], recaudado: Math.round(recaudado), meta: Math.round(due?.total || 0) });
    }
    res.json({ success: true, data: { data } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.get('/comportamiento', (req, res) => res.json({ success: true, data: [] }));

export default router;
