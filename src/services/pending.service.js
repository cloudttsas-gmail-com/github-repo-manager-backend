import mongoose from 'mongoose';
import Commission from '../models/Commission.js';
import Contract from '../models/Contract.js';
import Conversation from '../models/Conversation.js';
import Lot from '../models/Lot.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import Quota from '../models/Quota.js';
import { hasPermission, PERMISSIONS } from '../config/permissions.js';
import { startOfBogotaDay } from './statementSummary.service.js';
import { openPromises, SELLER_ROLES, sellerClientIds } from './collectionActions.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RESERVATION_WARNING_DAYS = 3;
const toId = (value) => new mongoose.Types.ObjectId(String(value));

/** Contracts with at least one quota past due and unpaid (same rule as the statement) */
const overdueContracts = async ({ tenantId, companyId, contractIds }, now) => {
  const match = {
    tenantId: toId(tenantId),
    companyId: toId(companyId),
    status: { $ne: 'pagado' },
    dueDate: { $lt: startOfBogotaDay(now) },
  };
  if (contractIds) match.contract = { $in: contractIds.map(toId) };
  const [row] = await Quota.aggregate([
    { $match: match },
    { $addFields: { pending: { $subtract: [{ $ifNull: ['$value', 0] }, { $ifNull: ['$amountPaid', 0] }] } } },
    { $match: { pending: { $gt: 0 } } },
    { $group: { _id: null, amount: { $sum: '$pending' }, contracts: { $addToSet: '$contract' }, oldest: { $min: '$dueDate' } } },
  ]);
  return { count: row?.contracts?.length || 0, amount: row?.amount || 0, oldest: row?.oldest || null };
};

const commissionCount = async ({ companyId, status, sellerId }) => {
  const match = { companyId: toId(companyId), 'installments.status': status };
  if (sellerId) match.sellerId = toId(sellerId);
  const [row] = await Commission.aggregate([
    { $match: match },
    { $unwind: '$installments' },
    { $match: { 'installments.status': status } },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: { $ifNull: ['$installments.amount', 0] } }, oldest: { $min: '$updatedAt' } } },
  ]);
  return { count: row?.count || 0, amount: row?.amount || 0, oldest: row?.oldest || null };
};

/**
 * What waits for the person looking, by role: each item is a count (with an amount and the oldest
 * date when it helps) that the panel turns into a row with a link to the exact filter. Items the
 * role can't act on are left out; items at zero are kept, so the screen can say «al día».
 */
export const buildPendingItems = async ({ tenantId, companyId, role, userId }, now = new Date()) => {
  const can = (permission) => hasPermission(role, permission);
  const isSeller = SELLER_ROLES.includes(role);
  const items = [];
  const tasks = [];

  const sellerContracts = isSeller ? await Contract.find({ tenantId, companyId, sellerId: userId }).distinct('_id') : null;
  const sellerClients = isSeller ? await sellerClientIds({ tenantId, companyId, userId }) : null;

  if (can(PERMISSIONS.PAGOS_APPROVE) && !isSeller) {
    tasks.push((async () => {
      const filter = { tenantId: toId(tenantId), companyId: toId(companyId), status: 'PENDIENTE' };
      const [count, oldest] = await Promise.all([
        PaymentAttempt.countDocuments(filter),
        PaymentAttempt.findOne(filter).sort({ createdAt: 1 }).select('createdAt').lean(),
      ]);
      items.push({ key: 'payments_to_approve', count, oldest: oldest?.createdAt || null });
    })());
  }

  if (can(PERMISSIONS.CARTERA_FOLLOWUP)) {
    tasks.push((async () => {
      const { dueToday, broken } = await openPromises({ tenantId, companyId, clientIds: sellerClients }, now);
      const sum = (list) => list.reduce((total, action) => total + Math.max((action.promise.amount || 0) - (action.promisePaid || 0), 0), 0);
      items.push({ key: 'promises_due_today', count: dueToday.length, amount: sum(dueToday) });
      items.push({
        key: 'promises_broken',
        count: broken.length,
        amount: sum(broken),
        oldest: broken.reduce((min, action) => (!min || action.promise.dueDate < min ? action.promise.dueDate : min), null),
      });
    })());
  }

  if (can(PERMISSIONS.CARTERA_FOLLOWUP) && !isSeller) {
    tasks.push((async () => {
      // Chats from before projects had their own number have no companyId and show in every project
      const filter = { tenantId: String(tenantId), status: 'active', unreadCount: { $gt: 0 }, companyId: { $in: [toId(companyId), null] } };
      const [count, oldest] = await Promise.all([
        Conversation.countDocuments(filter),
        Conversation.findOne(filter).sort({ updatedAt: 1 }).select('updatedAt').lean(),
      ]);
      items.push({ key: 'unread_chats', count, oldest: oldest?.updatedAt || null });
    })());
  }

  if (can(PERMISSIONS.CARTERA_DASHBOARD) || isSeller) {
    tasks.push((async () => {
      const result = await overdueContracts({ tenantId, companyId, contractIds: sellerContracts }, now);
      items.push({ key: isSeller ? 'my_contracts_in_arrears' : 'contracts_in_arrears', ...result });
    })());
  }

  if (can(PERMISSIONS.CLIENTES_EDIT) && !isSeller) {
    tasks.push((async () => {
      const [row] = await Contract.aggregate([
        { $match: { tenantId: toId(tenantId), companyId: toId(companyId) } },
        { $lookup: { from: 'quotas', localField: '_id', foreignField: 'contract', as: 'quotas', pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }] } },
        { $match: { quotas: { $size: 0 } } },
        { $group: { _id: null, count: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
      ]);
      items.push({ key: 'contracts_without_plan', count: row?.count || 0, oldest: row?.oldest || null });
    })());
  }

  if (can(PERMISSIONS.LOTES_VIEW)) {
    tasks.push((async () => {
      const filter = {
        tenantId,
        companyId,
        isDeleted: { $ne: true },
        status: { $in: ['apartado', 'separado'] },
        expiresAt: { $lte: new Date(now.getTime() + RESERVATION_WARNING_DAYS * DAY_MS) },
      };
      if (isSeller) filter.sellerId = userId;
      const [count, oldest] = await Promise.all([
        Lot.countDocuments(filter),
        Lot.findOne(filter).sort({ expiresAt: 1 }).select('expiresAt').lean(),
      ]);
      items.push({ key: isSeller ? 'my_reservations_expiring' : 'reservations_expiring', count, oldest: oldest?.expiresAt || null });
    })());
  }

  if (can(PERMISSIONS.COMISIONES_RADICAR)) {
    tasks.push((async () => {
      const [available, rejected] = await Promise.all([
        commissionCount({ companyId, status: 'AVAILABLE', sellerId: userId }),
        commissionCount({ companyId, status: 'REJECTED', sellerId: userId }),
      ]);
      items.push({ key: 'commissions_to_file', ...available });
      items.push({ key: 'commissions_rejected', ...rejected });
    })());
  }

  if (can(PERMISSIONS.COMISIONES_APPROVE)) {
    tasks.push(commissionCount({ companyId, status: 'FILED' }).then((result) => items.push({ key: 'commissions_to_approve', ...result })));
  }

  if (can(PERMISSIONS.COMISIONES_PAY)) {
    tasks.push(commissionCount({ companyId, status: 'APPROVED' }).then((result) => items.push({ key: 'commissions_to_pay', ...result })));
  }

  await Promise.all(tasks);
  return items;
};
