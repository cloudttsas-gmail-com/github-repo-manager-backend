import mongoose from 'mongoose';
import CollectionAction from '../models/CollectionAction.js';
import Contract from '../models/Contract.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import { bogotaDay, startOfBogotaDay } from './statementSummary.service.js';

export const SELLER_ROLES = ['vendedor', 'ejecutivo_comercial', 'agent'];

const toId = (value) => new mongoose.Types.ObjectId(String(value));
// Works whether `clientId` was populated or not
const clientOf = (action) => String(action.clientId?._id || action.clientId);
const endOfBogotaDay = (date) => new Date(`${bogotaDay(date)}T23:59:59.999-05:00`);

/** The clients a seller works with: the ones of their sales */
export const sellerClientIds = async ({ tenantId, companyId, userId }) =>
  Contract.find({ tenantId, companyId, sellerId: userId }).distinct('client');

/**
 * A promise is kept when the approved payments of that client (and contract, if it names one), paid
 * between the day of the action and the promised date, add up to the promised amount. Otherwise it
 * is pending until that date and broken after it.
 */
export const promiseState = (action, paidAmount, now = new Date()) => {
  if (!action.promise?.dueDate) return null;
  if (paidAmount >= (action.promise.amount || 0)) return 'cumplida';
  return startOfBogotaDay(now) > endOfBogotaDay(action.promise.dueDate) ? 'incumplida' : 'vigente';
};

/** Adds `promiseState` and `promisePaid` to each action that carries a promise */
export const withPromiseStates = async (actions, { tenantId, companyId }, now = new Date()) => {
  const promised = actions.filter((action) => action.promise?.dueDate);
  if (!promised.length) return actions.map((action) => ({ ...action, promiseState: null, promisePaid: 0 }));

  const earliest = promised.reduce((min, action) => (action.createdAt < min ? action.createdAt : min), promised[0].createdAt);
  const payments = await PaymentAttempt.find({
    tenantId: toId(tenantId),
    companyId: toId(companyId),
    status: 'APROBADO',
    clientId: { $in: [...new Set(promised.map(clientOf))].map(toId) },
    fechaPago: { $gte: startOfBogotaDay(earliest) },
  }).select('clientId contractId amount fechaPago').lean();

  return actions.map((action) => {
    if (!action.promise?.dueDate) return { ...action, promiseState: null, promisePaid: 0 };
    const from = startOfBogotaDay(action.createdAt);
    const to = endOfBogotaDay(action.promise.dueDate);
    const paid = payments
      .filter((payment) => String(payment.clientId) === clientOf(action))
      .filter((payment) => !action.contractId || String(payment.contractId) === String(action.contractId))
      .filter((payment) => payment.fechaPago >= from && payment.fechaPago <= to)
      .reduce((sum, payment) => sum + (payment.amount || 0), 0);
    return { ...action, promisePaid: paid, promiseState: promiseState(action, paid, now) };
  });
};

/**
 * Open promises (not yet kept) whose date is today or already passed, for the Pendientes counts.
 * Looks back 60 days of promised dates.
 */
export const openPromises = async ({ tenantId, companyId, clientIds }, now = new Date()) => {
  const filter = {
    tenantId,
    companyId,
    'promise.dueDate': { $gte: new Date(startOfBogotaDay(now).getTime() - 60 * 24 * 60 * 60 * 1000), $lte: endOfBogotaDay(now) },
  };
  if (clientIds) filter.clientId = { $in: clientIds };
  const actions = await CollectionAction.find(filter).lean();
  const states = await withPromiseStates(actions, { tenantId, companyId }, now);
  const today = bogotaDay(now);
  const dueToday = states.filter((action) => action.promiseState === 'vigente' && bogotaDay(action.promise.dueDate) === today);
  const broken = states.filter((action) => action.promiseState === 'incumplida');
  return { dueToday, broken };
};
