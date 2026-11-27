import mongoose from 'mongoose';
import Contract from '../models/Contract.js';
import Lot from '../models/Lot.js';
import User from '../models/User.js';
import Company from '../models/Company.js';
import Quota from '../models/Quota.js';
import Client from '../models/Client.js';
import Commission from '../models/Commission.js';
import AppError from '../utils/AppError.js';
import { overdueByContract } from '../services/arrears.service.js';
import { startOfBogotaDay } from '../services/statementSummary.service.js';

/**
 * Helper to compute date ranges
 */
const getDateRange = (period, customStart, customEnd) => {
  const now = new Date();
  let startPeriod;
  let endPeriod;

  if (period === 'previous_month') {
    startPeriod = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endPeriod = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  } else if (period === 'last_quarter') {
    startPeriod = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    endPeriod = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (period === 'custom' && customStart && customEnd) {
    startPeriod = new Date(customStart);
    endPeriod = new Date(customEnd);
    endPeriod.setHours(23, 59, 59, 999);
  } else {
    // Current month default
    startPeriod = new Date(now.getFullYear(), now.getMonth(), 1);
    endPeriod = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  return { startPeriod, endPeriod };
};

/**
 * Generates a sales report including monthly sales, top 3 advisors,
 * reserved lots, and detailed status per stage.
 */
export const getSalesReport = async (req, res, next) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    const { period, startDate, endDate } = req.query;

    const { startPeriod, endPeriod } = getDateRange(period, startDate, endDate);

    const matchQuery = {
      tenantId: new mongoose.Types.ObjectId(tenantId),
      companyId: new mongoose.Types.ObjectId(companyId),
      contractDate: { $gte: startPeriod, $lte: endPeriod },
    };

    // If commercial role, only show personal sales
    if (role === 'vendedor' || role === 'ejecutivo_comercial' || role === 'agent') {
      matchQuery.sellerId = new mongoose.Types.ObjectId(userId);
    }

    // 1. Sales count & total value in the period
    const salesAggregate = await Contract.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalValue: { $sum: { $ifNull: ['$totalValue', 0] } },
        },
      },
    ]);

    const salesInPeriod = salesAggregate.length > 0 ? salesAggregate[0].count : 0;
    const totalValueInPeriod = salesAggregate.length > 0 ? salesAggregate[0].totalValue : 0;

    // 2. Top 3 Advisors with most sold stage and separated/apartados count
    // Seller roles only see themselves (personal report)
    const advisorMatch = {
      tenantId: new mongoose.Types.ObjectId(tenantId),
      companyId: new mongoose.Types.ObjectId(companyId),
      contractDate: { $gte: startPeriod, $lte: endPeriod },
    };
    if (matchQuery.sellerId) advisorMatch.sellerId = matchQuery.sellerId;

    const advisorSalesAgg = await Contract.aggregate([
      { $match: advisorMatch },
      {
        $lookup: {
          from: 'lots',
          localField: 'lot',
          foreignField: '_id',
          as: 'lotData',
        },
      },
      { $unwind: { path: '$lotData', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: {
            sellerId: '$sellerId',
            stage: '$lotData.stage',
          },
          salesCount: { $sum: 1 },
          totalSold: { $sum: { $ifNull: ['$totalValue', 0] } },
        },
      },
    ]);

    // Aggregate overall advisor sales
    const advisorMap = new Map();
    advisorSalesAgg.forEach((entry) => {
      const sellerIdStr = entry._id.sellerId ? entry._id.sellerId.toString() : 'sin_asesor';
      if (!advisorMap.has(sellerIdStr)) {
        advisorMap.set(sellerIdStr, {
          sellerId: entry._id.sellerId,
          salesCount: 0,
          totalSold: 0,
          stageCounts: {},
        });
      }
      const item = advisorMap.get(sellerIdStr);
      item.salesCount += entry.salesCount;
      item.totalSold += entry.totalSold;
      if (entry._id.stage) {
        item.stageCounts[entry._id.stage] = (item.stageCounts[entry._id.stage] || 0) + entry.salesCount;
      }
    });

    const advisorList = Array.from(advisorMap.values()).sort((a, b) => b.salesCount - a.salesCount);
    const top3AdvisorItems = advisorList.slice(0, 3);

    // Fetch user names & lots held in separated/apartado for each advisor
    const topAdvisors = await Promise.all(
      top3AdvisorItems.map(async (adv) => {
        let name = 'Sin asesor';
        if (adv.sellerId) {
          const user = await User.findById(adv.sellerId).populate('accountId');
          name = user?.accountId?.fullName || 'Asesor';
        }

        // Determine top stage
        let topStage = 'N/A';
        let maxStageCount = 0;
        Object.entries(adv.stageCounts).forEach(([st, cnt]) => {
          if (cnt > maxStageCount) {
            maxStageCount = cnt;
            topStage = st;
          }
        });

        // Lots currently in separado or apartado by this seller
        let separatedCount = 0;
        let apartadosCount = 0;
        if (adv.sellerId) {
          separatedCount = await Lot.countDocuments({ tenantId, companyId, sellerId: adv.sellerId, status: 'separado', isDeleted: { $ne: true } });
          apartadosCount = await Lot.countDocuments({ tenantId, companyId, sellerId: adv.sellerId, status: 'apartado', isDeleted: { $ne: true } });
        }

        return {
          id: adv.sellerId,
          name,
          salesCount: adv.salesCount,
          totalSold: adv.totalSold,
          topStage,
          separatedCount,
          apartadosCount,
        };
      })
    );

    // 3. Lot general stats: Disponibles, Separados, Apartados, Vendidos
    const lotCounts = {
      disponibles: await Lot.countDocuments({ tenantId, companyId, status: 'disponible', isDeleted: { $ne: true } }),
      separados: await Lot.countDocuments({ tenantId, companyId, status: 'separado', isDeleted: { $ne: true } }),
      apartados: await Lot.countDocuments({ tenantId, companyId, status: 'apartado', isDeleted: { $ne: true } }),
      vendidos: await Lot.countDocuments({ tenantId, companyId, status: 'vendido', isDeleted: { $ne: true } }),
    };

    // 4. Detailed lot stats by Stage
    const lotStats = await Lot.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          companyId: new mongoose.Types.ObjectId(companyId),
          isDeleted: { $ne: true },
        },
      },
      {
        $group: {
          _id: '$stage',
          total: { $sum: 1 },
          vendidos: { $sum: { $cond: [{ $eq: ['$status', 'vendido'] }, 1, 0] } },
          disponibles: { $sum: { $cond: [{ $eq: ['$status', 'disponible'] }, 1, 0] } },
          separados: { $sum: { $cond: [{ $eq: ['$status', 'separado'] }, 1, 0] } },
          apartados: { $sum: { $cond: [{ $eq: ['$status', 'apartado'] }, 1, 0] } },
        },
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
            $cond: [
              { $gt: ['$total', 0] },
              { $multiply: [{ $divide: ['$vendidos', '$total'] }, 100] },
              0,
            ],
          },
        },
      },
      { $sort: { stage: 1 } },
    ]);

    const company = await Company.findById(companyId).select('name');

    res.status(200).json({
      success: true,
      data: {
        period: period || 'current_month',
        from: startPeriod,
        to: endPeriod,
        salesInPeriod,
        totalValueInPeriod,
        topAdvisors,
        topAdvisor: topAdvisors.length > 0 ? topAdvisors[0] : null,
        lotCounts,
        separatedLots: lotCounts.separados,
        lotStats: lotStats.map((stat) => ({
          ...stat,
          projectName: company ? company.name : 'Proyecto',
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Projects expected revenue for the next N months based on pending quotas.
 */
export const getCashFlowProjection = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const { months = 6 } = req.query;

    const now = new Date();
    // Start from the beginning of the current month
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endProjection = new Date(now.getFullYear(), now.getMonth() + parseInt(months), 0, 23, 59, 59);

    const projection = await Quota.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          companyId: new mongoose.Types.ObjectId(companyId),
          status: { $in: ['pendiente', 'mora'] },
          dueDate: { $gte: startOfCurrentMonth, $lte: endProjection }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$dueDate' },
            month: { $month: '$dueDate' }
          },
          expectedAmount: { $sum: '$value' },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          year: '$_id.year',
          month: '$_id.month',
          expectedAmount: 1,
          count: 1
        }
      },
      { $sort: { year: 1, month: 1 } }
    ]);

    // Fill missing months with 0 to ensure the chart looks continuous
    const formattedProjection = [];
    for (let i = 0; i < parseInt(months); i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1; // JS months are 0-11, MongoDB 1-12

      const existingMonth = projection.find(p => p.year === year && p.month === month);
      
      formattedProjection.push({
        year,
        month,
        monthName: d.toLocaleString('es-ES', { month: 'short' }).toUpperCase(),
        label: `${d.toLocaleString('es-ES', { month: 'short' })} ${year.toString().slice(-2)}`,
        expectedAmount: existingMonth ? existingMonth.expectedAmount : 0,
        count: existingMonth ? existingMonth.count : 0
      });
    }

    res.status(200).json({
      success: true,
      data: formattedProjection
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Generates advanced reports: overdue portfolio by contract (1-30, 31-60, 61-90, +90 days),
 * monthly expected vs. actual collected, and top delinquent / best behavior clients.
 */
export const getAdvancedReports = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const now = new Date();
    const { startDate, endDate } = req.query;

    let startInterval = startDate ? new Date(startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
    let endInterval = endDate ? new Date(endDate) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    // ==========================================
    // 1. CARTERA POR EDADES & AL DIA
    // ==========================================
    const unpaidQuotas = await Quota.find({
      tenantId,
      companyId,
      status: { $in: ['pendiente', 'mora'] }
    });

    // Overdue by contract, with the same ranges and rule as Inicio and Cartera: each contract
    // falls in the range of its oldest overdue quota and carries all its overdue money
    const companyContractIds = (await Contract.find({ tenantId, companyId }).select('_id').lean()).map((c) => c._id);
    const overdue = await overdueByContract({ contract: { $in: companyContractIds } }, now);
    const rangeFigures = (key) => ({ amount: overdue.ranges[key].amount, count: overdue.ranges[key].contracts });
    const aging = {
      bucket30: rangeFigures('MORA_1_30'),
      bucket60: rangeFigures('MORA_31_60'),
      bucket90: rangeFigures('MORA_61_90'),
      bucketOver90: rangeFigures('MORA_90_PLUS'),
    };

    // Not yet due: the unpaid balance of quotas whose due date has not passed
    const today = startOfBogotaDay(now);
    const carteraAlDia = { amount: 0, count: 0 };
    unpaidQuotas.forEach((q) => {
      if (q.dueDate && q.dueDate >= today) {
        carteraAlDia.amount += q.value - (q.amountPaid || 0);
        carteraAlDia.count += 1;
      }
    });

    // ==========================================
    // 1B. RECAUDOS (All time, Today, Interval)
    // ==========================================
    const paidQuotasAllTime = await Quota.find({
      tenantId,
      companyId,
      status: 'pagado'
    });
    const totalCollected = paidQuotasAllTime.reduce((sum, q) => sum + (q.amountPaid || q.value), 0);

    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const paidQuotasToday = await Quota.find({
      tenantId,
      companyId,
      status: 'pagado',
      paymentDate: { $gte: startOfToday, $lte: endOfToday }
    });
    const collectedToday = paidQuotasToday.reduce((sum, q) => sum + (q.amountPaid || q.value), 0);

    const paidQuotasInterval = await Quota.find({
      tenantId,
      companyId,
      status: 'pagado',
      paymentDate: { $gte: startInterval, $lte: endInterval }
    });
    const collectedInterval = paidQuotasInterval.reduce((sum, q) => sum + (q.amountPaid || q.value), 0);

    const recaudos = {
      totalCollected,
      collectedToday,
      collectedInterval,
      startInterval,
      endInterval
    };

    // ==========================================
    // 1C. RECAUDOS POR MEDIO DE PAGO & PORCENTAJE DE NO PAGO (En el período)
    // ==========================================
    const bankBreakdownAgg = await Quota.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          companyId: new mongoose.Types.ObjectId(companyId),
          status: 'pagado',
          paymentDate: { $gte: startInterval, $lte: endInterval },
        },
      },
      {
        $group: {
          _id: { $ifNull: ['$paymentBank', 'Efectivo / No especificado'] },
          totalAmount: { $sum: { $ifNull: ['$amountPaid', '$value'] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    // Expected in period
    const expectedInPeriodQuotas = await Quota.find({
      tenantId,
      companyId,
      dueDate: { $gte: startInterval, $lte: endInterval },
    });
    const expectedInPeriod = expectedInPeriodQuotas.reduce((sum, q) => sum + q.value, 0);
    const nonPaymentRate = expectedInPeriod > 0
      ? Math.max(0, Math.round(((expectedInPeriod - collectedInterval) / expectedInPeriod) * 100))
      : 0;

    // ==========================================
    // 2. ESPERADO VS RECAUDADO POR MES (Expected vs. Real Revenue)
    // ==========================================
    // We look at the last 6 months
    const comparison = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);

      // Expected: quotas with dueDate in this month
      const expectedQuotas = await Quota.find({
        tenantId,
        companyId,
        dueDate: { $gte: startOfMonth, $lte: endOfMonth }
      });
      const expectedAmount = expectedQuotas.reduce((sum, q) => sum + q.value, 0);

      // Real: quotas with paymentDate in this month and status is 'pagado'
      const realQuotas = await Quota.find({
        tenantId,
        companyId,
        status: 'pagado',
        paymentDate: { $gte: startOfMonth, $lte: endOfMonth }
      });
      const realAmount = realQuotas.reduce((sum, q) => sum + (q.amountPaid || q.value), 0);

      comparison.push({
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        monthName: d.toLocaleString('es-ES', { month: 'short' }).replace('.', '').toUpperCase(),
        label: `${d.toLocaleString('es-ES', { month: 'short' }).replace('.', '').toUpperCase()} ${d.getFullYear()}`,
        expectedAmount,
        realAmount
      });
    }

    // ==========================================
    // 3. RANKING DE CLIENTES (Morosos vs. Cumplidos)
    // ==========================================
    // A. Clientes más morosos (Most Delinquent)
    const delinquentContractsAggregate = await Quota.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          companyId: new mongoose.Types.ObjectId(companyId),
          status: { $in: ['pendiente', 'mora'] },
          dueDate: { $lt: now }
        }
      },
      {
        $group: {
          _id: '$contract',
          lateAmount: { $sum: { $subtract: ['$value', { $ifNull: ['$amountPaid', 0] }] } },
          lateQuotasCount: { $sum: 1 }
        }
      },
      { $sort: { lateAmount: -1 } },
      { $limit: 10 }
    ]);

    const delinquentClients = [];
    for (const item of delinquentContractsAggregate) {
      const contract = await Contract.findById(item._id)
        .populate({ path: 'client', select: 'name idNumber phone email' })
        .populate({ path: 'lot', select: 'lotNumber stage manzana nomenclatura propertyType tower floor' });
      
      if (contract && contract.client) {
        delinquentClients.push({
          clientId: contract.client._id,
          clientName: contract.client.name,
          clientDocument: contract.client.idNumber,
          lotNumber: contract.lot ? contract.lot.lotNumber : 'N/A',
          lotStage: contract.lot ? contract.lot.stage : 'N/A',
          lateAmount: item.lateAmount,
          lateQuotasCount: item.lateQuotasCount
        });
      }
    }

    // B. Clientes con mejor comportamiento (Best paying clients)
    // We look at contracts that have paid quotas
    const behaviorContractsAggregate = await Quota.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          companyId: new mongoose.Types.ObjectId(companyId)
        }
      },
      {
        $group: {
          _id: '$contract',
          totalQuotasCount: { $sum: 1 },
          paidQuotasCount: { $sum: { $cond: [{ $eq: ['$status', 'pagado'] }, 1, 0] } },
          onTimePaidCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'pagado'] },
                    { $lte: ['$paymentDate', '$dueDate'] }
                  ]
                },
                1,
                0
              ]
            }
          },
          totalPaidAmount: { $sum: { $cond: [{ $eq: ['$status', 'pagado'] }, { $ifNull: ['$amountPaid', '$value'] }, 0] } }
        }
      },
      {
        $project: {
          totalQuotasCount: 1,
          paidQuotasCount: 1,
          onTimePaidCount: 1,
          totalPaidAmount: 1,
          onTimeRate: {
            $cond: [
              { $gt: ['$paidQuotasCount', 0] },
              { $multiply: [{ $divide: ['$onTimePaidCount', '$paidQuotasCount'] }, 100] },
              0
            ]
          }
        }
      },
      { $sort: { onTimeRate: -1, totalPaidAmount: -1 } },
      { $limit: 10 }
    ]);

    const bestClients = [];
    for (const item of behaviorContractsAggregate) {
      if (item.paidQuotasCount === 0) continue; // Skip contracts with no payments
      const contract = await Contract.findById(item._id)
        .populate({ path: 'client', select: 'name idNumber phone email' })
        .populate({ path: 'lot', select: 'lotNumber stage propertyType tower floor' });

      if (contract && contract.client) {
        bestClients.push({
          clientId: contract.client._id,
          clientName: contract.client.name,
          clientDocument: contract.client.idNumber,
          lotNumber: contract.lot ? contract.lot.lotNumber : 'N/A',
          lotStage: contract.lot ? contract.lot.stage : 'N/A',
          onTimeRate: item.onTimeRate,
          paidQuotasCount: item.paidQuotasCount,
          totalPaidAmount: item.totalPaidAmount
        });
      }
    }

    res.status(200).json({
      success: true,
      data: {
        aging,
        carteraAlDia,
        recaudos,
        expectedInPeriod,
        nonPaymentRate,
        bankBreakdown: bankBreakdownAgg.map((b) => ({
          bank: b._id,
          amount: b.totalAmount,
          count: b.count,
        })),
        comparison,
        delinquentClients,
        bestClients,
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Detailed Lots Report: All lots classified by 9 status categories
 */
export const getLotsReport = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;

    const lots = await Lot.find({ tenantId, companyId, isDeleted: { $ne: true } })
      .populate('sellerId', { path: 'accountId', select: 'fullName' })
      .populate('reservationBy', 'name idNumber')
      .sort({ stage: 1, manzana: 1, lotNumber: 1 });

    const contracts = await Contract.find({ tenantId, companyId })
      .populate('client', 'name idNumber phone')
      .populate('lot', 'nomenclature stage manzana lotNumber status')
      .populate({ path: 'sellerId', select: 'accountId', populate: { path: 'accountId', select: 'fullName' } });

    const contractMapByLotId = new Map();
    contracts.forEach((c) => {
      if (c.lot) contractMapByLotId.set(c.lot._id ? c.lot._id.toString() : c.lot.toString(), c);
    });

    // Real "pagado en su totalidad": all quotas of the contract are paid
    const contractIds = contracts.map((c) => c._id);
    const paidContractIds = new Set();
    if (contractIds.length > 0) {
      const quotas = await Quota.find({ contract: { $in: contractIds }, tenantId, companyId }).select('contract status');
      const quotaCountByContract = new Map();
      const paidCountByContract = new Map();
      quotas.forEach((q) => {
        const key = q.contract.toString();
        quotaCountByContract.set(key, (quotaCountByContract.get(key) || 0) + 1);
        if (q.status === 'pagado') paidCountByContract.set(key, (paidCountByContract.get(key) || 0) + 1);
      });
      quotaCountByContract.forEach((total, key) => {
        if (total > 0 && paidCountByContract.get(key) === total) paidContractIds.add(key);
      });
    }

    // Classify counts into the specific categories
    const summary = {
      total: lots.length,
      vendido: 0,
      disponible: 0,
      separado: 0,
      apartado: 0,
      pagadoTotalidad: 0,
      enEscrituracion: 0,
      conPazYSalvo: 0,
      enRequerimiento: 0,
      enNegociacion: 0,
    };

    const classifiedLots = lots.map((l) => {
      const contract = contractMapByLotId.get(l._id.toString());
      let stateCategory = l.status || 'disponible';

      if (contract) {
        const negotiation = (contract.negotiation || '').trim();
        if (contract.juridicalRequirement || contract.status === 'REQUERIMIENTO') {
          stateCategory = 'en_requerimiento';
        } else if (negotiation && negotiation !== 'Venta Directa') {
          stateCategory = 'en_negociacion';
        } else if (contract.status === 'ESCRITURACION') {
          stateCategory = 'en_escrituracion';
        } else if (contract.status === 'PAZ_Y_SALVO') {
          stateCategory = 'con_paz_y_salvo';
        } else if (contract.status === 'PAGADO_TOTAL' || contract.status === 'PAGADO') {
          stateCategory = 'pagado_totalidad';
        } else if (paidContractIds.has(contract._id.toString())) {
          stateCategory = 'pagado_totalidad';
        } else if (l.status === 'vendido') {
          stateCategory = 'vendido';
        }
      }

      if (stateCategory === 'vendido') summary.vendido += 1;
      else if (stateCategory === 'disponible') summary.disponible += 1;
      else if (stateCategory === 'separado') summary.separado += 1;
      else if (stateCategory === 'apartado') summary.apartado += 1;
      else if (stateCategory === 'pagado_totalidad') summary.pagadoTotalidad += 1;
      else if (stateCategory === 'en_escrituracion') summary.enEscrituracion += 1;
      else if (stateCategory === 'con_paz_y_salvo') summary.conPazYSalvo += 1;
      else if (stateCategory === 'en_requerimiento') summary.enRequerimiento += 1;
      else if (stateCategory === 'en_negociacion') summary.enNegociacion += 1;
      else summary.disponible += 1;

      const contractSellerName = contract?.sellerId?.accountId?.fullName;
      return {
        _id: l._id,
        nomenclature: l.nomenclature,
        stage: l.stage,
        manzana: l.manzana,
        lotNumber: l.lotNumber,
        area: l.area,
        price: l.price,
        status: l.status,
        stateCategory,
        client: contract?.client?.name || l.reservationBy?.name || 'N/A',
        seller: contractSellerName || contract?.commercial || l.sellerId?.accountId?.fullName || 'N/A',
      };
    });

    res.status(200).json({
      success: true,
      data: {
        summary,
        lots: classifiedLots,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Sales report per advisor: sales, amounts sold, and collection on those sales.
 * Supports optional from/to date range (default: current month).
 */
export const getAdvisorReport = async (req, res, next) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    const { from, to } = req.query;

    const now = new Date();
    const startPeriod = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
    let endPeriod = to ? new Date(to) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    if (Number.isNaN(startPeriod.getTime())) {
      return next(new AppError('Fecha inicial inválida', 400));
    }
    if (Number.isNaN(endPeriod.getTime())) {
      return next(new AppError('Fecha final inválida', 400));
    }
    if (endPeriod < startPeriod) {
      return next(new AppError('La fecha final no puede ser anterior a la inicial', 400));
    }
    // Include the whole "to" day
    endPeriod = new Date(endPeriod);
    endPeriod.setHours(23, 59, 59, 999);

    const contractMatch = {
      tenantId: new mongoose.Types.ObjectId(tenantId),
      companyId: new mongoose.Types.ObjectId(companyId),
      contractDate: { $gte: startPeriod, $lte: endPeriod },
    };
    // Seller roles only see their own rows (personal report)
    if (['ejecutivo_comercial', 'vendedor', 'agent'].includes(role)) {
      contractMatch.sellerId = new mongoose.Types.ObjectId(userId);
    }

    // 1. Sales per advisor in the period
    const contractAgg = await Contract.aggregate([
      {
        $match: contractMatch,
      },
      {
        $group: {
          _id: '$sellerId',
          ventas: { $sum: 1 },
          valorVendido: { $sum: { $ifNull: ['$totalValue', 0] } },
        },
      },
    ]);

    const sellerIds = contractAgg.map((c) => c._id).filter(Boolean);

    // 2. Collection per advisor over the same contracts (only payments within the period)
    const quotaAgg = await Quota.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          companyId: new mongoose.Types.ObjectId(companyId),
          paymentDate: { $gte: startPeriod, $lte: endPeriod },
        },
      },
      {
        $lookup: {
          from: 'contracts',
          localField: 'contract',
          foreignField: '_id',
          as: 'contractData',
        },
      },
      { $unwind: '$contractData' },
      { $match: { 'contractData.sellerId': { $in: sellerIds } } },
      {
        $group: {
          _id: '$contractData.sellerId',
          recaudo: {
            $sum: {
              $cond: [{ $eq: ['$status', 'pagado'] }, { $ifNull: ['$amountPaid', '$value'] }, 0],
            },
          },
          recaudoInicial: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$status', 'pagado'] }, { $eq: ['$type', 'inicial'] }] },
                { $ifNull: ['$amountPaid', '$value'] },
                0,
              ],
            },
          },
          valorInicialTotal: {
            $sum: { $cond: [{ $eq: ['$type', 'inicial'] }, '$value', 0] },
          },
        },
      },
    ]);

    const quotaBySeller = new Map(quotaAgg.map((q) => [q._id?.toString(), q]));

    // 2B. Commission progress per advisor (for the sales of the period)
    const contractIds = await Contract.distinct('_id', {
      tenantId,
      companyId,
      contractDate: { $gte: startPeriod, $lte: endPeriod },
    });
    const commissionAgg = await Commission.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          companyId: new mongoose.Types.ObjectId(companyId),
          contractId: { $in: contractIds },
        },
      },
      { $unwind: '$installments' },
      {
        $group: {
          _id: '$sellerId',
          comisionGenerada: { $sum: '$installments.amount' },
          comisionDisponible: {
            $sum: { $cond: [{ $eq: ['$installments.status', 'AVAILABLE'] }, '$installments.amount', 0] },
          },
          comisionRadicada: {
            $sum: { $cond: [{ $eq: ['$installments.status', 'FILED'] }, '$installments.amount', 0] },
          },
          comisionAprobada: {
            $sum: { $cond: [{ $eq: ['$installments.status', 'APPROVED'] }, '$installments.amount', 0] },
          },
          comisionPagada: {
            $sum: { $cond: [{ $eq: ['$installments.status', 'PAID'] }, '$installments.amount', 0] },
          },
        },
      },
    ]);
    const commissionBySeller = new Map(commissionAgg.map((c) => [c._id?.toString(), c]));

    // 3. Advisor names
    const advisorUsers = await User.find({ _id: { $in: sellerIds }, tenantId }).populate({
      path: 'accountId',
      select: 'fullName email',
    });
    const advisorMap = new Map(advisorUsers.map((u) => [u._id.toString(), u]));

    // 4. Build rows (contracts without sellerId appear as "Sin asesor")
    const advisors = contractAgg
      .map((item) => {
        const quota = quotaBySeller.get(item._id?.toString()) || {};
        const commission = commissionBySeller.get(item._id?.toString()) || {};
        const advisor = item._id ? advisorMap.get(item._id.toString()) : null;
        return {
          advisorId: item._id,
          name: advisor?.accountId?.fullName || 'Sin asesor',
          email: advisor?.accountId?.email || '',
          ventas: item.ventas,
          valorVendido: Math.round(item.valorVendido),
          recaudo: Math.round(quota.recaudo || 0),
          recaudoInicial: Math.round(quota.recaudoInicial || 0),
          valorInicialTotal: Math.round(quota.valorInicialTotal || 0),
          comisionGenerada: Math.round(commission.comisionGenerada || 0),
          comisionDisponible: Math.round(commission.comisionDisponible || 0),
          comisionRadicada: Math.round(commission.comisionRadicada || 0),
          comisionAprobada: Math.round(commission.comisionAprobada || 0),
          comisionPagada: Math.round(commission.comisionPagada || 0),
        };
      })
      .sort((a, b) => b.valorVendido - a.valorVendido);

    const totals = advisors.reduce(
      (acc, a) => {
        acc.ventas += a.ventas;
        acc.valorVendido += a.valorVendido;
        acc.recaudo += a.recaudo;
        acc.recaudoInicial += a.recaudoInicial;
        acc.valorInicialTotal += a.valorInicialTotal;
        acc.comisionGenerada += a.comisionGenerada;
        acc.comisionDisponible += a.comisionDisponible;
        acc.comisionRadicada += a.comisionRadicada;
        acc.comisionAprobada += a.comisionAprobada;
        acc.comisionPagada += a.comisionPagada;
        return acc;
      },
      { ventas: 0, valorVendido: 0, recaudo: 0, recaudoInicial: 0, valorInicialTotal: 0,
        comisionGenerada: 0, comisionDisponible: 0, comisionRadicada: 0, comisionAprobada: 0, comisionPagada: 0 }
    );

    res.status(200).json({
      success: true,
      data: {
        advisors,
        totals,
        from: startPeriod,
        to: endPeriod,
      },
    });
  } catch (error) {
    next(error);
  }
};
