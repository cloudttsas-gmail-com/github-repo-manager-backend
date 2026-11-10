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
import PaymentAttempt from '../src/models/PaymentAttempt.js';

// The schedule endpoints use transactions: run this suite against a replica set
// (e.g. MONGODB_URI=mongodb://127.0.0.1:27018/operix_test?replicaSet=rs0)
const stamp = Date.now();
const password = 'Password123!';
const monthsFromNow = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d; };

describe('Generating and restructuring a payment plan never loses payments', () => {
  let owner;
  let scope;
  let client;

  const auth = (req) => req.set('Authorization', `Bearer ${owner.token}`);
  const generate = (body) => auth(request(app).post(`/api/payment-schedule/generate?companyId=${owner.companyId}`)).send(body);
  const apply = (body) => auth(request(app).post(`/api/payment-schedule/apply?companyId=${owner.companyId}`)).send(body);

  // A 3,000,000 contract in 3 quotas of 1,000,000; the first one paid
  const contractWithPaidQuota = async () => {
    const contract = await Contract.create({ ...scope, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 3000000 });
    const quotas = [];
    for (let n = 1; n <= 3; n++) {
      quotas.push(await Quota.create({
        ...scope, contract: contract._id, number: n, type: 'normal', value: 1000000,
        amountPaid: n === 1 ? 1000000 : 0, status: n === 1 ? 'pagado' : 'pendiente', dueDate: monthsFromNow(n),
      }));
    }
    return { contract, quotas };
  };

  const planBody = (contractId, extra = {}) => ({
    contractId, totalValue: 3000000, installmentsCount: 3, installmentValue: 1000000, reason: 'Ajuste de prueba', ...extra,
  });

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner plan', fullName: 'Owner plan', email: `owner.${stamp}@plan.test`,
      password, confirmPassword: password,
      tenantName: `Tenant plan ${stamp}`, companyName: `Company plan ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    scope = { tenantId: owner.tenantId, companyId: owner.companyId };
    client = await Client.create({ ...scope, name: 'Plan Buyer', idNumber: `P${stamp}`, phone: '3000000000' });
  });

  afterAll(async () => {
    const tenantId = owner?.tenantId;
    await PaymentAttempt.deleteMany({ tenantId });
    await Quota.deleteMany({ tenantId });
    await Contract.deleteMany({ tenantId });
    await Client.deleteMany({ tenantId });
    await UserCompany.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Company.deleteMany({ tenantId });
    await Tenant.deleteMany({ _id: tenantId });
    await UserAccount.deleteMany({ email: /plan\.test$/ });
  });

  it('generate refuses to delete quotas that have payments', async () => {
    const { contract, quotas } = await contractWithPaidQuota();
    const res = await generate(planBody(contract._id, { preserveExistingPayments: false }));
    expect(res.statusCode).toBe(400);
    expect(await Quota.exists({ _id: quotas[0]._id })).toBeTruthy();
    expect(await Quota.countDocuments({ contract: contract._id })).toBe(3);
  });

  it('generate keeps the paid quotas and rebuilds the rest', async () => {
    const { contract, quotas } = await contractWithPaidQuota();
    const res = await generate(planBody(contract._id));
    expect(res.statusCode).toBe(200);
    const paid = await Quota.findById(quotas[0]._id);
    expect(paid.amountPaid).toBe(1000000);
    expect(await Quota.countDocuments({ contract: contract._id })).toBe(3);
  });

  it('generate waits until reported payments are approved or rejected', async () => {
    const { contract, quotas } = await contractWithPaidQuota();
    await PaymentAttempt.create({
      ...scope, contractId: contract._id, clientId: client._id, quotas: [{ quotaId: quotas[1]._id, amount: 500000 }],
      amount: 500000, quotaValue: 1000000, banco: 'NEQUI', paymentMethod: 'Transferencia bancaria',
      fechaPago: new Date(), status: 'PENDIENTE', appliedToQuotas: false,
    });
    const res = await generate(planBody(contract._id));
    expect(res.statusCode).toBe(400);
    expect(await Quota.exists({ _id: quotas[1]._id })).toBeTruthy();
  });

  it('generate rejects amounts that are not positive numbers', async () => {
    const { contract } = await contractWithPaidQuota();
    expect((await generate(planBody(contract._id, { installmentValue: -1000 }))).statusCode).toBe(400);
    expect((await generate(planBody(contract._id, { installmentsCount: 2.5 }))).statusCode).toBe(400);
    expect((await generate(planBody(contract._id, { initialQuotasCount: 1, initialQuotaValue: -5 }))).statusCode).toBe(400);
  });

  it('restructure only touches the quotas of its own contract', async () => {
    const mine = await contractWithPaidQuota();
    const other = await contractWithPaidQuota();
    const res = await apply({
      contractId: mine.contract._id,
      reason: 'Ajuste de prueba',
      updatedQuotas: [{ _id: other.quotas[2]._id, number: 3, type: 'normal', value: 1, dueDate: monthsFromNow(3) }],
    });
    expect(res.statusCode).toBe(400);
    expect((await Quota.findById(other.quotas[2]._id)).value).toBe(1000000);
  });

  it('restructure rejects a plan that does not add up to the contract value', async () => {
    const { contract, quotas } = await contractWithPaidQuota();
    const res = await apply({
      contractId: contract._id,
      reason: 'Ajuste de prueba',
      updatedQuotas: [{ _id: quotas[2]._id, number: 3, type: 'normal', value: 400000, dueDate: monthsFromNow(3) }],
    });
    expect(res.statusCode).toBe(400);
    expect((await Quota.findById(quotas[2]._id)).value).toBe(1000000);
  });

  it('restructure rejects a value below what the quota already received or not a number', async () => {
    const { contract, quotas } = await contractWithPaidQuota();
    await Quota.updateOne({ _id: quotas[1]._id }, { amountPaid: 600000 });
    const below = await apply({
      contractId: contract._id,
      reason: 'Ajuste de prueba',
      updatedQuotas: [
        { _id: quotas[1]._id, number: 2, type: 'normal', value: 500000, dueDate: monthsFromNow(2) },
        { _id: quotas[2]._id, number: 3, type: 'normal', value: 1500000, dueDate: monthsFromNow(3) },
      ],
    });
    expect(below.statusCode).toBe(400);
    const notANumber = await apply({
      contractId: contract._id,
      reason: 'Ajuste de prueba',
      updatedQuotas: [{ _id: quotas[2]._id, number: 3, type: 'normal', value: 'abc', dueDate: monthsFromNow(3) }],
    });
    expect(notANumber.statusCode).toBe(400);
    expect((await Quota.findById(quotas[1]._id)).value).toBe(1000000);
  });

  it('restructure applies a balanced plan', async () => {
    const { contract, quotas } = await contractWithPaidQuota();
    const res = await apply({
      contractId: contract._id,
      reason: 'Ajuste de prueba',
      updatedQuotas: [
        { _id: quotas[1]._id, number: 2, type: 'normal', value: 1200000, dueDate: monthsFromNow(2) },
        { _id: quotas[2]._id, number: 3, type: 'normal', value: 800000, dueDate: monthsFromNow(3) },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect((await Quota.findById(quotas[1]._id)).value).toBe(1200000);
    expect((await Quota.findById(quotas[2]._id)).value).toBe(800000);
  });
});
