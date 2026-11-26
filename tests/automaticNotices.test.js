import 'dotenv/config';
import crypto from 'crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { generateAccessToken } from '../src/utils/jwt.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import PaymentAttempt from '../src/models/PaymentAttempt.js';
import ScheduledNotice from '../src/models/ScheduledNotice.js';
import Conversation from '../src/models/Conversation.js';
import Message from '../src/models/Message.js';
import AuditLog from '../src/models/AuditLog.js';
import { whatsappService } from '../src/services/whatsapp.service.js';
import { isWithinContactHours, resolveContactPolicy } from '../src/services/contactPolicy.service.js';
import {
  planQuotaReminders, processScheduledNotices, queuePaymentPlanNotice, queueRejectedPaymentNotice, resolveReminders, validateReminders,
} from '../src/services/automaticNotices.service.js';
import { DEFAULT_TEMPLATES, quotaNumberText } from '../src/services/whatsappTemplates.service.js';
import { projectAccountants } from '../src/services/commission.service.js';
import { mediaMessageText } from '../src/controllers/whatsapp.controller.js';

const stamp = Date.now();
const password = 'Password123!';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A weekday morning a few weeks ahead, inside the legal hours (never a Sunday or a holiday)
const firstOpenMorning = (from) => {
  let at = new Date(from);
  while (!isWithinContactHours(at, resolveContactPolicy()) || new Date(at.getTime() - 5 * HOUR).getUTCHours() !== 10) at = new Date(at.getTime() + HOUR);
  return at;
};
const NOW = firstOpenMorning(Date.now() + 21 * DAY);
const SUNDAY = (() => {
  let at = new Date(NOW.getTime() + DAY);
  while (new Date(at.getTime() - 5 * HOUR).getUTCDay() !== 0) at = new Date(at.getTime() + DAY);
  return at;
})();
const fromNow = (days) => new Date(NOW.getTime() + days * DAY);

const bodyOf = (components) => components.find((c) => c.type === 'body').parameters.map((p) => p.text);

