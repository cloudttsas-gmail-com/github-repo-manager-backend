import mongoose from 'mongoose';
import Client from '../models/Client.js';
import CollectionAction from '../models/CollectionAction.js';
import Contract from '../models/Contract.js';
import PaymentAttempt from '../models/PaymentAttempt.js';
import Quota from '../models/Quota.js';
import { isAppliedToQuotas } from './paymentApplication.service.js';
import { buildStatementSummary, bogotaDay } from './statementSummary.service.js';
import { withPromiseStates } from './collectionActions.service.js';
import { weeklyWhatsAppContacts } from './contactPolicy.service.js';
import { ARREARS_RANGES } from './arrears.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const toId = (value) => new mongoose.Types.ObjectId(String(value));

// The same ranges as Inicio, Cartera and the financial report; 1-15 and 16-30 still read for sends saved before
export const MORA_RANGES = {
  ...ARREARS_RANGES,
  MORA_1_15: [1, 15],
  MORA_16_30: [16, 30],
};
const MORA_FILTERS = ['all', 'al_dia', 'en_mora', ...Object.keys(MORA_RANGES)];
export const BEHAVIORS = ['DISPUESTO', 'INDECISO', 'EVASIVO'];

/** Why a buyer is left out of a send, in the order they are checked. */
export const EXCLUSION_REASONS = {
  no_phone: 'Sin celular válido',
  duplicate_phone: 'Comparte el celular con otro comprador del envío',
  opted_out: 'Pidió no recibir mensajes',
  no_consent: 'Sin autorización (marketing)',
  no_document: 'No tiene el documento que adjunta la plantilla',
  pending_payment: 'Tiene un comprobante por revisar',
  open_promise: 'Tiene un compromiso de pago vigente',
  weekly_limit: 'Ya llegó al límite de mensajes de la semana',
};

/** A Colombian mobile (3XX XXX XXXX) as +57…, or null: sends go to WhatsApp, never to landlines. */
export const mobilePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (/^573\d{9}$/.test(digits)) return `+${digits}`;
  if (/^3\d{9}$/.test(digits)) return `+57${digits}`;
  return null;
};

/** The filters a send accepts, cleaned up: anything unknown is dropped. */
export const normalizeFilters = (input = {}) => {
  const filters = {};
  filters.mora = MORA_FILTERS.includes(input.mora) ? input.mora : 'en_mora';
  const dueWithin = Number(input.dueWithinDays);
  if (Number.isInteger(dueWithin) && dueWithin >= 1 && dueWithin <= 31) {
    filters.dueWithinDays = dueWithin;
    // «Vence en N días» is about buyers up to date: in arrears the next quota is always overdue
    filters.mora = 'al_dia';
  }
  if (input.noPaymentThisMonth === true || input.noPaymentThisMonth === 'true') filters.noPaymentThisMonth = true;
  if (BEHAVIORS.includes(input.behavior)) filters.behavior = input.behavior;
  if (input.sellerId && mongoose.isValidObjectId(input.sellerId)) filters.sellerId = String(input.sellerId);
  if (Array.isArray(input.clientIds)) {
    const ids = input.clientIds.filter((id) => mongoose.isValidObjectId(id)).map(String);
    if (ids.length) filters.clientIds = [...new Set(ids)].slice(0, 5000);
  }
  return filters;
};

const CLOSED_CONTRACT = /cancel|anulad|desist/i;

/**
 * The contract a message talks about: the one with the oldest overdue quota, or else the one whose
 * next quota comes first. Paid contracts don't count: a buyer whose contracts are all paid is left out.
 */
const mainSummary = (summaries) => {
  const open = summaries.filter((s) => s.status !== 'pagado');
  const late = open.filter((s) => s.status === 'en_mora').sort((a, b) => b.daysOverdue - a.daysOverdue);
  if (late.length) return late[0];
  const upcoming = open.filter((s) => s.nextQuota).sort((a, b) => new Date(a.nextQuota.dueDate || 8.64e15) - new Date(b.nextQuota.dueDate || 8.64e15));
  return upcoming[0] || open[0] || null;
};

const matchesMora = (summary, mora) => {
  if (mora === 'all') return true;
  if (mora === 'al_dia') return summary.status === 'al_dia';
  if (mora === 'en_mora') return summary.status === 'en_mora';
  const [min, max] = MORA_RANGES[mora];
  return summary.status === 'en_mora' && summary.daysOverdue >= min && summary.daysOverdue <= max;
};

