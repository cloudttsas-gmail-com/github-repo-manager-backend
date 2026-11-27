import express from 'express';
import Contract from '../models/Contract.js';
import User from '../models/User.js';
import Lot from '../models/Lot.js';
import Quota from '../models/Quota.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import Escalation from '../models/Escalation.js';
import Message from '../models/Message.js';
import CallLog from '../models/CallLog.js';
import { overdueByContract } from '../services/arrears.service.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';
import mongoose from 'mongoose';
import { buildPendingItems } from '../services/pending.service.js';

const router = express.Router();

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
    const overdue = await overdueByContract({ contract: { $in: contractIds } }, now);
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

    // 2. Lot Statistics: the project's inventory for everyone (a seller sells from all of it),
    // so the figures and the table by stage count the same lots
    const lotMatch = { tenantId, companyId, isDeleted: { $ne: true } };
    const reservedLots = await Lot.countDocuments({ ...lotMatch, status: 'apartado' });
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
          apartados: { $sum: { $cond: [{ $eq: ['$status', 'apartado'] }, 1, 0] } },
        }
      },
      {
        $project: {
          stage: '$_id',
          total: 1,
          vendidos: 1,
          disponibles: 1,
          separados: 1,
          apartados: 1,
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
          contratosMora1a30: overdue.ranges.MORA_1_30.contracts,
          contratosMora31a60: overdue.ranges.MORA_31_60.contracts,
          contratosMora61a90: overdue.ranges.MORA_61_90.contracts,
          contratosMora90plus: overdue.ranges.MORA_90_PLUS.contracts,
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
          reserved: reservedLots,
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

/**
 * GET /api/dashboard/pending?companyId=
 * What waits for the person looking, by role (Inicio › Pendientes and the menu counters).
 */
router.get('/pending', companyMiddleware, async (req, res, next) => {
  try {
    const items = await buildPendingItems(req.user);
    res.json({ success: true, data: { items, generatedAt: new Date() } });
  } catch (error) {
    next(error);
  }
});

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

export default router;
