import request from 'supertest';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import VerificationToken from '../src/models/VerificationToken.js';
import AuditLog from '../src/models/AuditLog.js';
import { registerPortalUserForClient } from '../src/utils/clientAuthHelper.js';

const stamp = Date.now();
const password = 'Password123!';
const doc = `9${String(stamp).slice(-9)}`;

const bearer = (res) => `Bearer ${res.body.data.accessToken}`;

// The code the API sent, read from the database (it goes by WhatsApp)
const codeOf = async (otpToken) => (await VerificationToken.findOne({ token: otpToken })).code;

describe('Buyer access to the portal', () => {
  let a;
  let b;
  let clientA;
  let clientB;

  const signInBuyer = async (pass = doc) => {
    const login = await request(app).post('/api/auth/admin/login').send({ email: doc, password: pass, portal: 'cliente' });
    expect(login.statusCode).toBe(200);
    const { otpToken } = login.body.data;
    return request(app).post('/api/auth/verify-client-otp').send({ otpToken, otpCode: await codeOf(otpToken) });
  };

  beforeAll(async () => {
    const register = async (name) => {
      const res = await request(app).post('/api/auth/register').send({
        name, fullName: name, email: `${name}.${stamp}@buyeraccess.test`, password, confirmPassword: password,
        tenantName: `Tenant ${name} ${stamp}`, companyName: `Proyecto ${name} ${stamp}`,
      });
      return { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    };
    a = await register('owner-a');
    b = await register('owner-b');
    // The same person bought in two companies: one client per project, one account
    clientA = await Client.create({ tenantId: a.tenantId, companyId: a.companyId, name: 'Comprador Doble', idNumber: doc, phone: '3001112233' });
    await registerPortalUserForClient(clientA, a.tenantId, a.companyId);
    clientB = await Client.create({ tenantId: b.tenantId, companyId: b.companyId, name: 'Comprador Doble', idNumber: doc, phone: '3004445566' });
    await registerPortalUserForClient(clientB, b.tenantId, b.companyId);
  });

  afterAll(async () => {
    const tenantId = { $in: [a?.tenantId, b?.tenantId] };
    await VerificationToken.deleteMany({ tenantId });
    await AuditLog.deleteMany({ tenantId });
    await Client.deleteMany({ tenantId });
    await UserCompany.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Company.deleteMany({ tenantId });
    await Tenant.deleteMany({ _id: tenantId });
    await UserAccount.deleteMany({ $or: [{ email: /buyeraccess\.test$/ }, { documentoIdentidad: { $in: [doc, `${doc}1`] } }] });
  });

  it('a buyer in the company sign-in is sent to the client portal without spending a code', async () => {
    const before = await VerificationToken.countDocuments({ clientId: clientA._id });
    const res = await request(app).post('/api/auth/admin/login').send({ email: doc, password: doc });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('BUYER_ACCOUNT');
    expect(await VerificationToken.countDocuments({ clientId: clientA._id })).toBe(before);
  });

  it('the buyer never sees the internal placeholder email', async () => {
    const res = await signInBuyer();
    expect(res.statusCode).toBe(200);
    expect(res.body.data.user.email).toBe('');
    expect(res.body.data.user.cedula).toBe(doc);
    const me = await request(app).get('/api/auth/me').set('Authorization', bearer(res));
    expect(me.body.data.user.email).toBe('');
  });

  it('a buyer with properties in two companies sees both and switches without another code', async () => {
    const res = await signInBuyer();
    const list = await request(app).get('/api/auth/client-projects').set('Authorization', bearer(res));
    expect(list.statusCode).toBe(200);
    const projects = list.body.data.projects;
    expect(projects).toHaveLength(2);
    const other = projects.find((p) => !p.current);
    const switched = await request(app).post('/api/auth/switch-client')
      .set('Authorization', bearer(res)).send({ clientId: other.clientId });
    expect(switched.statusCode).toBe(200);
    const after = await request(app).get('/api/auth/client-projects').set('Authorization', bearer(switched));
    expect(after.body.data.projects.find((p) => p.current).clientId).toBe(other.clientId);
  });

  it('cannot switch to a client of another person', async () => {
    const res = await signInBuyer();
    const stranger = await Client.create({ tenantId: a.tenantId, companyId: a.companyId, name: 'Otra', idNumber: `X${stamp}`, phone: '3009998877' });
    const switched = await request(app).post('/api/auth/switch-client')
      .set('Authorization', bearer(res)).send({ clientId: stranger._id });
    expect(switched.statusCode).toBe(404);
  });

  it('a code asked for a payment does not open the portal', async () => {
    await VerificationToken.create({
      tenantId: a.tenantId, companyId: a.companyId, clientId: clientA._id, token: `pay-${stamp}`, code: '123456',
      type: 'phone', purpose: 'payment', destination: '3001112233', expiresAt: new Date(Date.now() + 600000),
    });
    const res = await request(app).post('/api/auth/verify-client-otp').send({ otpToken: `pay-${stamp}`, otpCode: '123456' });
    expect(res.statusCode).toBe(400);
  });

  it('a buyer who forgot the password sets a new one with a WhatsApp code', async () => {
    await VerificationToken.deleteMany({ clientId: { $in: [clientA._id, clientB._id] } });
    const ask = await request(app).post('/api/auth/client-password/request').send({ document: doc });
    expect(ask.statusCode).toBe(200);
    expect(ask.body.data.phone).toBeUndefined();
    const { otpToken } = ask.body.data;
    // The code went to the phone of the first client with one
    expect((await VerificationToken.findOne({ token: otpToken })).destination).toBe('3001112233');

    // The reset code does not sign in by itself
    const asLogin = await request(app).post('/api/auth/verify-client-otp').send({ otpToken, otpCode: await codeOf(otpToken) });
    expect(asLogin.statusCode).toBe(400);

    const short = await request(app).post('/api/auth/client-password/reset').send({ otpToken, otpCode: await codeOf(otpToken), password: '123' });
    expect(short.statusCode).toBe(400);
    const reset = await request(app).post('/api/auth/client-password/reset').send({ otpToken, otpCode: await codeOf(otpToken), password: 'NuevaClave2026' });
    expect(reset.statusCode).toBe(200);
    expect(reset.body.data.user.role).toBe('cliente');

    const oldOne = await request(app).post('/api/auth/admin/login').send({ email: doc, password: doc, portal: 'cliente' });
    expect(oldOne.statusCode).toBe(401);
    await VerificationToken.deleteMany({ clientId: { $in: [clientA._id, clientB._id] } });
    const newOne = await request(app).post('/api/auth/admin/login').send({ email: doc, password: 'NuevaClave2026', portal: 'cliente' });
    expect(newOne.body.data.requiresOtp).toBe(true);
  });

  it('the forgot-password answer does not tell whether a document has access', async () => {
    const known = await request(app).post('/api/auth/client-password/request').send({ document: doc });
    const unknown = await request(app).post('/api/auth/client-password/request').send({ document: `0${stamp}` });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body.message).toBe(known.body.message);
    expect(Object.keys(unknown.body.data)).toEqual(Object.keys(known.body.data));
    // The token of an unknown document matches no code
    expect(await VerificationToken.findOne({ token: unknown.body.data.otpToken })).toBeNull();
    const reset = await request(app).post('/api/auth/client-password/reset')
      .send({ otpToken: unknown.body.data.otpToken, otpCode: '123456', password: 'NuevaClave2026' });
    expect(reset.statusCode).toBe(400);
  });

  it('a document that asked for too many codes gets the same answer, and no new code', async () => {
    await VerificationToken.deleteMany({ clientId: { $in: [clientA._id, clientB._id] } });
    const answers = [];
    for (let i = 0; i < 5; i += 1) {
      answers.push(await request(app).post('/api/auth/client-password/request').send({ document: doc }));
    }
    expect(answers.every((r) => r.statusCode === 200)).toBe(true);
    const sent = await VerificationToken.countDocuments({ clientId: clientA._id, purpose: 'password_reset' });
    expect(sent).toBeLessThan(5);
    await VerificationToken.deleteMany({ clientId: { $in: [clientA._id, clientB._id] } });
  });

  it('the buyer sign-in says the same for an unknown document and a wrong password', async () => {
    const wrong = await request(app).post('/api/auth/admin/login').send({ email: doc, password: 'no-es-esta', portal: 'cliente' });
    const unknown = await request(app).post('/api/auth/admin/login').send({ email: `0${stamp}`, password: 'no-es-esta', portal: 'cliente' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it('the buyer changes the password from the portal with the current one', async () => {
    await VerificationToken.deleteMany({ clientId: { $in: [clientA._id, clientB._id] } });
    const res = await signInBuyer('NuevaClave2026');
    const wrong = await request(app).put('/api/auth/client-password').set('Authorization', bearer(res))
      .send({ currentPassword: 'nope', password: 'OtraClave2026' });
    expect(wrong.statusCode).toBe(400);
    const ok = await request(app).put('/api/auth/client-password').set('Authorization', bearer(res))
      .send({ currentPassword: 'NuevaClave2026', password: 'OtraClave2026' });
    expect(ok.statusCode).toBe(200);
    const account = await UserAccount.findOne({ documentoIdentidad: doc }).select('+passwordHash');
    expect(await account.comparePassword('OtraClave2026')).toBe(true);
  });

  it('editing the client\'s document and email changes how the buyer signs in', async () => {
    const res = await request(app).put(`/api/clients/${clientA._id}?companyId=${a.companyId}`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Comprador Doble', idNumber: `${doc}1`, phone: '3001112233', email: `comprador.${stamp}@buyeraccess.test` });
    expect(res.statusCode).toBe(200);
    expect(res.body.portalAccess.skipped).toEqual([]);
    const account = await UserAccount.findOne({ documentoIdentidad: `${doc}1` });
    expect(account).toBeTruthy();
    expect(account.email).toBe(`comprador.${stamp}@buyeraccess.test`);
  });

  it('an email that belongs to another account is left alone and reported', async () => {
    const res = await request(app).put(`/api/clients/${clientA._id}?companyId=${a.companyId}`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Comprador Doble', idNumber: `${doc}1`, phone: '3001112233', email: `owner-b.${stamp}@buyeraccess.test` });
    expect(res.statusCode).toBe(200);
    expect(res.body.portalAccess.skipped).toEqual(['email']);
    const account = await UserAccount.findOne({ documentoIdentidad: `${doc}1` });
    expect(account.email).toBe(`comprador.${stamp}@buyeraccess.test`);
  });

  it('the client record carries the portal access, and its password changes with the team API', async () => {
    const record = await request(app).get(`/api/clients/${clientA._id}?companyId=${a.companyId}`).set('Authorization', `Bearer ${a.token}`);
    expect(record.statusCode).toBe(200);
    const { userId } = record.body.data.portalAccess;
    const changed = await request(app).put(`/api/admin-users/change-password/${userId}`)
      .set('Authorization', `Bearer ${a.token}`).send({ password: 'DesdeLaFicha2026', companyId: a.companyId });
    expect(changed.statusCode).toBe(200);
    const account = await UserAccount.findOne({ documentoIdentidad: `${doc}1` }).select('+passwordHash');
    expect(await account.comparePassword('DesdeLaFicha2026')).toBe(true);

    const noAccess = await Client.create({ tenantId: a.tenantId, companyId: a.companyId, name: 'Sin portal', idNumber: `Y${stamp}`, phone: '3007776655' });
    const other = await request(app).get(`/api/clients/${noAccess._id}?companyId=${a.companyId}`).set('Authorization', `Bearer ${a.token}`);
    expect(other.body.data.portalAccess).toBeNull();
  });

  it('the team list shows the document instead of an internal email', async () => {
    const res = await request(app).get(`/api/admin-users/all?companyId=${b.companyId}&limit=50`).set('Authorization', `Bearer ${b.token}`);
    const buyer = res.body.data.users.find((u) => u.role === 'cliente');
    expect(buyer.email).not.toMatch(/@portal\.com$/);
    expect(buyer.cedula).toBe(`${doc}1`);
  });
});
