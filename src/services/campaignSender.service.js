import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import Company from '../models/Company.js';
import { whatsappService } from './whatsapp.service.js';
import { agencyName } from '../utils/agency.js';
import { companyWhatsAppAccount } from './whatsappTemplates.service.js';
import { campaignTemplates, lastPayments, recipientValues, sendComponents } from './campaignTemplates.service.js';
import { buildAudience } from './campaignAudience.service.js';
import { isWithinContactHours, nextContactWindow, resolveContactPolicy, weeklyWhatsAppContacts } from './contactPolicy.service.js';

const BATCH = 25;
// Messages a send may take in one round, so a big send never holds back the others
const MAX_PER_ROUND = 200;
const WORKER_INTERVAL_MS = 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
let running = false;
let timer = null;

// How Meta's template states read on a send that waits for them
const TEMPLATE_STATUS_LABELS = {
  PAUSED: 'en pausa', PENDING: 'en revisión', IN_APPEAL: 'en apelación', REJECTED: 'rechazada', DISABLED: 'desactivada', PENDING_DELETION: 'por borrar',
};

const finish = (campaign) => Campaign.updateOne({ _id: campaign._id, status: 'sending' }, { status: 'sent', finishedAt: new Date(), notice: null });

/** Marks every recipient still waiting with a reason, when the send can't go on. */
const failQueued = async (campaign, reason) => {
  await CampaignRecipient.updateMany({ campaignId: campaign._id, status: { $in: ['queued', 'sending'] } }, { status: 'failed', error: reason, sentAt: null });
  await finish(campaign);
};

/** Shown on the send while it waits for something outside Operix (Meta paused the template…) */
const setNotice = (campaign, notice) => Campaign.updateOne({ _id: campaign._id }, { notice });

/**
 * Takes up to `size` waiting recipients, one atomic claim each so two workers never send twice.
 * The claim already sets `sentAt`: a message whose fate is unknown (the process died) still counts
 * for the weekly limit.
 */
const claimBatch = async (campaignId, size) => {
  const claimed = [];
  for (let i = 0; i < size; i += 1) {
    const recipient = await CampaignRecipient.findOneAndUpdate(
      { campaignId, status: 'queued' },
      { status: 'sending', sentAt: new Date() },
      { new: true, sort: { _id: 1 } },
    ).lean();
    if (!recipient) break;
    claimed.push(recipient);
  }
  return claimed;
};

const skip = (recipient, skipReason) => CampaignRecipient.updateOne({ _id: recipient._id }, { status: 'skipped', skipReason, sentAt: null });

/**
 * Sends the next batches of one campaign while its project's contact hours last, up to MAX_PER_ROUND
 * messages. Each batch applies the send's filters and exclusions again with current data (a buyer who
 * paid, reported a payment or promised since it was created is skipped), and the template's category
 * is the one Meta has today.
 */
export const sendCampaignBatches = async (campaign, now = () => new Date()) => {
  const company = await Company.findById(campaign.companyId);
  const account = companyWhatsAppAccount(company);
  if (!account) return failQueued(campaign, 'El proyecto no tiene un número de WhatsApp conectado');
  const policy = resolveContactPolicy(company.contactPolicy);
  const agency = await agencyName(company);

  let template;
  try {
    const templates = await campaignTemplates(company);
    template = templates.find((t) => t.name === campaign.template.name && t.language === campaign.template.language);
  } catch (error) {
    // Meta did not answer: try again on the next round
    console.error('[CAMPAIGNS] templates could not be read:', error.message);
    return null;
  }
  if (!template) return failQueued(campaign, 'La plantilla ya no existe en Meta');
  if (!template.usable) {
    // Paused or in review again: wait for Meta instead of failing the whole send
    if (template.status !== 'APPROVED') return setNotice(campaign, `Meta tiene la plantilla ${TEMPLATE_STATUS_LABELS[template.status] || 'sin aprobar'}; el envío sigue cuando vuelva a estar aprobada.`);
    return failQueued(campaign, template.reason);
  }
  if (campaign.notice) await setNotice(campaign, null);

  const scope = { tenantId: new mongoose.Types.ObjectId(String(campaign.tenantId)), companyId: new mongoose.Types.ObjectId(String(campaign.companyId)) };
  const isCancelled = async () => (await Campaign.findById(campaign._id).select('status').lean())?.status !== 'sending';
  let sentThisRound = 0;

  while (sentThisRound < MAX_PER_ROUND) {
    if (!isWithinContactHours(now(), policy)) return null;
    if (await isCancelled()) return null;

    const batch = await claimBatch(campaign._id, Math.min(BATCH, MAX_PER_ROUND - sentThisRound));
    if (!batch.length) return finish(campaign);

    const clientIds = batch.map((r) => r.clientId);
    // This batch's own claims carry sentAt already: leave them out of the weekly count
    const contacts = await weeklyWhatsAppContacts({ ...scope, clientIds, excludeCampaignId: campaign._id }, now());
    const [audience, payments] = await Promise.all([
      buildAudience({
        ...scope,
        filters: { ...campaign.filters, clientIds: clientIds.map(String) },
        exclusions: campaign.exclusions || {},
        category: template.category,
        policy,
        document: template.media?.source,
        contacts,
      }, now()),
      lastPayments({ ...scope, clientIds }),
    ]);
    const rowOf = new Map(audience.recipients.map((row) => [String(row.client._id), row]));

    for (const recipient of batch) {
      const id = String(recipient.clientId);
      if (await isCancelled()) {
        await CampaignRecipient.updateOne({ _id: recipient._id, status: 'sending' }, { status: 'cancelled', sentAt: null });
        continue;
      }
      const row = rowOf.get(id);
      if (!row) {
        await skip(recipient, audience.reasons.get(id) || (audience.matchedIds.has(id) ? 'excluded' : 'no_longer_matches'));
        continue;
      }
      try {
        const ctx = { contract: row.contract, lastPayment: payments.get(id), apiUrl: process.env.API_URL || '' };
        const values = { ...recipientValues({ company, agency, client: row.client, ...ctx, summary: row.summary }), ...(campaign.values || {}) };
        const data = await whatsappService.sendTemplateMessage(account, row.phone, template.name, template.language, sendComponents(template, values, ctx));
        await CampaignRecipient.updateOne({ _id: recipient._id }, {
          status: 'sent', sentAt: new Date(), waMessageId: data?.messages?.[0]?.id, contractId: row.contract._id, phone: row.phone,
        });
        sentThisRound += 1;
      } catch (error) {
        // Meta refused it: it never reached the buyer, so it doesn't count for the weekly limit
        await CampaignRecipient.updateOne({ _id: recipient._id }, { status: 'failed', error: String(error.message).slice(0, 500), sentAt: null });
      }
    }
  }
  return null;
};

/**
 * One round of the queue: scheduled sends whose time came start, and sends in progress go on, each
 * up to MAX_PER_ROUND messages. Outside a project's contact hours a send waits for the next window.
 */
export const processCampaigns = async (now = () => new Date()) => {
  if (process.env.ENABLE_NOTIFICATIONS !== 'true') return;
  if (running) return;
  running = true;
  try {
    // A message claimed by a round that died never knows whether Meta got it: say so instead of resending
    await CampaignRecipient.updateMany(
      { status: 'sending', updatedAt: { $lt: new Date(now().getTime() - STALE_MS) } },
      { status: 'failed', error: 'El envío se interrumpió; puede que haya llegado' },
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
      try {
        await sendCampaignBatches({ ...campaign, status: 'sending' }, now);
      } catch (error) {
        console.error('[CAMPAIGNS] a send failed this round:', error.message);
      }
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
