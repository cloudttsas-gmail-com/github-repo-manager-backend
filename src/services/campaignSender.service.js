import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import Client from '../models/Client.js';
import Company from '../models/Company.js';
import { whatsappService } from './whatsapp.service.js';
import { companyWhatsAppAccount } from './whatsappTemplates.service.js';
import { campaignTemplates, lastPayments, recipientValues, sendComponents } from './campaignTemplates.service.js';
import { loadClientSummaries } from './campaignAudience.service.js';
import { isWithinContactHours, nextContactWindow, resolveContactPolicy, weeklyWhatsAppContacts } from './contactPolicy.service.js';

const BATCH = 25;
const WORKER_INTERVAL_MS = 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
let running = false;
let timer = null;

const finish = (campaign) => Campaign.updateOne({ _id: campaign._id, status: 'sending' }, { status: 'sent', finishedAt: new Date() });

/** Marks every recipient still waiting with a reason, when the send can't go on. */
const failQueued = async (campaign, reason) => {
  await CampaignRecipient.updateMany({ campaignId: campaign._id, status: { $in: ['queued', 'sending'] } }, { status: 'failed', error: reason });
  await finish(campaign);
};

/** Takes up to BATCH waiting recipients, one atomic claim each so two workers never send twice. */
const claimBatch = async (campaignId) => {
  const claimed = [];
  for (let i = 0; i < BATCH; i += 1) {
    const recipient = await CampaignRecipient.findOneAndUpdate({ campaignId, status: 'queued' }, { status: 'sending' }, { new: true, sort: { _id: 1 } }).lean();
    if (!recipient) break;
    claimed.push(recipient);
  }
  return claimed;
};

/**
 * Sends the next batches of one campaign while its project's contact hours last. Opt-outs and the
 * weekly limit are checked again for each buyer, and the template data are worked out now.
 */
export const sendCampaignBatches = async (campaign, now = () => new Date()) => {
  const company = await Company.findById(campaign.companyId);
  const account = companyWhatsAppAccount(company);
  if (!account) return failQueued(campaign, 'El proyecto no tiene un número de WhatsApp conectado');
  const policy = resolveContactPolicy(company.contactPolicy);

  let template;
  try {
    template = (await campaignTemplates(company)).find((t) => t.name === campaign.template.name && t.language === campaign.template.language);
  } catch (error) {
    // Meta did not answer: try again on the next round
    console.error('[CAMPAIGNS] templates could not be read:', error.message);
    return null;
  }
  if (!template?.usable) return failQueued(campaign, template?.reason || 'La plantilla ya no existe en Meta');

  const scope = { tenantId: new mongoose.Types.ObjectId(String(campaign.tenantId)), companyId: new mongoose.Types.ObjectId(String(campaign.companyId)) };
  for (;;) {
    if (!isWithinContactHours(now(), policy)) return null;
    const current = await Campaign.findById(campaign._id).select('status').lean();
    if (current?.status !== 'sending') return null;

    const batch = await claimBatch(campaign._id);
    if (!batch.length) return finish(campaign);

    const clientIds = batch.map((r) => r.clientId);
    const [clients, summaries, contacts, payments] = await Promise.all([
      Client.find({ _id: { $in: clientIds } }).select('contactConsent').lean(),
      loadClientSummaries({ ...scope, clientIds }, now()),
      weeklyWhatsAppContacts({ ...scope, clientIds }, now()),
      lastPayments({ ...scope, clientIds }),
    ]);
    const consentOf = new Map(clients.map((c) => [String(c._id), c.contactConsent?.status]));
    const summaryOf = new Map(summaries.map((s) => [String(s.client._id), s]));

    for (const recipient of batch) {
      const id = String(recipient.clientId);
      const row = summaryOf.get(id);
      let skipReason = null;
      if (consentOf.get(id) === 'baja') skipReason = 'opted_out';
      else if (campaign.template.category === 'MARKETING' && consentOf.get(id) !== 'autorizado') skipReason = 'no_consent';
      else if ((contacts.get(id) || 0) >= policy.weeklyLimit) skipReason = 'weekly_limit';
      else if (!row) skipReason = 'no_contract';
      if (skipReason) {
        await CampaignRecipient.updateOne({ _id: recipient._id }, { status: 'skipped', skipReason });
        continue;
      }
      try {
        const ctx = { contract: row.contract, lastPayment: payments.get(id), apiUrl: process.env.API_URL || '' };
        const values = { ...recipientValues({ company, client: row.client, ...ctx, summary: row.summary }), ...(campaign.values || {}) };
        const data = await whatsappService.sendTemplateMessage(account, recipient.phone, template.name, template.language, sendComponents(template, values, ctx));
        await CampaignRecipient.updateOne({ _id: recipient._id }, {
          status: 'sent', sentAt: new Date(), waMessageId: data?.messages?.[0]?.id, contractId: row.contract._id,
        });
        contacts.set(id, (contacts.get(id) || 0) + 1);
      } catch (error) {
        await CampaignRecipient.updateOne({ _id: recipient._id }, { status: 'failed', error: String(error.message).slice(0, 500) });
      }
    }
  }
};

/**
 * One round of the queue: scheduled sends whose time came start, and sends in progress go on.
 * Outside a project's contact hours a send waits for the next window.
 */
export const processCampaigns = async (now = () => new Date()) => {
  if (process.env.ENABLE_NOTIFICATIONS !== 'true') return;
  if (running) return;
  running = true;
  try {
    // A message claimed by a round that died never knows whether Meta got it: say so instead of resending
    await CampaignRecipient.updateMany(
      { status: 'sending', updatedAt: { $lt: new Date(now().getTime() - STALE_MS) } },
      { status: 'failed', error: 'El envío se interrumpió; puede que no haya llegado' },
    );
    const due = await Campaign.find({ status: { $in: ['scheduled', 'sending'] }, scheduledAt: { $lte: now() } }).sort({ scheduledAt: 1 }).lean();
    for (const campaign of due) {
      const company = await Company.findById(campaign.companyId).select('contactPolicy').lean();
      const policy = resolveContactPolicy(company?.contactPolicy);
      if (!isWithinContactHours(now(), policy)) {
        const next = nextContactWindow(now(), policy);
        if (campaign.status === 'scheduled' && next) await Campaign.updateOne({ _id: campaign._id, status: 'scheduled' }, { scheduledAt: next });
        continue;
      }
      if (campaign.status === 'scheduled') {
        const started = await Campaign.findOneAndUpdate({ _id: campaign._id, status: 'scheduled' }, { status: 'sending', startedAt: new Date() }, { new: true }).lean();
        if (!started) continue;
      }
      await sendCampaignBatches({ ...campaign, status: 'sending' }, now);
    }
  } catch (error) {
    console.error('[CAMPAIGNS] queue round failed:', error.message);
  } finally {
    running = false;
  }
};

/** Starts the queue: one round a minute (no other scheduler exists in the API). */
export const startCampaignWorker = () => {
  if (timer) return;
  timer = setInterval(() => { processCampaigns(); }, WORKER_INTERVAL_MS);
  timer.unref?.();
};

/** Runs a round right away (after «Enviar ahora»), without waiting for the minute. */
export const kickCampaigns = () => { setImmediate(() => { processCampaigns(); }); };