describe('Automatic WhatsApp notices (plan, reminders, rejected payment)', () => {
  let org;
  let otherCompany;
  const sent = [];
  const original = {};
  const buyers = {};

  const buyer = async (key, phone, extra = {}) => {
    const client = await Client.create({ tenantId: org.tenantId, companyId: org.companyId, name: `Comprador ${key}`, idNumber: `N${key}${stamp}`, phone, ...extra });
    const contract = await Contract.create({ tenantId: org.tenantId, companyId: org.companyId, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 1000000 });
    buyers[key] = { client, contract };
    return buyers[key];
  };
  const quota = (key, dueInDays, extra = {}) => Quota.create({
    tenantId: org.tenantId, companyId: org.companyId, contract: buyers[key].contract._id, number: 4, type: 'normal', value: 300000,
    status: 'pendiente', dueDate: fromNow(dueInDays), ...extra,
  });
  const company = () => Company.findById(org.companyId);

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner notices', fullName: 'Owner notices', email: `owner.${stamp}@notices.test`, password, confirmPassword: password,
      tenantName: `Tenant notices ${stamp}`, companyName: `Company notices ${stamp}`,
    });
    org = { token: res.body.data.accessToken, companyId: String(res.body.data.company._id), tenantId: String(res.body.data.company.tenantId) };
    await Company.updateOne({ _id: org.companyId }, {
      slug: `notices-${stamp}`,
      'integrations.whatsappConnectedAt': new Date(), 'integrations.whatsappAccessToken': 'token', 'integrations.whatsappPhoneId': `nphone${stamp}`,
      reminders: { enabled: true, daysBefore: 3 },
    });
    otherCompany = await Company.create({ tenantId: org.tenantId, name: `Otro proyecto ${stamp}`, slug: `otro-${stamp}` });

    original.sendTemplateMessage = whatsappService.sendTemplateMessage;
    original.notifications = process.env.ENABLE_NOTIFICATIONS;
    original.secret = process.env.META_APP_SECRET;
    process.env.ENABLE_NOTIFICATIONS = 'true';
    whatsappService.sendTemplateMessage = async (account, to, name, language, components) => {
      sent.push({ to, name, components });
      return { messages: [{ id: `wamid.n${sent.length}.${stamp}` }] };
    };

    await buyer('soon', '3002220001');
    await quota('soon', 2);
    await buyer('late', '3002220002');
    await quota('late', -8);
    await buyer('ancient', '3002220003');
    await quota('ancient', -100);
    await buyer('optout', '3002220004', { contactConsent: { status: 'baja' } });
    await quota('optout', -1);
    await buyer('paid', '3002220005');
    await quota('paid', -1, { status: 'pagado', amountPaid: 300000 });
  });

  afterAll(async () => {
    whatsappService.sendTemplateMessage = original.sendTemplateMessage;
    if (original.notifications === undefined) delete process.env.ENABLE_NOTIFICATIONS; else process.env.ENABLE_NOTIFICATIONS = original.notifications;
    if (original.secret === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = original.secret;
    const tenantIds = [org?.tenantId].filter(Boolean);
    const conversations = await Conversation.find({ tenantId: { $in: tenantIds.map(String) } }).select('_id').lean();
    await Message.deleteMany({ conversationId: { $in: conversations.map((c) => c._id) } });
    await Conversation.deleteMany({ tenantId: { $in: tenantIds.map(String) } });
    await ScheduledNotice.deleteMany({ tenantId: { $in: tenantIds } });
    await PaymentAttempt.deleteMany({ tenantId: { $in: tenantIds } });
    await Quota.deleteMany({ tenantId: { $in: tenantIds } });
    await Contract.deleteMany({ tenantId: { $in: tenantIds } });
    await Client.deleteMany({ tenantId: { $in: tenantIds } });
    await AuditLog.deleteMany({ tenantId: { $in: tenantIds } });
    await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
    await User.deleteMany({ tenantId: { $in: tenantIds } });
    await Company.deleteMany({ tenantId: { $in: tenantIds } });
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    await UserAccount.deleteMany({ email: /notices\.test$/ });
  });

  it('numbers initial quotas apart from ordinary ones', () => {
    expect(quotaNumberText({ type: 'normal', number: 5 })).toBe('5');
    expect(quotaNumberText({ type: 'inicial', number: 2 })).toBe('inicial 2');
    expect(quotaNumberText({ type: 'inicial', number: 0 })).toBe('de separación');
  });

  it('keeps reminders off by default and only accepts the offered days', () => {
    expect(resolveReminders()).toEqual({ enabled: false, daysBefore: 3 });
    expect(() => validateReminders({ daysBefore: 4 })).toThrow();
    expect(validateReminders({ enabled: true, daysBefore: 5 })).toEqual({ enabled: true, daysBefore: 5 });
  });

  it('has a template for the team commission notice', () => {
    expect(DEFAULT_TEMPLATES.operix_aviso_comision.category).toBe('UTILITY');
  });

  it('plans one reminder per quota and step, never for old debts, paid quotas or twice', async () => {
    const queued = await planQuotaReminders(await company(), NOW);
    expect(queued).toBe(3);
    expect(await planQuotaReminders(await company(), NOW)).toBe(0);
    const notices = await ScheduledNotice.find({ companyId: org.companyId }).lean();
    const byClient = Object.fromEntries(notices.map((n) => [String(n.clientId), n.notice]));
    expect(byClient[String(buyers.soon.client._id)]).toBe('cuota_por_vencer');
    expect(byClient[String(buyers.late.client._id)]).toBe('cuota_vencida');
    expect(byClient[String(buyers.optout.client._id)]).toBe('cuota_vencida');
    expect(byClient[String(buyers.ancient.client._id)]).toBeUndefined();
    expect(byClient[String(buyers.paid.client._id)]).toBeUndefined();
    expect(notices.every((n) => n.collection)).toBe(true);
  });

  it('waits outside the contact hours and sends inside them, skipping opted-out buyers', async () => {
    sent.length = 0;
    await processScheduledNotices(() => SUNDAY);
    expect(sent).toHaveLength(0);

    await processScheduledNotices(() => NOW);
    const names = sent.map((s) => s.name).sort();
    expect(names).toEqual(['operix_cuota_por_vencer', 'operix_cuota_vencida']);
    const soon = sent.find((s) => s.name === 'operix_cuota_por_vencer');
    expect(soon.to).toBe('+573002220001');
    expect(bodyOf(soon.components).slice(0, 2)).toEqual(['Comprador soon', '4']);
    expect(bodyOf(soon.components)[3]).toBe('$300.000');
    expect(soon.components.find((c) => c.type === 'button').parameters[0].text).toBe(`notices-${stamp}/payments`);

    const optedOut = await ScheduledNotice.findOne({ clientId: buyers.optout.client._id }).lean();
    expect(optedOut).toMatchObject({ status: 'skipped', skipReason: 'opted_out' });
    const late = await ScheduledNotice.findOne({ clientId: buyers.late.client._id }).lean();
    expect(late.status).toBe('sent');
    expect(late.waMessageId).toMatch(/^wamid\.n/);
  });

  it('keeps the weekly limit of Ley 2300 across reminders', async () => {
    const another = await quota('late', -15, { number: 5 });
    await ScheduledNotice.create({
      tenantId: org.tenantId, companyId: org.companyId, clientId: buyers.late.client._id, contractId: buyers.late.contract._id, quotaId: another._id,
      notice: 'cuota_vencida', key: `test:${another._id}`, collection: true, scheduledAt: NOW,
    });
    sent.length = 0;
    await processScheduledNotices(() => NOW);
    expect(sent).toHaveLength(0);
    const skipped = await ScheduledNotice.findOne({ key: `test:${another._id}` }).lean();
    expect(skipped).toMatchObject({ status: 'skipped', skipReason: 'weekly_limit' });
  });

  it('tells the buyer why a reported payment was rejected, through the API', async () => {
    const attempt = await PaymentAttempt.create({
      tenantId: org.tenantId, companyId: org.companyId, contractId: buyers.soon.contract._id, clientId: buyers.soon.client._id,
      amount: 250000, banco: 'Banco', paymentMethod: 'transferencia', fechaPago: fromNow(-1), status: 'PENDIENTE', appliedToQuotas: false, quotaValue: 300000,
    });
    const res = await request(app).put(`/api/payments/${attempt._id}/reject?companyId=${org.companyId}`)
      .set('Authorization', `Bearer ${org.token}`).send({ rejectedReason: 'El comprobante no es legible.' });
    expect(res.statusCode).toBe(200);
    const notice = await ScheduledNotice.findOne({ paymentAttemptId: attempt._id }).lean();
    expect(notice).toMatchObject({ notice: 'pago_rechazado', collection: false, status: 'queued' });
    expect(notice.values).toMatchObject({ amount: '$250.000', reason: 'El comprobante no es legible' });
    // Never twice for the same payment
    expect(await queueRejectedPaymentNotice(await PaymentAttempt.findById(attempt._id))).toBeNull();

    sent.length = 0;
    await processScheduledNotices(() => NOW);
    // Not a collection message: the weekly limit does not hold it back
    const rejected = sent.find((s) => s.name === 'operix_pago_rechazado');
    expect(bodyOf(rejected.components)).toEqual(['Comprador soon', expect.any(String), '$250.000', expect.any(String), 'El comprobante no es legible']);
  });

  it('sends the payment plan with its PDF', async () => {
    const quotas = [await quota('ancient', 30, { number: 1 }), await quota('ancient', 60, { number: 2 })];
    const queued = await queuePaymentPlanNotice({ company: await company(), client: buyers.ancient.client, contract: buyers.ancient.contract, quotas });
    expect(queued.values.quotaCount).toBe('2');
    sent.length = 0;
    await processScheduledNotices(() => NOW);
    const plan = sent.find((s) => s.name === 'operix_plan_pagos');
    expect(plan.components.find((c) => c.type === 'header').parameters[0].document.filename).toBe('Plan de pagos.pdf');
    expect(bodyOf(plan.components)[0]).toBe('Comprador ancient');
  });

  it('turns reminders on from the contact rules, only with CONFIG_TENANT', async () => {
    const res = await request(app).put(`/api/campaigns/policy?companyId=${org.companyId}`)
      .set('Authorization', `Bearer ${org.token}`).send({ reminders: { enabled: false, daysBefore: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.reminders).toMatchObject({ enabled: false, daysBefore: 5 });
    const bad = await request(app).put(`/api/campaigns/policy?companyId=${org.companyId}`)
      .set('Authorization', `Bearer ${org.token}`).send({ reminders: { daysBefore: 9 } });
    expect(bad.statusCode).toBe(400);
  });

  it('never deletes the templates of the automatic notices', async () => {
    const res = await request(app).delete(`/api/whatsapp/templates/operix_pago_recibido?companyId=${org.companyId}`)
      .set('Authorization', `Bearer ${org.token}`);
    expect(res.statusCode).toBe(403);
  });

  it('tells the accountants of the commission project only', async () => {
    const member = async (companyId, tag) => {
      const account = await UserAccount.create({ email: `${tag}.${stamp}@notices.test`, passwordHash: password, fullName: `Contador ${tag}`, status: 'active' });
      const user = await User.create({ accountId: account._id, tenantId: org.tenantId, role: 'contador', status: 'active' });
      await UserCompany.create({ userId: user._id, companyId, tenantId: org.tenantId, role: 'contador' });
      return generateAccessToken({ accountId: account._id, userId: user._id, tenantId: org.tenantId, role: 'contador', companies: [String(companyId)] });
    };
    await member(org.companyId, 'here');
    await member(otherCompany._id, 'there');
    const accountants = await projectAccountants({ tenantId: org.tenantId, companyId: org.companyId });
    expect(accountants.map((a) => a.accountId.fullName)).toEqual(['Contador here']);
  });

  it('says what a photo or an audio is instead of its type', () => {
    expect(mediaMessageText({ type: 'image', image: { caption: 'comprobante' } })).toMatch(/^📎 Foto: comprobante/);
    expect(mediaMessageText({ type: 'audio', audio: { voice: true } })).toMatch(/^📎 Nota de voz/);
    expect(mediaMessageText({ type: 'document', document: { filename: 'recibo.pdf' } })).toMatch(/Documento: recibo\.pdf/);
    expect(mediaMessageText({ type: 'reaction', reaction: { emoji: '👍' } })).toBe('Reacción: 👍');
  });

  it('keeps a message from a number that is not a buyer and has no chat', async () => {
    process.env.META_APP_SECRET = 'app-secret-for-notice-tests';
    const from = `57315${String(stamp).slice(-7)}`;
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { metadata: { phone_number_id: `nphone${stamp}` }, messages: [{ from, id: `wamid.in.${stamp}`, type: 'text', text: { body: 'Hola, quiero información' } }] } }] }],
    });
    const signature = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex')}`;
    const res = await request(app).post('/api/whatsapp/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(raw);
    expect(res.statusCode).toBe(200);
    let conv = null;
    for (let i = 0; i < 40 && !conv; i += 1) {
      conv = await Conversation.findOne({ tenantId: org.tenantId, waId: from }).lean();
      if (!conv) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(conv).toMatchObject({ lastMessage: 'Hola, quiero información', unreadCount: 1 });
    expect(conv.clientId).toBeUndefined();
  });
});
