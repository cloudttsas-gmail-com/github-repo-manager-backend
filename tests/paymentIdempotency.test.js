import 'dotenv/config';
import { jest } from '@jest/globals';
import request from 'supertest';
import mongoose from 'mongoose';

// No R2 in tests: receipts "upload" to a fake URL
jest.unstable_mockModule('../src/utils/storage.js', () => ({
  buildObjectKey: (folder) => `${folder}/test`,
  uploadToR2: async () => 'https://files.test/payments/test.png',
  deleteFromR2: async () => {},
  default: {},
}));
const { default: app } = await import('../src/app.js');
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import PaymentAttempt from '../src/models/PaymentAttempt.js';
import VerificationToken from '../src/models/VerificationToken.js';
import IdempotencyKey from '../src/models/IdempotencyKey.js';

const stamp = Date.now();
const password = 'Password123!';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('Payments cannot be recorded twice', () => {
  let owner;
  let client;
  let contract;
  let quota;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner idem', fullName: 'Owner idem', email: `owner.${stamp}@idem.test`,
      password, confirmPassword: password,
      tenantName: `Tenant idem ${stamp}`, companyName: `Company idem ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    client = await Client.create({ tenantId: owner.tenantId, companyId: owner.companyId, name: 'Idem Buyer', idNumber: `I${stamp}`, phone: '3000000000' });
    contract = await Contract.create({
      tenantId: owner.tenantId, companyId: owner.companyId, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 1000000,
    });
  });

  beforeEach(async () => {
    quota = await Quota.create({
      tenantId: owner.tenantId, companyId: owner.companyId, contract: contract._id,
      number: Math.floor(Math.random() * 100000), type: 'normal', value: 100000, dueDate: new Date(), status: 'pendiente',
    });
  });

  afterAll(async () => {
    const tenantId = owner?.tenantId;
    await PaymentAttempt.deleteMany({ tenantId });
    await Quota.deleteMany({ tenantId });
    await Contract.deleteMany({ tenantId });
    await VerificationToken.deleteMany({ tenantId });
    await Client.deleteMany({ tenantId });
    await UserCompany.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Company.deleteMany({ tenantId });
    await Tenant.deleteMany({ _id: tenantId });
    await UserAccount.deleteMany({ email: /idem\.test$/ });
    await IdempotencyKey.deleteMany({ key: new RegExp(String(owner?.companyId)) });
  });

  it('a double submit of the public report creates one payment', async () => {
    await VerificationToken.create({
      tenantId: owner.tenantId, companyId: owner.companyId, clientId: client._id, token: `idem-${stamp}`, code: '123456',
      type: 'phone', destination: '3000000000', verifiedAt: new Date(), expiresAt: new Date(Date.now() + 600000),
    });
    const send = () => request(app).post('/api/public/report-payment')
      .field('quotaId', quota._id.toString()).field('otpToken', `idem-${stamp}`)
      .field('amount', '100000').field('bank', 'NEQUI').field('paymentMethod', 'Transferencia bancaria')
      .attach('capture', png, { filename: 'c.png', contentType: 'image/png' });
    const statuses = (await Promise.all([send(), send(), send()])).map((r) => r.statusCode).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(await PaymentAttempt.countDocuments({ 'quotas.quotaId': quota._id })).toBe(1);
  });

  it('a double submit of a manual payment applies it once', async () => {
    const send = () => request(app).post(`/api/payments/manual?companyId=${owner.companyId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .field('quotaId', quota._id.toString()).field('amount', '100000').field('bank', 'NEQUI')
      .field('paymentMethod', 'Transferencia bancaria').field('requestId', `manual-${stamp}`);
    const statuses = (await Promise.all([send(), send()])).map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 409]);
    const after = await Quota.findById(quota._id);
    expect(after.amountPaid).toBe(100000);
    expect(await PaymentAttempt.countDocuments({ 'quotas.quotaId': quota._id })).toBe(1);
  });

  it('a manual transfer without a bank is rejected instead of being recorded as cash', async () => {
    const res = await request(app).post(`/api/payments/manual?companyId=${owner.companyId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .field('quotaId', quota._id.toString()).field('amount', '100000')
      .field('paymentMethod', 'Transferencia bancaria').field('requestId', `no-bank-${stamp}`);
    expect(res.statusCode).toBe(400);
    expect((await Quota.findById(quota._id)).amountPaid || 0).toBe(0);
    const cash = await request(app).post(`/api/payments/manual?companyId=${owner.companyId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .field('quotaId', quota._id.toString()).field('amount', '100000')
      .field('paymentMethod', 'Efectivo').field('requestId', `cash-${stamp}`);
    expect(cash.statusCode).toBe(200);
  });

  it('a manual payment to an unknown company account is rejected before touching the quota', async () => {
    const res = await request(app).post(`/api/payments/manual?companyId=${owner.companyId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .field('quotaId', quota._id.toString()).field('amount', '100000')
      .field('bankAccountId', new mongoose.Types.ObjectId().toString())
      .field('paymentMethod', 'Transferencia bancaria').field('requestId', `bad-account-${stamp}`);
    expect(res.statusCode).toBe(400);
    const after = await Quota.findById(quota._id);
    expect(after.amountPaid || 0).toBe(0);
    expect(after.status).toBe('pendiente');
    expect(await PaymentAttempt.countDocuments({ 'quotas.quotaId': quota._id })).toBe(0);
    // the rejected operation id stays usable for a corrected retry
    expect(await IdempotencyKey.countDocuments({ key: `manual:${owner.companyId}:bad-account-${stamp}` })).toBe(0);
  });
});
