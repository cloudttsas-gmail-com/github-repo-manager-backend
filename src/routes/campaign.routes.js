import express from 'express';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import Company from '../models/Company.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';
import { PERMISSIONS } from '../config/permissions.js';
import { estimateCostUsd, WHATSAPP_RATES_CHECKED_AT, WHATSAPP_RATES_USD } from '../config/whatsappRates.js';
import { logAudit } from '../utils/auditLogger.js';
import { buildAudience, EXCLUSION_REASONS, normalizeFilters } from '../services/campaignAudience.service.js';
import { campaignTemplates, lastPayments, recipientValues, renderBody, sendComponents } from '../services/campaignTemplates.service.js';
import { kickCampaigns } from '../services/campaignSender.service.js';
import { DEFAULT_CONTACT_POLICY, nextContactWindow, resolveContactPolicy, validateContactPolicy } from '../services/contactPolicy.service.js';
import { companyWhatsAppAccount, internationalPhone } from '../services/whatsappTemplates.service.js';
import { whatsappService } from '../services/whatsapp.service.js';

const router = express.Router();

router.use(protect);
router.use(tenantMiddleware);
router.use(companyMiddleware);

const canSend = checkPermission(PERMISSIONS.COBRANZA_CAMPAIGNS);
const DAY_MS = 24 * 60 * 60 * 1000;
const RESULT_DAYS = 7;
const toId = (value) => new mongoose.Types.ObjectId(String(value));
const SKIP_LABELS = { ...EXCLUSION_REASONS, no_contract: 'Ya no tiene un contrato abierto' };

const loadCompany = (req) => Company.findOne({ _id: req.user.companyId, tenantId: req.user.tenantId });
const maskPhone = (phone) => (phone ? `${String(phone).slice(0, 3)} ••• ${String(phone).slice(-4)}` : null);
const notFound = (res, message = 'Envío no encontrado') => res.status(404).json({ success: false, message });
const badRequest = (res, message) => res.status(400).json({ success: false, message });
const notificationsOff = (res) => res.status(503).json({ success: false, message: 'Los envíos de WhatsApp están apagados en este ambiente.' });

/** The approved template a send asks for, checked to be usable. Returns { template } or { error }. */
const pickTemplate = async (company, input) => {
  if (!companyWhatsAppAccount(company)) return { error: 'El proyecto no tiene un número de WhatsApp conectado.' };
  const templates = await campaignTemplates(company);
  const template = templates.find((t) => t.name === input?.name && t.language === input?.language);
  if (!template) return { error: 'Esa plantilla no está en la cuenta de WhatsApp del proyecto.' };
  if (!template.usable) return { error: template.reason };
  return { template };
};

const excludedList = (excluded = {}) => Object.entries(excluded).map(([reason, count]) => ({ reason, label: SKIP_LABELS[reason] || reason, count }));

/** GET /api/campaigns/policy: the project's contact hours and weekly limit, with the defaults. */
router.get('/policy', canSend, async (req, res, next) => {
  try {
    const company = await loadCompany(req);
    if (!company) return notFound(res, 'Proyecto no encontrado');
    res.json({ success: true, data: { policy: resolveContactPolicy(company.contactPolicy), defaults: DEFAULT_CONTACT_POLICY } });
  } catch (error) { next(error); }
});

/** PUT /api/campaigns/policy (CONFIG_TENANT) */
router.put('/policy', checkPermission(PERMISSIONS.CONFIG_TENANT), async (req, res, next) => {
  try {
    let changes;
    try { changes = validateContactPolicy(req.body || {}); } catch (error) { return badRequest(res, error.message); }
    const company = await loadCompany(req);
    if (!company) return notFound(res, 'Proyecto no encontrado');
    const before = resolveContactPolicy(company.contactPolicy);
    company.contactPolicy = { ...(company.contactPolicy?.toObject?.() || company.contactPolicy || {}), ...changes };
    await company.save();
    const policy = resolveContactPolicy(company.contactPolicy);
    await logAudit(req, { action: 'UPDATE_CONTACT_POLICY', module: 'COMPANIES', targetId: company._id, details: { before, after: policy } });
    res.json({ success: true, data: { policy, defaults: DEFAULT_CONTACT_POLICY } });
  } catch (error) { next(error); }
});

/** GET /api/campaigns/templates: the project's templates, each saying whether a send can use it. */
router.get('/templates', canSend, async (req, res, next) => {
  try {
    const company = await loadCompany(req);
    if (!company) return notFound(res, 'Proyecto no encontrado');
    if (!companyWhatsAppAccount(company)) return badRequest(res, 'El proyecto no tiene un número de WhatsApp conectado.');
    const templates = await campaignTemplates(company);
    res.json({ success: true, data: { templates, rates: WHATSAPP_RATES_USD, ratesCheckedAt: WHATSAPP_RATES_CHECKED_AT } });
  } catch (error) { next(error); }
});

