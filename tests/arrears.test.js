import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import { arrearsRangeOf } from '../src/services/arrears.service.js';

const stamp = Date.now();
const password = 'Password123!';
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

describe('Arrears ranges', () => {
  it('are 1-30, 31-60, 61-90 and more than 90 days', () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91, 400].map(arrearsRangeOf)).toEqual([
      null, 'MORA_1_30', 'MORA_1_30', 'MORA_31_60', 'MORA_31_60', 'MORA_61_90', 'MORA_61_90', 'MORA_90_PLUS', 'MORA_90_PLUS',
    ]);
  });
});

describe('Inicio and the financial report count arrears by contract with the same ranges', () => {
  let owner;
  const get = (path) => request(app).get(`${path}?companyId=${owner.companyId}`).set('Authorization', `Bearer ${owner.token}`);

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner arrears', fullName: 'Owner arrears', email: `owner.${stamp}@arrears.test`,
      password, confirmPassword: password,
      tenantName: `Tenant arrears ${stamp}`, companyName: `Company arrears ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    const scope = { tenantId: owner.tenantId, companyId: owner.companyId };
    const client = await Client.create({ ...scope, name: 'Arrears Buyer', idNumber: `AR${stamp}`, phone: '3000000000' });
    const contract = (totalValue) => Contract.create({ ...scope, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue });

    // Two overdue quotas in one contract: the contract counts once, in the range of the oldest
    const old = await contract(2000000);
    await Quota.create({ ...scope, contract: old._id, number: 1, type: 'normal', value: 500000, dueDate: daysAgo(100), status: 'mora' });
    await Quota.create({ ...scope, contract: old._id, number: 2, type: 'normal', value: 300000, dueDate: daysAgo(20), status: 'pendiente' });
    const mid = await contract(1000000);
    await Quota.create({ ...scope, contract: mid._id, number: 1, type: 'normal', value: 400000, amountPaid: 100000, dueDate: daysAgo(45), status: 'pendiente' });
    const upToDate = await contract(1000000);
    await Quota.create({ ...scope, contract: upToDate._id, number: 1, type: 'normal', value: 250000, dueDate: daysAgo(-10), status: 'pendiente' });
  });

  afterAll(async () => {
    const tenantId = owner?.tenantId;
    await Quota.deleteMany({ tenantId });
    await Contract.deleteMany({ tenantId });
    await Client.deleteMany({ tenantId });
    await UserCompany.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Company.deleteMany({ tenantId });
    await Tenant.deleteMany({ _id: tenantId });
    await UserAccount.deleteMany({ email: /arrears\.test$/ });
  });

  it('the financial report gives contracts and their overdue money per range', async () => {
    const res = await get('/api/reports/advanced');
    expect(res.statusCode).toBe(200);
    const { aging, carteraAlDia } = res.body.data;
    expect(aging).toEqual({
      bucket30: { amount: 0, count: 0 },
      bucket60: { amount: 300000, count: 1 },
      bucket90: { amount: 0, count: 0 },
      bucketOver90: { amount: 800000, count: 1 },
    });
    expect(carteraAlDia).toEqual({ amount: 250000, count: 1 });
  });

  it('Inicio puts the same contracts in the same ranges', async () => {
    const res = await get('/api/dashboard/summary');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.mora).toMatchObject({
      contratosAlDia: 1, contratosMora1a30: 0, contratosMora31a60: 1, contratosMora61a90: 0, contratosMora90plus: 1, dineroEnMora: 1100000,
    });
  });

  it('Cartera counts the client in the range of its oldest overdue quota', async () => {
    const res = await get('/api/clients/stats');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.moraRanges).toEqual({ MORA_1_30: 0, MORA_31_60: 0, MORA_61_90: 0, MORA_90_PLUS: 1 });
  });
});
