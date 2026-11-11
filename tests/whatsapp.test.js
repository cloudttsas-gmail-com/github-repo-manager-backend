import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import { whatsappService } from '../src/services/whatsapp.service.js';
import { generateAccessToken } from '../src/utils/jwt.js';
import Client from '../src/models/Client.js';
import Conversation from '../src/models/Conversation.js';
import Message from '../src/models/Message.js';

describe('Integration Test - WhatsApp manual send', () => {
  let token = '';
  let companyId = '';
  const email = `admin.wa.test.${Date.now()}@example.com`;
  const password = 'Password123';

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Admin Test WA',
        fullName: 'Admin Test WA',
        email,
        password,
        confirmPassword: password,
        tenantName: 'Tenant WA Test',
        companyName: 'Company WA Test',
      });
    token = res.body.data?.accessToken;
    companyId = res.body.data?.company?._id;
  });

  afterAll(async () => {
    const account = await UserAccount.findOne({ email });
    if (account) {
      const memberships = await User.find({ accountId: account._id });
      await Company.deleteMany({ _id: companyId });
      await Tenant.deleteMany({ _id: { $in: memberships.map((m) => m.tenantId) } });
      await User.deleteMany({ accountId: account._id });
      await UserAccount.deleteOne({ _id: account._id });
    }
  });

  it('the buyer cannot use the company WhatsApp, and only configuration roles connect the number', async () => {
    const account = await UserAccount.findOne({ email });
    const admin = await User.findOne({ accountId: account._id });
    const tokenAs = (role) => generateAccessToken({ accountId: account._id, userId: admin._id, tenantId: admin.tenantId, role });

    const buyer = tokenAs('cliente');
    for (const [method, path] of [['get', '/api/whatsapp/conversations'], ['get', '/api/whatsapp/history/x'], ['post', '/api/whatsapp/send'], ['post', '/api/whatsapp/disconnect']]) {
      const res = await request(app)[method](path).set('Authorization', `Bearer ${buyer}`).send({});
      expect(res.statusCode).toBe(403);
    }

    const seller = tokenAs('vendedor');
    expect((await request(app).post('/api/whatsapp/disconnect').set('Authorization', `Bearer ${seller}`).send({})).statusCode).toBe(403);
    expect((await request(app).get('/api/whatsapp/config').set('Authorization', `Bearer ${seller}`)).statusCode).toBe(403);
  });

  it('gives the Embedded Signup values without the app secret', async () => {
    const saved = { id: process.env.META_APP_ID, cfg: process.env.META_CONFIG_ID, secret: process.env.META_APP_SECRET };
    process.env.META_APP_ID = '111';
    process.env.META_CONFIG_ID = '222';
    process.env.META_APP_SECRET = 'app-secret-for-tests';
    try {
      const res = await request(app).get('/api/whatsapp/config').set('Authorization', `Bearer ${token}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({ appId: '111', configId: '222' });
      expect(res.body.data.graphApiVersion).toMatch(/^v\d+\.\d+$/);
      expect(JSON.stringify(res.body)).not.toContain('app-secret-for-tests');
    } finally {
      process.env.META_APP_ID = saved.id;
      process.env.META_CONFIG_ID = saved.cfg;
      process.env.META_APP_SECRET = saved.secret;
    }
  });

  it('does not send when notifications are off', async () => {
    const saved = process.env.ENABLE_NOTIFICATIONS;
    process.env.ENABLE_NOTIFICATIONS = 'false';
    const textSpy = jest.spyOn(whatsappService, 'sendTextMessage');
    const templateSpy = jest.spyOn(whatsappService, 'sendTemplateMessage');
    try {
      const res = await request(app)
        .post('/api/whatsapp/send')
        .set('Authorization', `Bearer ${token}`)
        .send({ companyId, phone: '3001234567', text: 'Hola' });

      expect(res.statusCode).toBe(503);
      expect(textSpy).not.toHaveBeenCalled();
      expect(templateSpy).not.toHaveBeenCalled();
    } finally {
      textSpy.mockRestore();
      templateSpy.mockRestore();
      process.env.ENABLE_NOTIFICATIONS = saved;
    }
  });

  it('a project without its own number cannot send, not even from the Operix number', async () => {
    const saved = process.env.ENABLE_NOTIFICATIONS;
    process.env.ENABLE_NOTIFICATIONS = 'true';
    const spy = jest.spyOn(whatsappService, 'sendTextMessage');
    try {
      const res = await request(app)
        .post('/api/whatsapp/send')
        .set('Authorization', `Bearer ${token}`)
        .send({ companyId, phone: '3001234567', text: 'Hola' });
      expect(res.statusCode).toBe(400);
      expect(spy).not.toHaveBeenCalled();
      expect((await request(app).get(`/api/whatsapp/templates?companyId=${companyId}`).set('Authorization', `Bearer ${token}`)).statusCode).toBe(400);
    } finally {
      spy.mockRestore();
      process.env.ENABLE_NOTIFICATIONS = saved;
    }
  });

  it('sends a template in the requested language, Spanish by default', async () => {
    await Company.updateOne({ _id: companyId }, {
      'integrations.whatsappConnectedAt': new Date(), 'integrations.whatsappAccessToken': 'token-lang',
      'integrations.whatsappPhoneId': `phone-lang-${Date.now()}`, 'integrations.whatsappWabaId': 'waba-lang',
    });
    const saved = process.env.ENABLE_NOTIFICATIONS;
    process.env.ENABLE_NOTIFICATIONS = 'true';
    const spy = jest.spyOn(whatsappService, 'sendTemplateMessage')
      .mockResolvedValueOnce({ messages: [{ id: `wamid.en.${Date.now()}` }] })
      .mockResolvedValueOnce({ messages: [{ id: `wamid.es.${Date.now()}` }] });
    try {
      const en = await request(app)
        .post('/api/whatsapp/send')
        .set('Authorization', `Bearer ${token}`)
        .send({ companyId, phone: '3001234567', templateName: 'hello_world', language: 'en_US' });
      const es = await request(app)
        .post('/api/whatsapp/send')
        .set('Authorization', `Bearer ${token}`)
        .send({ companyId, phone: '3001234567', templateName: 'recordatorio' });

      expect(en.statusCode).toBe(200);
      expect(es.statusCode).toBe(200);
      expect(spy.mock.calls[0][3]).toBe('en_US');
      expect(spy.mock.calls[1][3]).toBe('es');
    } finally {
      spy.mockRestore();
      process.env.ENABLE_NOTIFICATIONS = saved;
    }
  });
});

// A tenant with two projects, each with its own number: WhatsApp follows the active project
describe('WhatsApp uses the active project, never another one or another tenant', () => {
  const stamp = Date.now();
  const password = 'Password123';
  let token;
  let tenantId;
  let first;
  let second;
  let foreignClient;

  const connected = (n) => ({
    whatsappConnectedAt: new Date(), whatsappAccessToken: `token-${n}`, whatsappPhoneId: `phone-${n}-${stamp}`, whatsappWabaId: `waba-${n}`,
  });
  const as = (req) => req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Admin multi', fullName: 'Admin multi', email: `admin.multi.${stamp}@wa-multi.test`,
      password, confirmPassword: password, tenantName: `Tenant multi ${stamp}`, companyName: `Project one ${stamp}`,
    });
    token = res.body.data.accessToken;
    tenantId = res.body.data.company.tenantId;
    first = await Company.findById(res.body.data.company._id);
    first.integrations = connected('one');
    await first.save();
    second = await Company.create({ tenantId, name: `Project two ${stamp}`, slug: `project-two-${stamp}`, integrations: connected('two') });

    const other = await request(app).post('/api/auth/register').send({
      name: 'Other', fullName: 'Other', email: `other.${stamp}@wa-multi.test`,
      password, confirmPassword: password, tenantName: `Tenant other ${stamp}`, companyName: `Other ${stamp}`,
    });
    foreignClient = await Client.create({
      tenantId: other.body.data.company.tenantId, companyId: other.body.data.company._id, name: 'Foreign', idNumber: `F${stamp}`, phone: '3009998877',
    });
  });

  afterAll(async () => {
    const accounts = await UserAccount.find({ email: /wa-multi\.test$/ });
    const memberships = await User.find({ accountId: { $in: accounts.map((a) => a._id) } });
    const tenants = memberships.map((m) => m.tenantId);
    await Message.deleteMany({ tenantId: { $in: tenants.map(String) } });
    await Conversation.deleteMany({ tenantId: { $in: tenants.map(String) } });
    await Client.deleteMany({ tenantId: { $in: tenants } });
    await Company.deleteMany({ tenantId: { $in: tenants } });
    await Tenant.deleteMany({ _id: { $in: tenants } });
    await User.deleteMany({ accountId: { $in: accounts.map((a) => a._id) } });
    await UserAccount.deleteMany({ _id: { $in: accounts.map((a) => a._id) } });
  });

  it('sends from the number of the active project', async () => {
    const saved = process.env.ENABLE_NOTIFICATIONS;
    process.env.ENABLE_NOTIFICATIONS = 'true';
    const spy = jest.spyOn(whatsappService, 'sendTextMessage').mockResolvedValue({ messages: [{ id: `wamid.multi.${stamp}` }] });
    try {
      const res = await as(request(app).post(`/api/whatsapp/send?companyId=${second._id}`)).send({ phone: '3001112233', text: 'Hola' });
      expect(res.statusCode).toBe(200);
      expect(spy.mock.calls[0][0].phoneNumberId).toBe(`phone-two-${stamp}`);
    } finally {
      spy.mockRestore();
      process.env.ENABLE_NOTIFICATIONS = saved;
    }
  });

  it('never sends to or links a client of another tenant', async () => {
    const saved = process.env.ENABLE_NOTIFICATIONS;
    process.env.ENABLE_NOTIFICATIONS = 'true';
    const spy = jest.spyOn(whatsappService, 'sendTextMessage').mockResolvedValue({ messages: [{ id: `wamid.foreign.${stamp}` }] });
    try {
      const byId = await as(request(app).post(`/api/whatsapp/send?companyId=${first._id}`)).send({ clientId: foreignClient._id, text: 'Hola' });
      expect(byId.statusCode).toBe(404);
      const byPhone = await as(request(app).post(`/api/whatsapp/send?companyId=${first._id}`)).send({ phone: foreignClient.phone, text: 'Hola' });
      expect(byPhone.statusCode).toBe(200);
      const conv = await Conversation.findOne({ tenantId: String(tenantId), waId: { $regex: '3009998877$' } });
      expect(conv.clientId).toBeFalsy();
    } finally {
      spy.mockRestore();
      process.env.ENABLE_NOTIFICATIONS = saved;
    }
  });

  it('lists only the conversations of the active project', async () => {
    const res = await as(request(app).get(`/api/whatsapp/conversations?companyId=${first._id}`));
    expect(res.statusCode).toBe(200);
    expect(res.body.data.some((c) => c.waId.endsWith('3001112233'))).toBe(false);
  });

  it('disconnecting only touches the active project', async () => {
    const res = await as(request(app).post(`/api/whatsapp/disconnect?companyId=${second._id}`)).send({});
    expect(res.statusCode).toBe(200);
    expect((await Company.findById(first._id)).integrations.whatsappPhoneId).toBe(`phone-one-${stamp}`);
    expect((await Company.findById(second._id)).integrations.whatsappPhoneId).toBeFalsy();
  });

  // Meta is mocked: the access token skips the code exchange and the ids come from the signup
  const connectWith = async (mode, registerOk = true) => {
    const saved = { id: process.env.META_APP_ID, secret: process.env.META_APP_SECRET };
    process.env.META_APP_ID = 'app-test';
    process.env.META_APP_SECRET = 'secret-test';
    const calls = [];
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
      if (String(url).endsWith('/register') && !registerOk) {
        return { ok: false, json: async () => ({ error: { message: 'Number already in use' } }) };
      }
      return { ok: true, json: async () => ({ success: true, display_phone_number: '+57 300 000 0000', verified_name: 'Proyecto' }) };
    });
    try {
      const res = await as(request(app).post(`/api/whatsapp/connect?companyId=${second._id}`))
        .send({ code: 'EA-test-token', wabaId: `waba-new-${stamp}`, phoneNumberId: `phone-new-${stamp}`, ...(mode && { mode }) });
      return { res, register: calls.find((c) => c.url.endsWith(`/phone-new-${stamp}/register`)) };
    } finally {
      fetchSpy.mockRestore();
      process.env.META_APP_ID = saved.id;
      process.env.META_APP_SECRET = saved.secret;
    }
  };

  it('connecting with coexistence (the default) does not register the number again', async () => {
    const { res, register } = await connectWith(undefined);
    expect(res.statusCode).toBe(200);
    expect(register).toBeUndefined();
    expect((await Company.findById(second._id)).integrations.whatsappConnectionMode).toBe('coexistence');
  });

  it('connecting a new number registers it on the Cloud API with a PIN that never leaves the server', async () => {
    const { res, register } = await connectWith('cloud');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(register.body)).toMatchObject({ messaging_product: 'whatsapp', pin: expect.stringMatching(/^\d{6}$/) });
    const company = await Company.findById(second._id);
    expect(company.integrations.whatsappConnectionMode).toBe('cloud');
    expect(company.integrations.whatsappPin).toBe(JSON.parse(register.body).pin);
    const listed = await as(request(app).get(`/api/companies/${second._id}`));
    expect(JSON.stringify(listed.body)).not.toContain('whatsappPin');
  });

  it('a new number that Meta does not register is not saved as connected', async () => {
    await as(request(app).post(`/api/whatsapp/disconnect?companyId=${second._id}`)).send({});
    const { res } = await connectWith('cloud', false);
    expect(res.statusCode).toBe(502);
    expect((await Company.findById(second._id)).integrations.whatsappPhoneId).toBeFalsy();
  });
});
