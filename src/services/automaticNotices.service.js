import mongoose from 'mongoose';
import Company from '../models/Company.js';
import Client from '../models/Client.js';
import Contract from '../models/Contract.js';
import Quota from '../models/Quota.js';
import ScheduledNotice from '../models/ScheduledNotice.js';
import {
  companyWhatsAppAccount, money, propertyName, quotaNumberText, sendCompanyNotice, shortDate,
} from './whatsappTemplates.service.js';
import { isWithinContactHours, resolveContactPolicy, weeklyWhatsAppContacts } from './contactPolicy.service.js';
import { buildAudience, mobilePhone } from './campaignAudience.service.js';
import { bogotaDay, quotaPendingAmount } from './statementSummary.service.js';
import { publicLinkUrl } from '../utils/publicLinks.js';

/**
 * WhatsApp notices Operix sends to buyers on its own: the payment plan (and its updates), the quota
 * reminders and the rejected payment. Each one waits in ScheduledNotice until the project's contact
 * hours (Ley 2300) and is checked again right before it goes out. Plan: planes/2026-11-26-recordatorios-whatsapp.md.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKER_INTERVAL_MS = 60 * 1000;
// Reminders are planned once an hour: each quota and step has one key, so planning again adds nothing
const PLAN_INTERVAL_MS = 60 * 60 * 1000;
const MAX_PER_ROUND = 200;
const STALE_MS = 10 * 60 * 1000;
const CLOSED_CONTRACT = /cancel|anulad|desist/i;

// Days a quota has been overdue when its reminder goes out. A step missed by more than a week is
// skipped: turning reminders on never floods old debts (those go by Envíos)
export const OVERDUE_STEPS = [1, 8, 15, 30];
const STEP_WINDOW_DAYS = 7;
export const REMINDER_DAYS_BEFORE = [1, 2, 3, 5, 7];
export const REMINDER_DEFAULTS = { enabled: false, daysBefore: 3 };

/** The project's reminder settings, with the defaults. */
export const resolveReminders = (reminders = {}) => ({
  enabled: reminders?.enabled === true,
  daysBefore: REMINDER_DAYS_BEFORE.includes(Number(reminders?.daysBefore)) ? Number(reminders.daysBefore) : REMINDER_DEFAULTS.daysBefore,
});

/** Checks the reminder settings sent by the panel; throws a message for the first wrong field. */
export const validateReminders = (input = {}) => {
  const out = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('Indica si los recordatorios están activos.');
    out.enabled = input.enabled;
  }
  if (input.daysBefore !== undefined) {
    if (!REMINDER_DAYS_BEFORE.includes(Number(input.daysBefore))) throw new Error(`El recordatorio antes del vencimiento puede salir ${REMINDER_DAYS_BEFORE.join(', ')} días antes.`);
    out.daysBefore = Number(input.daysBefore);
  }
  return out;
};