/**
 * Loads the clients of a project with the summary of their main contract.
 * Returns [{ client, contract, summary }]; clients without an open, unpaid contract are left out.
 */
export const loadClientSummaries = async ({ tenantId, companyId, clientIds, sellerId }, now = new Date()) => {
  const contractFilter = { tenantId: toId(tenantId), companyId: toId(companyId) };
  if (clientIds) contractFilter.client = { $in: clientIds.map(toId) };
  if (sellerId) contractFilter.sellerId = toId(sellerId);
  const contracts = (await Contract.find(contractFilter)
    .select('client lot sellerId totalValue status negotiation recaudadoSiigo2024 recaudadoSiigo2025')
    .populate('lot', 'lotNumber manzana stage nomenclature propertyType').lean())
    .filter((c) => !CLOSED_CONTRACT.test(c.status || ''));
  if (!contracts.length) return [];

  const quotas = await Quota.find({ contract: { $in: contracts.map((c) => c._id) } })
    .select('contract number type value dueDate status amountPaid paymentDate').lean();
  const quotasByContract = new Map();
  quotas.forEach((q) => {
    const list = quotasByContract.get(String(q.contract));
    if (list) list.push(q); else quotasByContract.set(String(q.contract), [q]);
  });

  const byClient = new Map();
  contracts.forEach((contract) => {
    const summary = buildStatementSummary(contract, quotasByContract.get(String(contract._id)) || [], { now });
    const list = byClient.get(String(contract.client));
    if (list) list.push({ contract, summary }); else byClient.set(String(contract.client), [{ contract, summary }]);
  });

  const clients = await Client.find({ _id: { $in: [...byClient.keys()].map(toId) }, tenantId, companyId })
    .select('name idNumber phone behavior contactConsent').lean();
  return clients.flatMap((client) => {
    const list = byClient.get(String(client._id));
    const main = mainSummary(list.map((item) => item.summary));
    if (!main) return [];
    const item = list.find((entry) => entry.summary === main);
    return [{ client, contract: item.contract, summary: main }];
  });
};

/**
 * Who a send reaches. Applies the filters, then the automatic exclusions, each with its count.
 * `category` MARKETING needs an explicit authorization; utility sends only skip opted-out buyers.
 * `document` 'recibo' leaves out buyers without an approved payment (the header has nothing to attach).
 * `contacts` (optional) are WhatsApp contacts already counted this week, so a running send adds its own.
 * Returns { matched, recipients: [{ client, contract, summary, phone }], excluded: { reason: count },
 * reasons: Map clientId → reason, matchedIds: Set }.
 */
