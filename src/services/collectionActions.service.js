import mongoose from 'mongoose';
import Client from '../models/Client.js';
import CollectionAction from '../models/CollectionAction.js';
import Contract from '../models/Contract.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import { isAppliedToQuotas } from './paymentApplication.service.js';
import { bogotaDay, startOfBogotaDay } from './statementSummary.service.js';

export const SELLER_ROLES = ['vendedor', 'ejecutivo_comercial', 'agent'];
/** Pendientes looks at broken promises this far back, and so does their list */
export const BROKEN_WINDOW_DAYS = 60;
/** The furthest a promise can be set */
export const MAX_PROMISE_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;
const toId = (value) => new mongoose.Types.ObjectId(String(value));
// Works whether `clientId` was populated or not
const clientOf = (action) => String(action.clientId?._id || action.clientId);
export const endOfBogotaDay = (date) => new Date(`${bogotaDay(date)}T23:59:59.999-05:00`);

/** The clients a seller works with: the ones of their sales and the ones they created (as in the list) */
export const sellerClientIds = async ({ tenantId, companyId, userId }) => {
  const [sold, created] = await Promise.all([
    Contract.find({ tenantId, companyId, sellerId: userId }).distinct('client'),
    Client.find({ tenantId, companyId, createdBy: userId }).distinct('_id'),
  ]);
  return [...new Map([...sold, ...created].map((id) => [String(id), id])).values()];
};

/**
 * Adds `promiseState` and `promisePaid` to each action. For each client, promises are taken by their
 * promised date (the nearest first, then the oldest) and use up the approved payments reported after the
 * action and paid by that date, so one payment never keeps two promises and a renegotiated, nearer one
 * is kept first. States:
 * - cumplida: those payments reach the amount;
 * - en_revision: not reached yet, but a payment reported in the window waits for approval;
 * - vigente: not reached and the date hasn't passed;
 * - incumplida: the date passed without it;
 * - reemplazada: broken, but afterwards the client agreed a newer promise on the same contract (or one of
 *   the two names no contract).
 * `allActions` (optional) are every promise of those clients, so allocation and replacement look at
 * the whole history even when `actions` is one page.
 */
export const withPromiseStates = async (actions, { tenantId, companyId }, now = new Date(), allActions = null) => {
  const promised = (allActions || actions).filter((action) => action.promise?.dueDate);
  if (!promised.length) return actions.map((action) => ({ ...action, promiseState: null, promisePaid: 0 }));

  const earliest = promised.reduce((min, action) => (action.createdAt < min ? action.createdAt : min), promised[0].createdAt);
  const latestDue = promised.reduce((max, action) => (action.promise.dueDate > max ? action.promise.dueDate : max), promised[0].promise.dueDate);
  const payments = await PaymentAttempt.find({
    tenantId: toId(tenantId),
    companyId: toId(companyId),
    status: { $in: ['APROBADO', 'PENDIENTE'] },
    clientId: { $in: [...new Set(promised.map(clientOf))].map(toId) },
    createdAt: { $gte: earliest },
    fechaPago: { $lte: endOfBogotaDay(latestDue) },
  }).select('clientId contractId amount fechaPago createdAt status appliedToQuotas quotaValue').sort({ fechaPago: 1, createdAt: 1 }).lean();

  // Approved money left to allocate, per payment
  const left = new Map(payments.filter((p) => p.status === 'APROBADO').map((p) => [String(p._id), p.amount || 0]));
  const today = startOfBogotaDay(now);
  const states = new Map();

  const byClient = new Map();
  promised.forEach((action) => byClient.set(clientOf(action), [...(byClient.get(clientOf(action)) || []), action]));
  for (const [client, list] of byClient) {
    list.sort((a, b) => new Date(a.promise.dueDate) - new Date(b.promise.dueDate) || a.createdAt - b.createdAt);
    const sameContract = (a, b) => !a.contractId || !b.contractId || String(a.contractId) === String(b.contractId);
    list.forEach((action) => {
      const amount = action.promise.amount || 0;
      const due = endOfBogotaDay(action.promise.dueDate);
      const fits = (payment) => String(payment.clientId) === client
        && (!action.contractId || String(payment.contractId) === String(action.contractId))
        && payment.createdAt >= action.createdAt
        && payment.fechaPago <= due;
      let paid = 0;
      for (const payment of payments) {
        if (paid >= amount) break;
        if (payment.status !== 'APROBADO' || !fits(payment)) continue;
        const available = left.get(String(payment._id)) || 0;
        const take = Math.min(available, amount - paid);
        if (take <= 0) continue;
        left.set(String(payment._id), available - take);
        paid += take;
      }
      // Reported in the window and waiting for approval (legacy rows already on the quotas don't count)
      const inReview = payments.some((payment) => payment.status === 'PENDIENTE' && !isAppliedToQuotas(payment) && fits(payment));
      let state;
      if (paid >= amount) state = 'cumplida';
      else if (inReview) state = 'en_revision';
      else if (today > due) state = list.some((other) => other !== action && other.createdAt > action.createdAt && sameContract(other, action)) ? 'reemplazada' : 'incumplida';
      else state = 'vigente';
      states.set(String(action._id), { promiseState: state, promisePaid: paid });
    });
  }

  return actions.map((action) => ({ ...action, ...(states.get(String(action._id)) || { promiseState: null, promisePaid: 0 }) }));
};

/**
 * Promises for the Pendientes counts: open ones due today and broken ones in the last
 * BROKEN_WINDOW_DAYS days (the same window as their list).
 */
export const openPromises = async ({ tenantId, companyId, clientIds }, now = new Date()) => {
  const filter = { tenantId, companyId, 'promise.dueDate': { $exists: true } };
  if (clientIds) filter.clientId = { $in: clientIds };
  const actions = await CollectionAction.find({
    ...filter,
    'promise.dueDate': { $gte: new Date(startOfBogotaDay(now).getTime() - BROKEN_WINDOW_DAYS * DAY_MS) },
  }).lean();
  if (!actions.length) return { dueToday: [], broken: [] };
  // The whole promise history of those clients decides allocation and replacement
  const history = await CollectionAction.find({ ...filter, clientId: { $in: [...new Set(actions.map(clientOf))].map(toId) } }).lean();
  const states = await withPromiseStates(actions, { tenantId, companyId }, now, history);
  const today = bogotaDay(now);
  return {
    dueToday: states.filter((action) => action.promiseState === 'vigente' && bogotaDay(action.promise.dueDate) === today),
    broken: states.filter((action) => action.promiseState === 'incumplida'),
  };
};
