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
import { SELLER_ROLES, sellerClientIds, withPromiseStates } from '../services/collectionActions.service.js';
import { startOfBogotaDay } from '../services/statementSummary.service.js';

const router = express.Router();

router.use(protect);
router.use(tenantMiddleware);

const PROMISE_STATES = ['vigente', 'cumplida', 'incumplida'];

/**
 * GET /api/collection-actions?companyId=&clientId=&promise=vigente|cumplida|incumplida&page=&limit=
 * The project's collection actions, newest first, each promise with its state. Sellers only see the
 * actions on the clients of their sales. With `promise`, only actions carrying a promise in that state.
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
    if (promise) filter['promise.dueDate'] = { $exists: true };

    const query = CollectionAction.find(filter)
      .sort(promise ? { 'promise.dueDate': 1 } : { createdAt: -1 })
      .populate('clientId', 'name idNumber phone')
      .lean();

    let rows;
    let total;
    if (promise) {
      // The state is worked out from payments, so promises are filtered after reading them
      const all = await withPromiseStates(await query.limit(1000), { tenantId, companyId });
      const matching = all.filter((action) => action.promiseState === promise);
      total = matching.length;
      rows = matching.slice((page - 1) * limit, page * limit);
    } else {
      [rows, total] = await Promise.all([
        query.skip((page - 1) * limit).limit(limit).then((list) => withPromiseStates(list, { tenantId, companyId })),
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
      if (!dueDate) return res.status(400).json({ success: false, message: 'Escribe la fecha del compromiso' });
      if (dueDate < startOfBogotaDay()) return res.status(400).json({ success: false, message: 'La fecha del compromiso no puede ser anterior a hoy' });
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
