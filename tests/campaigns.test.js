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
import CollectionAction from '../src/models/CollectionAction.js';
import Campaign from '../src/models/Campaign.js';
import CampaignRecipient from '../src/models/CampaignRecipient.js';
import AuditLog from '../src/models/AuditLog.js';
import { whatsappService } from '../src/services/whatsapp.service.js';
import { processCampaigns } from '../src/services/campaignSender.service.js';
import { analyzeTemplate } from '../src/services/campaignTemplates.service.js';
import {
  colombianHolidays, isWithinContactHours, nextContactWindow, resolveContactPolicy, startOfBogotaWeek, validateContactPolicy,
} from '../src/services/contactPolicy.service.js';

const stamp = Date.now();
const password = 'Password123!';
const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n) => new Date(Date.now() + n * DAY);
const bogota = (iso) => new Date(`${iso}-05:00`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const register = async (tag) => {
  const res = await request(app).post('/api/auth/register').send({
    name: `Owner ${tag}`, fullName: `Owner ${tag}`, email: `owner.${tag}.${stamp}@camp.test`,
    password, confirmPassword: password,
    tenantName: `Tenant camp ${tag} ${stamp}`, companyName: `Company camp ${tag} ${stamp}`,
  });
  const company = res.body.data.company;
  return { token: res.body.data.accessToken, companyId: String(company._id), tenantId: String(company.tenantId) };
};

const addMember = async (org, role, tag) => {
  const account = await UserAccount.create({ email: `${tag}.${stamp}@camp.test`, passwordHash: password, fullName: `Miembro ${tag}`, status: 'active' });
  const user = await User.create({ accountId: account._id, tenantId: org.tenantId, role, status: 'active' });
  await UserCompany.create({ userId: user._id, companyId: org.companyId, tenantId: org.tenantId, role });
  return generateAccessToken({ accountId: account._id, userId: user._id, tenantId: org.tenantId, role, companies: [org.companyId] });
};

const TEMPLATES = [
  {
    name: 'recordatorio_mora', language: 'es', status: 'APPROVED', category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hola {{nombre_comprador}}, tu cuota de {{valor_cuota}} lleva {{dias_mora}} días vencida.' }],
  },
  {
    name: 'promo_feria', language: 'es', status: 'APPROVED', category: 'MARKETING',
    components: [{ type: 'BODY', text: 'Hola {{nombre_comprador}}, te invitamos a la feria.' }],
  },
  { name: 'operix_cuota_vencida', language: 'es', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola {{1}}' }] },
  { name: 'pendiente_meta', language: 'es', status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola' }] },
];

describe('Contact policy (Ley 2300 defaults)', () => {
  const policy = resolveContactPolicy();

  it('knows the Colombian holidays of 2026', () => {
    const expected = ['0-1', '0-12', '2-23', '3-2', '3-3', '4-1', '4-18', '5-8', '5-15', '5-29', '6-20', '7-7', '7-17', '9-12', '10-2', '10-16', '11-8', '11-25'];
    expect([...colombianHolidays(2026)].map((k) => k.slice(5)).sort()).toEqual(expected.sort());
  });

  it('allows weekdays 7-19 and Saturdays 8-15, never Sundays or holidays', () => {
    expect(isWithinContactHours(bogota('2026-11-18T10:00:00'), policy)).toBe(true);
    expect(isWithinContactHours(bogota('2026-11-18T19:00:00'), policy)).toBe(false);
    expect(isWithinContactHours(bogota('2026-11-18T06:59:00'), policy)).toBe(false);
    expect(isWithinContactHours(bogota('2026-11-21T14:30:00'), policy)).toBe(true);
    expect(isWithinContactHours(bogota('2026-11-21T15:00:00'), policy)).toBe(false);
    expect(isWithinContactHours(bogota('2026-11-22T10:00:00'), policy)).toBe(false);
    // 16 Nov 2026 is a holiday (Independencia de Cartagena, moved to Monday)
    expect(isWithinContactHours(bogota('2026-11-16T10:00:00'), policy)).toBe(false);
  });

  it('waits for the next window: Saturday afternoon → Tuesday 7:00 when Monday is a holiday', () => {
    expect(nextContactWindow(bogota('2026-11-14T16:00:00'), policy)).toEqual(bogota('2026-11-17T07:00:00'));
    expect(nextContactWindow(bogota('2026-11-18T20:00:00'), policy)).toEqual(bogota('2026-11-19T07:00:00'));
    const now = bogota('2026-11-18T10:00:00');
    expect(nextContactWindow(now, policy)).toBe(now);
  });

  it('starts the week on Monday in Bogotá and validates edits', () => {
    expect(startOfBogotaWeek(bogota('2026-11-22T23:00:00'))).toEqual(bogota('2026-11-16T00:00:00'));
    expect(() => validateContactPolicy({ weekdayStart: 20, weekdayEnd: 8 })).toThrow();
    expect(() => validateContactPolicy({ weeklyLimit: 0 })).toThrow();
    expect(validateContactPolicy({ weeklyLimit: 2, allowSundays: 'yes' })).toEqual({ weeklyLimit: 2, allowSundays: true });
  });
});

describe('Templates a send can use', () => {
  it('fills only Operix named data and says why the rest cannot be used', () => {
    expect(analyzeTemplate(TEMPLATES[0]).usable).toBe(true);
    expect(analyzeTemplate(TEMPLATES[0]).variables).toEqual(['nombre_comprador', 'valor_cuota', 'dias_mora']);
    expect(analyzeTemplate(TEMPLATES[2]).reason).toMatch(/aviso automático/);
    expect(analyzeTemplate(TEMPLATES[3]).reason).toMatch(/aprobada/);
    expect(analyzeTemplate({ ...TEMPLATES[0], name: 'x', components: [{ type: 'BODY', text: 'Hola {{1}}' }] }).reason).toMatch(/numerados/);
    expect(analyzeTemplate({ ...TEMPLATES[0], name: 'y', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hola' }] }).reason).toMatch(/archivo/);
    expect(analyzeTemplate({
      ...TEMPLATES[0], name: 'z', components: [{ type: 'BODY', text: 'Hola' }, { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.co/{{1}}' }] }],
    }).reason).toMatch(/enlace variable/);
    expect(analyzeTemplate({ ...TEMPLATES[0], name: 'c', components: [{ type: 'BODY', text: 'Hola' }, { type: 'CAROUSEL', cards: [] }] }).reason).toMatch(/carrusel/);
  });
});

describe('Sends (/api/campaigns)', () => {
  let a;
  let seller;
  let cartera;
  const buyers = {};
  const q = () => `companyId=${a.companyId}`;
  const original = {};
  const sent = [];

  const buyer = async (key, phone, extra = {}) => {
    const client = await Client.create({ tenantId: a.tenantId, companyId: a.companyId, name: `Comprador ${key}`, idNumber: `C${key}${stamp}`, phone, ...extra });
    const contract = await Contract.create({ tenantId: a.tenantId, companyId: a.companyId, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 1000000 });
    buyers[key] = { client, contract };
    return { client, contract };
  };
  const quota = (key, dueInDays, extra = {}) => Quota.create({
    tenantId: a.tenantId, companyId: a.companyId, contract: buyers[key].contract._id, number: 1, type: 'normal', value: 200000, status: 'pendiente', dueDate: daysFromNow(dueInDays), ...extra,
  });

  beforeAll(async () => {
    a = await register('a');
    seller = await addMember(a, 'vendedor', 'seller');
    cartera = await addMember(a, 'jefe_cartera', 'cartera');
    await Company.updateOne({ _id: a.companyId }, {
      'integrations.whatsappConnectedAt': new Date(), 'integrations.whatsappAccessToken': 'token', 'integrations.whatsappPhoneId': `phone${stamp}`,
    });

    original.getTemplates = whatsappService.getTemplates;
    original.sendTemplateMessage = whatsappService.sendTemplateMessage;
    original.notifications = process.env.ENABLE_NOTIFICATIONS;
    original.secret = process.env.META_APP_SECRET;
    whatsappService.getTemplates = async () => TEMPLATES;
    whatsappService.sendTemplateMessage = async (account, to, name, language, components) => {
      sent.push({ to, name, components });
      return { messages: [{ id: `wamid.${sent.length}.${stamp}` }] };
    };

    await buyer('late', '3001110001');
    await quota('late', -20);
    await buyer('ontime', '3001110002');
    await quota('ontime', 5);
    await buyer('nophone', '12345');
    await quota('nophone', -10);
    await buyer('optout', '3001110004', { contactConsent: { status: 'baja' } });
    await quota('optout', -10);
    await buyer('review', '3001110005');
    await quota('review', -10);
    await PaymentAttempt.create({
      tenantId: a.tenantId, companyId: a.companyId, contractId: buyers.review.contract._id, clientId: buyers.review.client._id,
      amount: 1000, banco: 'Banco', paymentMethod: 'transferencia', fechaPago: new Date(), status: 'PENDIENTE', appliedToQuotas: false, quotaValue: 200000,
    });
    await buyer('promise', '3001110006');
    await quota('promise', -10);
    await CollectionAction.create({
      tenantId: a.tenantId, companyId: a.companyId, clientId: buyers.promise.client._id, channel: 'llamada', result: 'promesa',
      promise: { amount: 200000, dueDate: daysFromNow(3) }, createdBy: new mongoose.Types.ObjectId(),
    });
    await buyer('contacted', '3001110007');
    await quota('contacted', -10);
    await CollectionAction.create({
      tenantId: a.tenantId, companyId: a.companyId, clientId: buyers.contacted.client._id, channel: 'whatsapp', result: 'contactado', createdBy: new mongoose.Types.ObjectId(),
    });
  });

  afterAll(async () => {
    whatsappService.getTemplates = original.getTemplates;
    whatsappService.sendTemplateMessage = original.sendTemplateMessage;
    process.env.ENABLE_NOTIFICATIONS = original.notifications;
    if (original.secret === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = original.secret;
    const tenantIds = [a?.tenantId].filter(Boolean);
    await CampaignRecipient.deleteMany({ tenantId: { $in: tenantIds } });
    await Campaign.deleteMany({ tenantId: { $in: tenantIds } });
    await CollectionAction.deleteMany({ tenantId: { $in: tenantIds } });
    await PaymentAttempt.deleteMany({ tenantId: { $in: tenantIds } });
    await Quota.deleteMany({ tenantId: { $in: tenantIds } });
    await Contract.deleteMany({ tenantId: { $in: tenantIds } });
    await Client.deleteMany({ tenantId: { $in: tenantIds } });
    await AuditLog.deleteMany({ tenantId: { $in: tenantIds } });
    await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
    await User.deleteMany({ tenantId: { $in: tenantIds } });
    await Company.deleteMany({ tenantId: { $in: tenantIds } });
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    await UserAccount.deleteMany({ email: /camp\.test$/ });
  });

  it('is only for roles with COBRANZA_CAMPAIGNS', async () => {
    const denied = await request(app).get(`/api/campaigns/templates?${q()}`).set('Authorization', `Bearer ${seller}`);
    expect(denied.statusCode).toBe(403);
    const ok = await request(app).get(`/api/campaigns/templates?${q()}`).set('Authorization', `Bearer ${cartera}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.templates.filter((t) => t.usable).map((t) => t.name)).toEqual(['recordatorio_mora', 'promo_feria']);
  });

  it('previews recipients with each exclusion counted and the message of one buyer', async () => {
    const res = await request(app).post(`/api/campaigns/preview?${q()}`).set('Authorization', `Bearer ${a.token}`)
      .send({ filters: { mora: 'en_mora' }, template: { name: 'recordatorio_mora', language: 'es' } });
    expect(res.statusCode).toBe(200);
    const excluded = Object.fromEntries(res.body.data.excluded.map((e) => [e.reason, e.count]));
    expect(excluded).toEqual({ no_phone: 1, opted_out: 1, pending_payment: 1, open_promise: 1, weekly_limit: 1 });
    expect(res.body.data.matched).toBe(6);
    expect(res.body.data.recipients).toBe(1);
    expect(res.body.data.sample[0]).toMatchObject({ name: 'Comprador late', phone: '+57 ••• 0001' });
    expect(res.body.data.preview.body).toBe('Hola Comprador late, tu cuota de $200.000 lleva 20 días vencida.');
    expect(res.body.data.estimatedCostUsd).toBeCloseTo(0.0008);

    const relaxed = await request(app).post(`/api/campaigns/preview?${q()}`).set('Authorization', `Bearer ${a.token}`)
      .send({ filters: { mora: 'en_mora' }, exclusions: { pendingPayment: false, openPromise: false } });
    expect(relaxed.body.data.recipients).toBe(3);

    const upcoming = await request(app).post(`/api/campaigns/preview?${q()}`).set('Authorization', `Bearer ${a.token}`)
      .send({ filters: { mora: 'al_dia', dueWithinDays: 7 } });
    expect(upcoming.body.data.sample.map((s) => s.name)).toEqual(['Comprador ontime']);

    const ranged = await request(app).post(`/api/campaigns/preview?${q()}`).set('Authorization', `Bearer ${a.token}`)
      .send({ filters: { mora: 'MORA_16_30' } });
    expect(ranged.body.data.matched).toBe(1);
  });

  it('asks for authorization on marketing sends', async () => {
    const res = await request(app).post(`/api/campaigns/preview?${q()}`).set('Authorization', `Bearer ${a.token}`)
      .send({ filters: { mora: 'all' }, template: { name: 'promo_feria', language: 'es' } });
    const excluded = Object.fromEntries(res.body.data.excluded.map((e) => [e.reason, e.count]));
    expect(res.body.data.recipients).toBe(0);
    expect(excluded.no_consent).toBe(5);
  });

  it('refuses templates it cannot fill and sends while notifications are off', async () => {
    process.env.ENABLE_NOTIFICATIONS = 'false';
    const off = await request(app).post(`/api/campaigns?${q()}`).set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Mora', template: { name: 'recordatorio_mora', language: 'es' } });
    expect(off.statusCode).toBe(503);
    process.env.ENABLE_NOTIFICATIONS = 'true';
    const automatic = await request(app).post(`/api/campaigns?${q()}`).set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Mora', template: { name: 'operix_cuota_vencida', language: 'es' } });
    expect(automatic.statusCode).toBe(400);
    const past = await request(app).post(`/api/campaigns?${q()}`).set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Mora', template: { name: 'recordatorio_mora', language: 'es' }, scheduledAt: daysFromNow(-1).toISOString() });
    expect(past.statusCode).toBe(400);
  });

  it('creates a send, delivers it in contact hours and records Meta reports, replies and opt-outs', async () => {
    process.env.ENABLE_NOTIFICATIONS = 'true';
    const created = await request(app).post(`/api/campaigns?${q()}`).set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Mora noviembre', template: { name: 'recordatorio_mora', language: 'es' }, filters: { mora: 'en_mora' } });
    expect(created.statusCode).toBe(201);
    expect(created.body.data.recipients).toBe(1);
    const id = created.body.data._id;

    // A Wednesday morning after the scheduled time, inside the default hours
    const scheduledAt = new Date(created.body.data.scheduledAt);
    let at = new Date(Math.max(scheduledAt.getTime(), Date.now()) + 7 * DAY);
    while (!isWithinContactHours(at, resolveContactPolicy())) at = new Date(at.getTime() + 60 * 60 * 1000);
    sent.length = 0;
    await processCampaigns(() => at);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('+573001110001');
    expect(sent[0].components[0].parameters.map((p) => [p.parameter_name, p.text])).toEqual([
      ['nombre_comprador', 'Comprador late'], ['valor_cuota', '$200.000'], ['dias_mora', expect.any(String)],
    ]);
    const recipient = await CampaignRecipient.findOne({ campaignId: id }).lean();
    expect(recipient).toMatchObject({ status: 'sent', waMessageId: 'wamid.1.' + stamp });
    expect((await Campaign.findById(id).lean()).status).toBe('sent');

    process.env.META_APP_SECRET = 'test-secret';
    const post = (body) => {
      const raw = JSON.stringify(body);
      const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(raw).digest('hex');
      return request(app).post('/api/whatsapp/webhook').set('Content-Type', 'application/json').set('x-hub-signature-256', signature).send(raw);
    };
    const statuses = (list) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: list } }] }] });
    await post(statuses([{ id: recipient.waMessageId, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)) }]));
    await post(statuses([{ id: recipient.waMessageId, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }]));
    await wait(300);
    const read = await CampaignRecipient.findById(recipient._id).lean();
    expect(read.status).toBe('read');
    expect(read.deliveredAt).toBeTruthy();

    // The recipient answers BAJA: the reply counts and the buyer opts out (send recorded now, inside the reply window)
    await CampaignRecipient.updateOne({ _id: recipient._id }, { sentAt: new Date() });
    await post({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { metadata: { phone_number_id: `phone${stamp}` }, messages: [{ from: '573001110001', id: `in${stamp}`, type: 'text', text: { body: 'Baja.' } }] } }] }],
    });
    await wait(500);
    const replied = await CampaignRecipient.findById(recipient._id).lean();
    expect(replied.repliedAt).toBeTruthy();
    expect(replied.optedOutAt).toBeTruthy();
    expect((await Client.findById(buyers.late.client._id).lean()).contactConsent.status).toBe('baja');

    const detail = await request(app).get(`/api/campaigns/${id}?${q()}`).set('Authorization', `Bearer ${a.token}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.data.counts).toMatchObject({ total: 1, read: 1, replied: 1, optedOut: 1 });
    const list = await request(app).get(`/api/campaigns/${id}/recipients?${q()}&status=opted_out`).set('Authorization', `Bearer ${a.token}`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].client.name).toBe('Comprador late');
  });

  it('cancels a scheduled send and edits the contact policy with CONFIG_TENANT only', async () => {
    await Client.updateOne({ _id: buyers.ontime.client._id }, { contactConsent: { status: 'autorizado' } });
    const created = await request(app).post(`/api/campaigns?${q()}`).set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Próximas', template: { name: 'recordatorio_mora', language: 'es' }, filters: { mora: 'al_dia' }, scheduledAt: daysFromNow(10).toISOString() });
    expect(created.statusCode).toBe(201);
    const cancel = await request(app).post(`/api/campaigns/${created.body.data._id}/cancel?${q()}`).set('Authorization', `Bearer ${a.token}`);
    expect(cancel.body.data.notSent).toBe(1);
    const again = await request(app).post(`/api/campaigns/${created.body.data._id}/cancel?${q()}`).set('Authorization', `Bearer ${a.token}`);
    expect(again.statusCode).toBe(400);

    const denied = await request(app).put(`/api/campaigns/policy?${q()}`).set('Authorization', `Bearer ${cartera}`).send({ weeklyLimit: 2 });
    expect(denied.statusCode).toBe(403);
    const bad = await request(app).put(`/api/campaigns/policy?${q()}`).set('Authorization', `Bearer ${a.token}`).send({ weekdayStart: 22 });
    expect(bad.statusCode).toBe(400);
    const ok = await request(app).put(`/api/campaigns/policy?${q()}`).set('Authorization', `Bearer ${a.token}`).send({ weeklyLimit: 2 });
    expect(ok.body.data.policy).toMatchObject({ weeklyLimit: 2, weekdayStart: 7 });
  });

  it('records the buyer authorization from the panel', async () => {
    const bad = await request(app).put(`/api/clients/${buyers.optout.client._id}/contact-consent?${q()}`).set('Authorization', `Bearer ${a.token}`).send({ status: 'quizas' });
    expect(bad.statusCode).toBe(400);
    const ok = await request(app).put(`/api/clients/${buyers.optout.client._id}/contact-consent?${q()}`).set('Authorization', `Bearer ${a.token}`).send({ status: 'autorizado' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.contactConsent).toMatchObject({ status: 'autorizado', source: 'panel' });
  });
});
