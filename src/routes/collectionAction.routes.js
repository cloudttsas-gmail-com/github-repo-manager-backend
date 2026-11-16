import express from 'express';
import mongoose from 'mongoose';
import Client from '../models/Client.js';
import Contract from '../models/Contract.js';
import CollectionAction, { ACTION_CHANNELS, ACTION_RESULTS } from '../models/CollectionAction.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';
import { PERMISSIONS } from '../config/permissions.js';
import { parseBusinessDate } from '../utils/dates.js';
import { BROKEN_WINDOW_DAYS, MAX_PROMISE_DAYS, SELLER_ROLES, endOfBogotaDay, sellerClientIds, withPromiseStates } from '../services/collectionActions.service.js';
import { startOfBogotaDay } from '../services/statementSummary.service.js';

const router = express.Router();

router.use(protect);
router.use(tenantMiddleware);

const PROMISE_STATES = ['vigente', 'en_revision', 'cumplida', 'incumplida', 'reemplazada'];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GET /api/collection-actions?companyId=&clientId=&promise=<state>&due=today&page=&limit=
 * The project's collection actions, newest first, each promise with its state (see withPromiseStates).
 * Sellers only see the actions on their clients. With `promise`, only promises in that state (broken
 * and replaced ones from the last BROKEN_WINDOW_DAYS days, as Pendientes counts them); `due=today`,
 * the open ones due today.
 */
router.get('/', companyMiddleware, checkPermission(PERMISSIONS.CARTERA_FOLLOWUP), async (req, res, next) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const filter = { tenantId, companyId };

    if (req.query.clientId) {
      if (!mongoose.isValidObjectId(req.query.clientId)) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
      filter.clientId = req.query.clientId;
    }
    if (SELLER_ROLES.includes(role)) {
      const own = (await sellerClientIds({ tenantId, companyId, userId })).map(String);
      filter.clientId = filter.clientId ? (own.includes(String(filter.clientId)) ? filter.clientId : { $in: [] }) : { $in: own };
    }

    const promise = PROMISE_STATES.includes(req.query.promise) ? req.query.promise : null;
    const dueToday = req.query.due === 'today';
    const today = startOfBogotaDay();
    if (promise || dueToday) {
      // Narrow by date in the query; the state itself comes from the payments
      const due = { $exists: true };
      if (dueToday) Object.assign(due, { $gte: today, $lte: endOfBogotaDay(today) });
      else if (promise === 'vigente' || promise === 'en_revision') due.$gte = new Date(today.getTime() - BROKEN_WINDOW_DAYS * DAY_MS);
      else if (promise === 'incumplida' || promise === 'reemplazada') Object.assign(due, { $lt: today, $gte: new Date(today.getTime() - BROKEN_WINDOW_DAYS * DAY_MS) });
      filter['promise.dueDate'] = due;
    }

    const query = CollectionAction.find(filter)
      .sort(promise || dueToday ? { 'promise.dueDate': promise === 'incumplida' || promise === 'cumplida' ? -1 : 1, createdAt: -1 } : { createdAt: -1 })
      .populate('clientId', 'name idNumber phone')
      .lean();

    let rows;
    let total;
    if (promise || dueToday) {
      const found = await query.limit(1000);
      // Every promise of those clients decides which payment goes to which promise
      const history = found.length
        ? await CollectionAction.find({ tenantId, companyId, clientId: { $in: [...new Set(found.map((a) => String(a.clientId?._id || a.clientId)))] }, 'promise.dueDate': { $exists: true } }).lean()
        : [];
      const all = await withPromiseStates(found, { tenantId, companyId }, new Date(), history);
      const matching = all.filter((action) => (promise ? action.promiseState === promise : true) && (!dueToday || action.promiseState === 'vigente'));
      total = matching.length;
      rows = matching.slice((page - 1) * limit, page * limit);
    } else {
      const list = await query.skip((page - 1) * limit).limit(limit);
      const history = list.some((a) => a.promise?.dueDate)
        ? await CollectionAction.find({ tenantId, companyId, clientId: { $in: [...new Set(list.map((a) => String(a.clientId?._id || a.clientId)))] }, 'promise.dueDate': { $exists: true } }).lean()
        : [];
      [rows, total] = await Promise.all([
        withPromiseStates(list, { tenantId, companyId }, new Date(), history),
        CollectionAction.countDocuments(filter),
      ]);
    }

    res.json({
      success: true,
      data: {
        actions: rows.map(({ clientId, ...action }) => ({ ...action, client: clientId, clientId: clientId?._id })),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/collection-actions?companyId=
 * Records a collection action on a client of the project (and optionally one of their contracts).
 * Result «promesa» needs an amount over 0 and a date from today on.
 */
router.post('/', companyMiddleware, checkPermission(PERMISSIONS.CARTERA_FOLLOWUP), async (req, res, next) => {
  try {
    const { tenantId, companyId, role, userId, fullName } = req.user;
    const { clientId, contractId, channel, result, notes, promise } = req.body;

    // Agents only look (as in the rest of the panel)
    if (role === 'agent') return res.status(403).json({ success: false, message: 'Tu rol solo puede ver las gestiones' });
    if (!ACTION_CHANNELS.includes(channel)) return res.status(400).json({ success: false, message: 'Elige el medio de la gestión' });
    if (!ACTION_RESULTS.includes(result)) return res.status(400).json({ success: false, message: 'Elige el resultado de la gestión' });
    if (!mongoose.isValidObjectId(clientId)) return res.status(400).json({ success: false, message: 'Elige el cliente' });

    const client = await Client.exists({ _id: clientId, tenantId, companyId });
    if (!client) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    if (SELLER_ROLES.includes(role)) {
      const own = (await sellerClientIds({ tenantId, companyId, userId })).map(String);
      if (!own.includes(String(clientId))) return res.status(403).json({ success: false, message: 'Solo puedes registrar gestiones de tus clientes' });
    }

    if (contractId) {
      if (!mongoose.isValidObjectId(contractId)) return res.status(400).json({ success: false, message: 'Contrato no válido' });
      const contract = await Contract.exists({ _id: contractId, client: clientId, tenantId, companyId });
      if (!contract) return res.status(400).json({ success: false, message: 'Ese contrato no es de este cliente' });
    }

    let promiseData;
    if (result === 'promesa') {
      const amount = Number(promise?.amount);
      const dueDate = promise?.dueDate ? parseBusinessDate(promise.dueDate, null) : null;
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: 'Escribe cuánto prometió pagar' });
      if (!dueDate || Number.isNaN(dueDate.getTime())) return res.status(400).json({ success: false, message: 'Escribe la fecha del compromiso' });
      if (dueDate < startOfBogotaDay()) return res.status(400).json({ success: false, message: 'La fecha del compromiso no puede ser anterior a hoy' });
      if (dueDate > new Date(startOfBogotaDay().getTime() + MAX_PROMISE_DAYS * DAY_MS)) return res.status(400).json({ success: false, message: `El compromiso puede ser hasta ${MAX_PROMISE_DAYS} días desde hoy` });
      promiseData = { amount, dueDate };
    }

    const action = await CollectionAction.create({
      tenantId,
      companyId,
      clientId,
      contractId: contractId || undefined,
      channel,
      result,
      notes: typeof notes === 'string' ? notes.trim().slice(0, 2000) : undefined,
      promise: promiseData,
      createdBy: userId,
      createdByName: fullName,
    });

    res.status(201).json({ success: true, data: action });
  } catch (error) {
    next(error);
  }
});

export default router;
