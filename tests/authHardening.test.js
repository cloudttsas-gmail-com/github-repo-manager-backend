import request from 'supertest';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import VerificationToken from '../src/models/VerificationToken.js';
import jwt from 'jsonwebtoken';

const stamp = Date.now();
const password = 'Password123!';
const email = (name) => `${name}.${stamp}@hardening.test`;

const registerTenant = async (name) => {
  const res = await request(app).post('/api/auth/register').send({
    name: `Owner ${name}`,
    fullName: `Owner ${name}`,
    email: email(`owner-${name}`),
    password,
    confirmPassword: password,
    tenantName: `Tenant ${name} ${stamp}`,
    companyName: `Company ${name} ${stamp}`,
  });
  if (!res.body.success) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return {
    token: res.body.data.accessToken,
    companyId: res.body.data.company._id,
    tenantId: res.body.data.company.tenantId,
  };
};

const createMember = (token, companyId, body) =>
  request(app)
    .post(`/api/admin-users/create?companyId=${companyId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ password, companyIds: [companyId], ...body });

const login = (mail) => request(app).post('/api/auth/admin/login').send({ email: mail, password });

describe('Auth hardening', () => {
  let a;
  let b;
  let gerenteToken;
  let ownerMembershipId;
  let gerenteMembershipId;

  beforeAll(async () => {
    a = await registerTenant('a');
    b = await registerTenant('b');

    const owner = await UserAccount.findOne({ email: email('owner-a') });
    ownerMembershipId = (await User.findOne({ accountId: owner._id }))._id.toString();

    const created = await createMember(a.token, a.companyId, {
      fullName: 'Gerente', email: email('gerente'), role: 'gerente',
    });
    gerenteMembershipId = created.body.data.user.id;
    gerenteToken = (await login(email('gerente'))).body.data.accessToken;
  });

  afterAll(async () => {
    const tenantIds = [a?.tenantId, b?.tenantId].filter(Boolean);
    await VerificationToken.deleteMany({ tenantId: { $in: tenantIds } });
    await Client.deleteMany({ tenantId: { $in: tenantIds } });
    await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
    await User.deleteMany({ tenantId: { $in: tenantIds } });
    await Company.deleteMany({ tenantId: { $in: tenantIds } });
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    await UserAccount.deleteMany({ email: /hardening\.test$/ });
  });

  describe('tenant selection', () => {
    let multiAccountId;

    beforeAll(async () => {
      await createMember(a.token, a.companyId, { fullName: 'Multi', email: email('multi'), role: 'contador' });
      await createMember(b.token, b.companyId, { fullName: 'Multi', email: email('multi'), role: 'contador' });
      multiAccountId = (await UserAccount.findOne({ email: email('multi') }))._id.toString();
    });

    it('login returns a selection token and no account id', async () => {
      const res = await login(email('multi'));
      expect(res.body.data.requiresTenantSelection).toBe(true);
      expect(res.body.data.selectionToken).toEqual(expect.any(String));
      expect(res.body.data.accountId).toBeUndefined();
    });

    it('rejects selecting a tenant with only an account id', async () => {
      const res = await request(app).post('/api/auth/select-tenant')
        .send({ accountId: multiAccountId, tenantId: a.tenantId });
      expect(res.statusCode).toBe(400);
      expect(res.body.data?.accessToken).toBeUndefined();
    });

    it('rejects a forged selection token', async () => {
      const res = await request(app).post('/api/auth/select-tenant')
        .send({ selectionToken: 'not-a-token', tenantId: a.tenantId });
      expect(res.statusCode).toBe(401);
    });

    it('issues a session with the token from a real login', async () => {
      const { selectionToken } = (await login(email('multi'))).body.data;
      const res = await request(app).post('/api/auth/select-tenant')
        .send({ selectionToken, tenantId: b.tenantId });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.user.tenantId).toBe(b.tenantId.toString());
    });

    it('a selection token is not accepted as a session', async () => {
      const res = await request(app).get('/api/auth/me')
        .set('Authorization', `Bearer ${jwt.sign({ accountId: multiAccountId, purpose: 'tenant_selection' }, process.env.JWT_SECRET)}`);
      expect(res.statusCode).toBe(401);
    });
  });

  describe('client OTP', () => {
    let clientA;
    let clientB;

    const makeClient = async (name, idNumber) => {
      const client = await Client.create({
        tenantId: a.tenantId, companyId: a.companyId, name, idNumber, phone: '3000000000',
      });
      const account = await UserAccount.create({
        email: email(`client-${idNumber}`), passwordHash: password, fullName: name, documentoIdentidad: `${idNumber}${stamp}`,
      });
      await User.create({ accountId: account._id, tenantId: a.tenantId, role: 'cliente', clientId: client._id });
      return { client, account };
    };

    const makeToken = (clientId, token, code = '123456') => VerificationToken.create({
      tenantId: a.tenantId, companyId: a.companyId, clientId, token, code,
      type: 'phone', destination: '3000000000', expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    beforeAll(async () => {
      clientA = await makeClient('Client A', `A${stamp}`);
      clientB = await makeClient('Client B', `B${stamp}`);
    });

    it('signs in the client the code was sent to, whatever ids the body carries', async () => {
      await makeToken(clientA.client._id, `tok-a-${stamp}`);
      const victim = await User.findOne({ clientId: clientB.client._id });
      const res = await request(app).post('/api/auth/verify-client-otp').send({
        otpToken: `tok-a-${stamp}`, otpCode: '123456',
        accountId: clientB.account._id, userId: victim._id, tenantId: a.tenantId, clientId: clientB.client._id,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.user.email).toBe(clientA.account.email);
    });

    it('requires the token, not just a valid code', async () => {
      await makeToken(clientA.client._id, `tok-a2-${stamp}`, '654321');
      const res = await request(app).post('/api/auth/verify-client-otp').send({ otpCode: '654321' });
      expect(res.statusCode).toBe(400);
    });

    it('burns the token after five wrong codes', async () => {
      await makeToken(clientA.client._id, `tok-a3-${stamp}`, '111111');
      for (let i = 0; i < 5; i++) {
        await request(app).post('/api/auth/verify-client-otp').send({ otpToken: `tok-a3-${stamp}`, otpCode: '000000' });
      }
      const res = await request(app).post('/api/auth/verify-client-otp')
        .send({ otpToken: `tok-a3-${stamp}`, otpCode: '111111' });
      expect(res.statusCode).toBe(400);
    });

    it('a public payment report needs a verified code, not just the token', async () => {
      await makeToken(clientA.client._id, `tok-a4-${stamp}`);
      const res = await request(app).post('/api/public/report-payment')
        .field('quotaId', '000000000000000000000000')
        .field('otpToken', `tok-a4-${stamp}`)
        .attach('capture', Buffer.from('fake'), { filename: 'capture.png', contentType: 'image/png' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('role assignment', () => {
    it.each(['superadmin', 'tenant_admin', 'company_admin', 'gerente'])(
      'a gerente cannot create a %s', async (role) => {
        const res = await createMember(gerenteToken, a.companyId, {
          fullName: 'X', email: email(`x-${role}`), role,
        });
        expect(res.statusCode).toBe(403);
      },
    );

    it('a gerente can create a lower role', async () => {
      const res = await createMember(gerenteToken, a.companyId, {
        fullName: 'Aux', email: email('aux'), role: 'auxiliar_cartera',
      });
      expect(res.statusCode).toBe(201);
    });

    it('nobody can create a superadmin from a team, not even the owner', async () => {
      const res = await createMember(a.token, a.companyId, {
        fullName: 'X', email: email('x-owner-super'), role: 'superadmin',
      });
      expect(res.statusCode).toBe(403);
    });

    it('a gerente cannot raise their own role', async () => {
      const res = await request(app).put(`/api/admin-users/update/${gerenteMembershipId}?companyId=${a.companyId}`)
        .set('Authorization', `Bearer ${gerenteToken}`).send({ role: 'superadmin' });
      expect(res.statusCode).toBe(403);
      expect((await User.findById(gerenteMembershipId)).role).toBe('gerente');
    });

    it('a gerente cannot edit, reset or remove the tenant owner', async () => {
      const auth = { Authorization: `Bearer ${gerenteToken}` };
      const q = `?companyId=${a.companyId}`;
      const update = await request(app).put(`/api/admin-users/update/${ownerMembershipId}${q}`).set(auth).send({ status: 'inactive' });
      const reset = await request(app).put(`/api/admin-users/change-password/${ownerMembershipId}${q}`).set(auth).send({ password: 'Hijacked123!' });
      const remove = await request(app).delete(`/api/admin-users/delete/${ownerMembershipId}${q}`).set(auth);
      expect([update.statusCode, reset.statusCode, remove.statusCode]).toEqual([403, 403, 403]);
      expect((await login(email('owner-a'))).statusCode).toBe(200);
    });
  });
});