/**
 * POST /api/campaigns/preview { filters, exclusions, template, sampleClientId? }
 * How many buyers a send reaches and why the rest are left out, the estimated cost, and the message
 * as one of them would read it.
 */
router.post('/preview', canSend, async (req, res, next) => {
  try {
    const company = await loadCompany(req);
    if (!company) return notFound(res, 'Proyecto no encontrado');
    let template = null;
    if (req.body?.template) {
      const picked = await pickTemplate(company, req.body.template);
      if (picked.error) return badRequest(res, picked.error);
      template = picked.template;
    }
    const filters = normalizeFilters(req.body?.filters);
    const exclusions = { pendingPayment: req.body?.exclusions?.pendingPayment !== false, openPromise: req.body?.exclusions?.openPromise !== false };
    const policy = resolveContactPolicy(company.contactPolicy);
    const { tenantId, companyId } = req.user;
    const audience = await buildAudience({ tenantId, companyId, filters, exclusions, category: template?.category || 'UTILITY', policy });

    const sample = audience.recipients.find((r) => String(r.client._id) === String(req.body?.sampleClientId)) || audience.recipients[0];
    let preview = null;
    if (template && sample) {
      const payments = await lastPayments({ tenantId: toId(tenantId), companyId: toId(companyId), clientIds: [sample.client._id] });
      const values = recipientValues({ company, client: sample.client, contract: sample.contract, summary: sample.summary, lastPayment: payments.get(String(sample.client._id)) });
      preview = { clientId: sample.client._id, clientName: sample.client.name, body: renderBody(template.body, values), values };
    }

    res.json({
      success: true,
      data: {
        matched: audience.matched,
        recipients: audience.recipients.length,
        excluded: excludedList(audience.excluded),
        estimatedCostUsd: template ? estimateCostUsd(template.category, audience.recipients.length) : null,
        nextWindow: nextContactWindow(new Date(), policy),
        sample: audience.recipients.slice(0, 50).map((r) => ({
          clientId: r.client._id,
          name: r.client.name,
          phone: maskPhone(r.phone),
          property: r.summary.lotLabel,
          daysOverdue: r.summary.daysOverdue,
          overdueAmount: r.summary.overdueAmount,
        })),
        preview,
      },
    });
  } catch (error) { next(error); }
});

/**
 * POST /api/campaigns { name, template, filters, exclusions, scheduledAt? }
 * Creates the send with its recipients. Without `scheduledAt` it goes out now, or when the project's
 * contact hours open.
 */
router.post('/', canSend, async (req, res, next) => {
  try {
    if (process.env.ENABLE_NOTIFICATIONS !== 'true') return notificationsOff(res);
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) return badRequest(res, 'Ponle un nombre al envío.');
    const company = await loadCompany(req);
    if (!company) return notFound(res, 'Proyecto no encontrado');
    const picked = await pickTemplate(company, req.body?.template);
    if (picked.error) return badRequest(res, picked.error);
    const { template } = picked;

    const now = new Date();
    let scheduledAt = now;
    if (req.body?.scheduledAt) {
      scheduledAt = new Date(req.body.scheduledAt);
      if (Number.isNaN(scheduledAt.getTime())) return badRequest(res, 'La fecha de envío no es válida.');
      if (scheduledAt < new Date(now.getTime() - 5 * 60 * 1000)) return badRequest(res, 'La fecha de envío ya pasó.');
      if (scheduledAt > new Date(now.getTime() + 60 * DAY_MS)) return badRequest(res, 'Un envío se programa con máximo 60 días.');
    }
    const policy = resolveContactPolicy(company.contactPolicy);
    scheduledAt = nextContactWindow(scheduledAt < now ? now : scheduledAt, policy) || scheduledAt;

    const filters = normalizeFilters(req.body?.filters);
    const exclusions = { pendingPayment: req.body?.exclusions?.pendingPayment !== false, openPromise: req.body?.exclusions?.openPromise !== false };
    const { tenantId, companyId, userId, fullName: userName } = req.user;
    const audience = await buildAudience({ tenantId, companyId, filters, exclusions, category: template.category, policy }, now);
    if (!audience.recipients.length) return badRequest(res, 'Con estos filtros no queda ningún comprador para enviar.');

    const campaign = await Campaign.create({
      tenantId, companyId, name,
      template: { name: template.name, language: template.language, category: template.category },
      filters, exclusions, excluded: audience.excluded, scheduledAt,
      estimatedCostUsd: estimateCostUsd(template.category, audience.recipients.length),
      createdBy: userId, createdByName: userName,
    });
    await CampaignRecipient.insertMany(audience.recipients.map((r) => ({
      tenantId, companyId, campaignId: campaign._id, clientId: r.client._id, contractId: r.contract._id, phone: r.phone,
    })));
    await logAudit(req, {
      action: 'CREATE_CAMPAIGN', module: 'WHATSAPP', targetId: campaign._id,
      details: { name, template: template.name, recipients: audience.recipients.length, scheduledAt },
    });
    if (scheduledAt <= new Date()) kickCampaigns();
    res.status(201).json({ success: true, data: { ...campaign.toObject(), recipients: audience.recipients.length } });
  } catch (error) { next(error); }
});