export const buildAudience = async ({ tenantId, companyId, filters, exclusions = {}, category = 'UTILITY', policy, document, contacts }, now = new Date()) => {
  const rows = await loadClientSummaries({ tenantId, companyId, clientIds: filters.clientIds, sellerId: filters.sellerId }, now);

  let matched = rows.filter((row) => matchesMora(row.summary, filters.mora));
  if (filters.behavior) matched = matched.filter((row) => row.client.behavior === filters.behavior);
  if (filters.dueWithinDays) {
    // Calendar days in Bogotá: «vence en 3 días» includes the whole third day
    const lastDay = bogotaDay(new Date(now.getTime() + filters.dueWithinDays * DAY_MS));
    matched = matched.filter((row) => {
      const next = row.summary.nextQuota;
      return next && !next.overdue && next.dueDate && bogotaDay(next.dueDate) <= lastDay;
    });
  }
  if (filters.noPaymentThisMonth && matched.length) {
    const month = bogotaDay(now).slice(0, 7);
    const since = new Date(`${month}-01T00:00:00-05:00`);
    const paid = new Set((await PaymentAttempt.find({
      tenantId: toId(tenantId), companyId: toId(companyId), status: 'APROBADO',
      clientId: { $in: matched.map((row) => row.client._id) }, fechaPago: { $gte: since },
    }).distinct('clientId')).map(String));
    matched = matched.filter((row) => !paid.has(String(row.client._id)));
  }

  const ids = matched.map((row) => row.client._id);
  const [pending, promises, weekly, withReceipt] = await Promise.all([
    exclusions.pendingPayment === false || !ids.length ? [] : PaymentAttempt.find({
      tenantId: toId(tenantId), companyId: toId(companyId), status: 'PENDIENTE', clientId: { $in: ids },
    }).select('clientId appliedToQuotas quotaValue').lean(),
    exclusions.openPromise === false || !ids.length ? [] : CollectionAction.find({
      tenantId, companyId, clientId: { $in: ids }, 'promise.dueDate': { $gte: new Date(now.getTime() - 60 * DAY_MS) },
    }).lean(),
    contacts || (ids.length ? weeklyWhatsAppContacts({ tenantId, companyId, clientIds: ids }, now) : new Map()),
    document === 'recibo' && ids.length ? PaymentAttempt.find({
      tenantId: toId(tenantId), companyId: toId(companyId), status: 'APROBADO', clientId: { $in: ids },
    }).distinct('clientId') : null,
  ]);
  const inReview = new Set(pending.filter((p) => !isAppliedToQuotas(p)).map((p) => String(p.clientId)));
  const promised = new Set((promises.length ? await withPromiseStates(promises, { tenantId, companyId }, now) : [])
    .filter((a) => a.promiseState === 'vigente' || a.promiseState === 'en_revision')
    .map((a) => String(a.clientId)));
  const hasReceipt = withReceipt ? new Set(withReceipt.map(String)) : null;
  const weeklyLimit = policy?.weeklyLimit || 1;

  // The opt-out and the weekly limit belong to the number, not to one buyer: a couple sharing a
  // mobile is one person on WhatsApp. Every buyer of the project counts, also those outside this send
  const matchedPhones = new Set(matched.map((row) => mobilePhone(row.client.phone)).filter(Boolean));
  const sharing = matchedPhones.size
    ? (await Client.find({ tenantId: toId(tenantId), companyId: toId(companyId), phone: { $nin: [null, ''] } })
      .select('phone contactConsent.status').lean())
      .map((client) => ({ id: String(client._id), phone: mobilePhone(client.phone), optedOut: client.contactConsent?.status === 'baja' }))
      .filter((client) => client.phone && matchedPhones.has(client.phone))
    : [];
  const optedOutPhones = new Set(sharing.filter((client) => client.optedOut).map((client) => client.phone));
  const matchedIds = new Set(ids.map(String));
  const partnerIds = sharing.filter((client) => !matchedIds.has(client.id)).map((client) => client.id);
  const partnerWeekly = partnerIds.length ? await weeklyWhatsAppContacts({ tenantId, companyId, clientIds: partnerIds }, now) : new Map();
  const weeklyByPhone = new Map();
  for (const client of sharing) {
    const count = (weekly.get(client.id) || 0) + (partnerWeekly.get(client.id) || 0);
    if (count) weeklyByPhone.set(client.phone, (weeklyByPhone.get(client.phone) || 0) + count);
  }

  const excluded = {};
  const reasons = new Map();
  const recipients = [];
  const phones = new Set();
  for (const row of matched) {
    const id = String(row.client._id);
    const phone = mobilePhone(row.client.phone);
    const consent = row.client.contactConsent?.status || 'sin_registro';
    let reason = null;
    if (!phone) reason = 'no_phone';
    else if (phones.has(phone)) reason = 'duplicate_phone';
    else if (consent === 'baja' || optedOutPhones.has(phone)) reason = 'opted_out';
    else if (category === 'MARKETING' && consent !== 'autorizado') reason = 'no_consent';
    else if (hasReceipt && !hasReceipt.has(id)) reason = 'no_document';
    else if (inReview.has(id)) reason = 'pending_payment';
    else if (promised.has(id)) reason = 'open_promise';
    else if (Math.max(weekly.get(id) || 0, weeklyByPhone.get(phone) || 0) >= weeklyLimit) reason = 'weekly_limit';
    if (reason) {
      excluded[reason] = (excluded[reason] || 0) + 1;
      reasons.set(id, reason);
    } else {
      // One message per number: a couple sharing a mobile gets it once
      phones.add(phone);
      recipients.push({ ...row, phone });
    }
  }
  return { matched: matched.length, recipients, excluded, reasons, matchedIds: new Set(matched.map((row) => String(row.client._id))) };
};