// Calendar days between two Bogotá dates (YYYY-MM-DD)
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** Queues a notice; a key already queued is left as it was. Returns the notice or null. */
const enqueue = async (doc) => {
  try {
    return await ScheduledNotice.create(doc);
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
};

const sortQuotas = (quotas) => [...quotas].sort((a, b) => {
  if (a.type !== b.type) return a.type === 'inicial' ? -1 : 1;
  return Number(a.number) - Number(b.number);
});

/**
 * The payment plan by WhatsApp, with its PDF: the first one (`operix_plan_pagos`) or, with a reason,
 * the update (`operix_plan_actualizado`). Each call is a new send (sending it again is a team's choice).
 */
export const queuePaymentPlanNotice = async ({ company, client, contract, quotas, updateReason = '' }) => {
  if (!company || !client?.phone || !contract?._id || !quotas?.length || !companyWhatsAppAccount(company)) return null;
  const sorted = sortQuotas(quotas);
  const byDate = [...quotas].filter((q) => q.dueDate).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const firstUnpaid = sorted.find((q) => q.status !== 'pagado') || sorted[0];
  const notice = updateReason ? 'plan_actualizado' : 'plan_pagos';
  const queued = await enqueue({
    tenantId: company.tenantId,
    companyId: company._id,
    clientId: client._id,
    contractId: contract._id,
    notice,
    key: `${notice}:${contract._id}:${Date.now()}:${new mongoose.Types.ObjectId()}`,
    values: updateReason
      ? { reason: String(updateReason).trim(), fromQuota: quotaNumberText(firstUnpaid) }
      : { quotaCount: String(quotas.length), firstDate: shortDate(byDate[0]?.dueDate) },
  });
  if (queued) kickNotices();
  return queued;
};

/** Tells the buyer that a payment they reported was rejected, and why (`operix_pago_rechazado`). */
export const queueRejectedPaymentNotice = async (attempt) => {
  if (!attempt?.clientId) return null;
  const company = await Company.findById(attempt.companyId);
  if (!company || !companyWhatsAppAccount(company)) return null;
  const queued = await enqueue({
    tenantId: attempt.tenantId,
    companyId: attempt.companyId,
    clientId: attempt.clientId,
    contractId: attempt.contractId,
    paymentAttemptId: attempt._id,
    notice: 'pago_rechazado',
    key: `pago_rechazado:${attempt._id}`,
    values: {
      amount: money(attempt.amount),
      date: shortDate(attempt.fechaPago || attempt.createdAt),
      reason: String(attempt.rejectedReason || 'no coincide con nuestros registros').trim().replace(/[.\s]+$/, ''),
    },
  });
  if (queued) kickNotices();
  return queued;
};

/**
 * Queues today's quota reminders of a project that turned them on: the quotas due in the next
 * `daysBefore` days (`operix_cuota_por_vencer`) and the overdue ones on their step (`operix_cuota_vencida`).
 * One reminder per contract and run: its oldest overdue quota, or else the next one to fall due.
 * Returns how many were queued.
 */
export const planQuotaReminders = async (company, now = new Date()) => {
  const reminders = resolveReminders(company?.reminders);
  if (!reminders.enabled || !companyWhatsAppAccount(company)) return 0;
  const today = bogotaDay(now);
  const lastDay = bogotaDay(new Date(now.getTime() + reminders.daysBefore * DAY_MS));
  const oldest = new Date(now.getTime() - (OVERDUE_STEPS.at(-1) + STEP_WINDOW_DAYS + 1) * DAY_MS);
  const newest = new Date(now.getTime() + (reminders.daysBefore + 1) * DAY_MS);

  const quotas = await Quota.find({
    tenantId: company.tenantId, companyId: company._id, status: { $ne: 'pagado' }, dueDate: { $gte: oldest, $lte: newest },
  }).select('contract number type value amountPaid dueDate status').lean();
  const open = quotas.filter((q) => quotaPendingAmount(q) > 0);
  if (!open.length) return 0;

  const contracts = await Contract.find({ _id: { $in: [...new Set(open.map((q) => String(q.contract)))] }, companyId: company._id })
    .select('client status').lean();
  const contractOf = new Map(contracts.filter((c) => c.client && !CLOSED_CONTRACT.test(c.status || '')).map((c) => [String(c._id), c]));

  const candidates = new Map();
  for (const quota of open) {
    const contract = contractOf.get(String(quota.contract));
    if (!contract) continue;
    const due = bogotaDay(quota.dueDate);
    const late = daysBetween(due, today);
    let reminder = null;
    if (late >= 1) {
      const step = [...OVERDUE_STEPS].reverse().find((s) => s <= late);
      if (step && late - step < STEP_WINDOW_DAYS) reminder = { notice: 'cuota_vencida', key: `cuota_vencida:${quota._id}:${step}`, order: -late };
    } else if (due > today && due <= lastDay) {
      reminder = { notice: 'cuota_por_vencer', key: `cuota_por_vencer:${quota._id}:${due}`, order: daysBetween(today, due) };
    }
    if (!reminder) continue;
    const current = candidates.get(String(contract._id));
    if (!current || reminder.order < current.order) candidates.set(String(contract._id), { ...reminder, quota, contract });
  }

  let queued = 0;
  for (const { notice, key, quota, contract } of candidates.values()) {
    const doc = await enqueue({
      tenantId: company.tenantId,
      companyId: company._id,
      clientId: contract.client,
      contractId: contract._id,
      quotaId: quota._id,
      notice,
      key,
      collection: true,
      scheduledAt: now,
    });
    if (doc) queued += 1;
  }
  return queued;
};

/** The number's opt-out applies to every buyer of the project who shares it. */
const phoneOptedOut = async (notice, phone) => {
  const buyers = await Client.find({ tenantId: notice.tenantId, companyId: notice.companyId, 'contactConsent.status': 'baja', phone: { $nin: [null, ''] } })
    .select('phone').lean();
  return buyers.some((b) => mobilePhone(b.phone) === phone);
};

const finishAs = (notice, update) => ScheduledNotice.updateOne({ _id: notice._id }, update);
const skip = (notice, skipReason) => finishAs(notice, { status: 'skipped', skipReason, sentAt: null });

/** Checks a claimed notice against current data and sends it, or says why it was left out. */
const deliver = async (notice, company, policy, now) => {
  const client = await Client.findOne({ _id: notice.clientId, tenantId: notice.tenantId, companyId: notice.companyId })
    .select('name phone contactConsent').lean();
  if (!client) return skip(notice, 'no_client');
  const phone = mobilePhone(client.phone);
  if (!phone) return skip(notice, 'no_phone');
  if (client.contactConsent?.status === 'baja' || await phoneOptedOut(notice, phone)) return skip(notice, 'opted_out');

  let quota = null;
  if (notice.collection) {
    quota = await Quota.findOne({ _id: notice.quotaId, companyId: notice.companyId }).lean();
    if (!quota || quota.status === 'pagado' || quotaPendingAmount(quota) <= 0) return skip(notice, 'paid');
    // A reminder that waited past the due date (Sunday, holiday) is no longer «por vencer»
    if (notice.notice === 'cuota_por_vencer' && bogotaDay(quota.dueDate) <= bogotaDay(now)) return skip(notice, 'expired');
    // The same exclusions as a send: a payment in review, an open promise and the weekly limit (by number)
    const scope = { tenantId: notice.tenantId, companyId: notice.companyId };
    const contacts = await weeklyWhatsAppContacts({ ...scope, clientIds: [notice.clientId], excludeNoticeId: notice._id }, now);
    const audience = await buildAudience({
      ...scope, filters: { mora: 'all', clientIds: [String(notice.clientId)] }, exclusions: {}, category: 'UTILITY', policy, contacts,
    }, now);
    if (!audience.recipients.length) return skip(notice, audience.reasons.get(String(notice.clientId)) || 'no_longer_matches');
  }

  const contract = notice.contractId
    ? await Contract.findOne({ _id: notice.contractId, companyId: notice.companyId }).populate('lot', 'lotNumber manzana propertyType').lean()
    : null;
  const values = {
    ...(notice.values || {}),
    clientName: client.name,
    property: propertyName(contract?.lot, company.propertyType),
    slug: company.slug,
    ...(contract ? { statementUrl: publicLinkUrl('statement', contract._id) } : {}),
    ...(quota ? { quotaNumber: quotaNumberText(quota), amount: money(quotaPendingAmount(quota)), date: shortDate(quota.dueDate) } : {}),
  };
  if (['plan_pagos', 'plan_actualizado'].includes(notice.notice) && !contract) return skip(notice, 'no_contract');

  const result = await sendCompanyNotice({ company, to: phone, notice: notice.notice, values });
  if (!result.success) return finishAs(notice, { status: 'failed', error: String(result.error || 'Meta no aceptó el mensaje').slice(0, 500), sentAt: null, phone });
  return finishAs(notice, { status: 'sent', sentAt: now, phone, waMessageId: result.data?.messages?.[0]?.id });
};

let running = false;
let timer = null;
let lastPlanAt = 0;

/**
 * One round: plans the reminders (once an hour), then sends what is due in projects that are inside
 * their contact hours. Outside them a notice waits for the next window.
 */
export const processScheduledNotices = async (now = () => new Date(), { plan = false } = {}) => {
  if (process.env.ENABLE_NOTIFICATIONS !== 'true') return;
  if (running) return;
  running = true;
  try {
    // A notice claimed by a round that died never knows whether Meta got it: say so instead of resending
    await ScheduledNotice.updateMany(
      { status: 'sending', updatedAt: { $lt: new Date(now().getTime() - STALE_MS) } },
      { status: 'failed', error: 'El envío se interrumpió; puede que haya llegado' },
    );
    if (plan || now().getTime() - lastPlanAt >= PLAN_INTERVAL_MS) {
      lastPlanAt = now().getTime();
      const companies = await Company.find({ 'reminders.enabled': true });
      for (const company of companies) {
        try {
          await planQuotaReminders(company, now());
        } catch (error) {
          console.error('[NOTICES] reminders could not be planned for a project:', error.message);
        }
      }
    }

    const due = await ScheduledNotice.find({ status: 'queued', scheduledAt: { $lte: now() } }).sort({ scheduledAt: 1 }).limit(MAX_PER_ROUND).lean();
    const companies = new Map();
    for (const item of due) {
      const id = String(item.companyId);
      if (!companies.has(id)) {
        const company = await Company.findById(item.companyId);
        companies.set(id, company ? { company, policy: resolveContactPolicy(company.contactPolicy) } : null);
      }
      const entry = companies.get(id);
      if (!entry) { await skip(item, 'no_company'); continue; }
      if (!isWithinContactHours(now(), entry.policy)) continue;
      const claimed = await ScheduledNotice.findOneAndUpdate({ _id: item._id, status: 'queued' }, { status: 'sending', sentAt: now() }, { new: true }).lean();
      if (!claimed) continue;
      try {
        await deliver(claimed, entry.company, entry.policy, now());
      } catch (error) {
        console.error(`[NOTICES] ${claimed.notice} failed:`, error.message);
        await finishAs(claimed, { status: 'failed', error: String(error.message).slice(0, 500), sentAt: null });
      }
    }
  } catch (error) {
    console.error('[NOTICES] round failed:', error.message);
  } finally {
    running = false;
  }
};

/** Starts the queue: one round a minute, next to the one of Envíos. */
export const startNoticeWorker = () => {
  if (timer) return;
  timer = setInterval(() => { processScheduledNotices(); }, WORKER_INTERVAL_MS);
  timer.unref?.();
};

/** Sends right away what was just queued, if the project is inside its hours. Never in tests. */
export const kickNotices = () => {
  if (process.env.NODE_ENV === 'test' || !timer) return;
  setImmediate(() => { processScheduledNotices(); });
};