/** Counts by recipient status for some campaigns: Map campaignId → { status: count } */
const statusCounts = async (campaignIds) => {
  const rows = await CampaignRecipient.aggregate([
    { $match: { campaignId: { $in: campaignIds } } },
    { $group: { _id: { campaign: '$campaignId', status: '$status' }, count: { $sum: 1 }, replied: { $sum: { $cond: [{ $ifNull: ['$repliedAt', false] }, 1, 0] } }, optedOut: { $sum: { $cond: [{ $ifNull: ['$optedOutAt', false] }, 1, 0] } } } },
  ]);
  const counts = new Map();
  rows.forEach((row) => {
    const id = String(row._id.campaign);
    const entry = counts.get(id) || { total: 0, replied: 0, optedOut: 0 };
    entry[row._id.status] = row.count;
    entry.total += row.count;
    entry.replied += row.replied;
    entry.optedOut += row.optedOut;
    counts.set(id, entry);
  });
  return counts;
};

/** GET /api/campaigns?page=&limit=: the project's sends, newest first, with their counts. */
router.get('/', canSend, async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const filter = { tenantId, companyId };
    const [campaigns, total] = await Promise.all([
      Campaign.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Campaign.countDocuments(filter),
    ]);
    const counts = await statusCounts(campaigns.map((c) => c._id));
    res.json({
      success: true,
      data: campaigns.map((c) => ({ ...c, counts: counts.get(String(c._id)) || { total: 0 } })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) { next(error); }
});

const findCampaign = (req) => (mongoose.isValidObjectId(req.params.id)
  ? Campaign.findOne({ _id: req.params.id, tenantId: req.user.tenantId, companyId: req.user.companyId }).lean()
  : null);

/**
 * GET /api/campaigns/:id: the send with its counts and the payments its buyers made in the
 * RESULT_DAYS days after their message.
 */
router.get('/:id', canSend, async (req, res, next) => {
  try {
    const campaign = await findCampaign(req);
    if (!campaign) return notFound(res);
    const counts = (await statusCounts([campaign._id])).get(String(campaign._id)) || { total: 0 };
    const sent = await CampaignRecipient.find({ campaignId: campaign._id, sentAt: { $ne: null } }).select('clientId sentAt').lean();
    let payments = { count: 0, amount: 0, clients: 0 };
    if (sent.length) {
      const first = sent.reduce((min, r) => (r.sentAt < min ? r.sentAt : min), sent[0].sentAt);
      const sentAtOf = new Map(sent.map((r) => [String(r.clientId), r.sentAt]));
      const rows = await PaymentAttempt.find({
        tenantId: toId(req.user.tenantId), companyId: toId(req.user.companyId), status: { $in: ['APROBADO', 'PENDIENTE'] },
        clientId: { $in: sent.map((r) => r.clientId) }, createdAt: { $gte: first, $lte: new Date(first.getTime() + (RESULT_DAYS + 1) * DAY_MS) },
      }).select('clientId amount createdAt').lean();
      const counted = rows.filter((p) => {
        const at = sentAtOf.get(String(p.clientId));
        return at && p.createdAt >= at && p.createdAt <= new Date(at.getTime() + RESULT_DAYS * DAY_MS);
      });
      payments = { count: counted.length, amount: counted.reduce((sum, p) => sum + (p.amount || 0), 0), clients: new Set(counted.map((p) => String(p.clientId))).size };
    }
    const skipped = await CampaignRecipient.aggregate([
      { $match: { campaignId: campaign._id, status: 'skipped' } },
      { $group: { _id: '$skipReason', count: { $sum: 1 } } },
    ]);
    res.json({
      success: true,
      data: {
        ...campaign,
        counts,
        excluded: excludedList(campaign.excluded),
        skipped: skipped.map((row) => ({ reason: row._id, label: SKIP_LABELS[row._id] || row._id, count: row.count })),
        payments: { ...payments, days: RESULT_DAYS },
      },
    });
  } catch (error) { next(error); }
});

/** GET /api/campaigns/:id/recipients?status=&page=&limit= */
router.get('/:id/recipients', canSend, async (req, res, next) => {
  try {
    const campaign = await findCampaign(req);
    if (!campaign) return notFound(res);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const filter = { campaignId: campaign._id };
    if (req.query.status === 'replied') filter.repliedAt = { $ne: null };
    else if (req.query.status === 'opted_out') filter.optedOutAt = { $ne: null };
    else if (req.query.status) filter.status = String(req.query.status);
    const [rows, total] = await Promise.all([
      CampaignRecipient.find(filter).sort({ _id: 1 }).skip((page - 1) * limit).limit(limit).populate('clientId', 'name idNumber').lean(),
      CampaignRecipient.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r._id,
        client: r.clientId ? { id: r.clientId._id, name: r.clientId.name, idNumber: r.clientId.idNumber } : null,
        phone: maskPhone(r.phone),
        status: r.status,
        skipReason: r.skipReason ? SKIP_LABELS[r.skipReason] || r.skipReason : null,
        error: r.error || null,
        sentAt: r.sentAt, deliveredAt: r.deliveredAt, readAt: r.readAt, repliedAt: r.repliedAt, optedOutAt: r.optedOutAt,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) { next(error); }
});

/** POST /api/campaigns/:id/cancel: stops a send; messages already out stay out. */
router.post('/:id/cancel', canSend, async (req, res, next) => {
  try {
    const campaign = await findCampaign(req);
    if (!campaign) return notFound(res);
    const updated = await Campaign.findOneAndUpdate(
      { _id: campaign._id, status: { $in: ['scheduled', 'sending'] } },
      { status: 'cancelled', cancelledAt: new Date() },
      { new: true },
    ).lean();
    if (!updated) return badRequest(res, 'Este envío ya terminó o ya estaba cancelado.');
    const { modifiedCount } = await CampaignRecipient.updateMany({ campaignId: campaign._id, status: 'queued' }, { status: 'cancelled' });
    await logAudit(req, { action: 'CANCEL_CAMPAIGN', module: 'WHATSAPP', targetId: campaign._id, details: { name: campaign.name, notSent: modifiedCount } });
    res.json({ success: true, data: { ...updated, notSent: modifiedCount } });
  } catch (error) { next(error); }
});

/**
 * POST /api/campaigns/test { template, phone, filters?, sampleClientId? }
 * Sends the template to a phone of the team with the data of one buyer of the filters, so the
 * message can be checked before the real send. It counts for no one's weekly limit.
 */
router.post('/test', canSend, async (req, res, next) => {
  try {
    if (process.env.ENABLE_NOTIFICATIONS !== 'true') return notificationsOff(res);
    const phone = internationalPhone(req.body?.phone);
    if (!phone) return badRequest(res, 'Escribe un celular colombiano de 10 dígitos.');
    const company = await loadCompany(req);
    if (!company) return notFound(res, 'Proyecto no encontrado');
    const picked = await pickTemplate(company, req.body?.template);
    if (picked.error) return badRequest(res, picked.error);
    const { template } = picked;
    const { tenantId, companyId } = req.user;
    const audience = await buildAudience({
      tenantId, companyId, filters: normalizeFilters(req.body?.filters), exclusions: { pendingPayment: false, openPromise: false },
      category: 'UTILITY', policy: { weeklyLimit: Infinity },
    });
    const sample = audience.recipients.find((r) => String(r.client._id) === String(req.body?.sampleClientId)) || audience.recipients[0];
    if (!sample) return badRequest(res, 'Con estos filtros no hay un comprador para tomar los datos de la prueba.');
    const payments = await lastPayments({ tenantId: toId(tenantId), companyId: toId(companyId), clientIds: [sample.client._id] });
    const ctx = { contract: sample.contract, lastPayment: payments.get(String(sample.client._id)), apiUrl: process.env.API_URL || '' };
    const values = recipientValues({ company, client: sample.client, summary: sample.summary, ...ctx });
    let components;
    try { components = sendComponents(template, values, ctx); } catch (error) { return badRequest(res, error.message); }
    try {
      await whatsappService.sendTemplateMessage(companyWhatsAppAccount(company), phone, template.name, template.language, components);
    } catch (error) {
      return res.status(502).json({ success: false, message: `Meta no envió la prueba: ${error.message}` });
    }
    res.json({ success: true, data: { sentTo: maskPhone(phone), sampleClient: sample.client.name } });
  } catch (error) { next(error); }
});

export default router;
