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
import Commission from '../src/models/Commission.js';
import AuditLog from '../src/models/AuditLog.js';

const stamp = Date.now();
const password = 'Password123!';
const monthsFromNow = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d; };

describe('Rejecting or editing a payment takes back the commission it earned', () => {
  let owner;
  let scope;
  let client;
  let sellerId;

  const auth = (req) => req.set('Authorization', `Bearer ${owner.token}`);

  // Quota #1 of 1,000,000 paid by an approved payment; commission milestone on quota #1
  const paidContract = async ({ installmentStatus = 'AVAILABLE', legacyPending = false } = {}) => {
    const contract = await Contract.create({ ...scope, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 2000000, sellerId });
    const q1 = await Quota.create({ ...scope, contract: contract._id, number: 1, type: 'normal', value: 1000000, amountPaid: 1000000, status: 'pagado', dueDate: monthsFromNow(1) });
    await Quota.create({ ...scope, contract: contract._id, number: 2, type: 'normal', value: 1000000, amountPaid: 0, status: 'pendiente', dueDate: monthsFromNow(2) });
    const base = {
      ...scope, contractId: contract._id, clientId: client._id, quotas: [{ quotaId: q1._id, amount: 1000000 }],
      amount: 1000000, banco: 'NEQUI', paymentMethod: 'Transferencia bancaria', fechaPago: new Date(), createdAt: new Date(),
    };
    let attemptId;
    if (legacyPending) {
      // Created by the old listing migration: pending, already on the quota, no quotaValue and no flag
      const oid = (id) => new mongoose.Types.ObjectId(String(id));
      ({ insertedId: attemptId } = await PaymentAttempt.collection.insertOne({
        ...base, tenantId: oid(scope.tenantId), companyId: oid(scope.companyId), clientId: client._id, status: 'PENDIENTE',
      }));
    } else {
      attemptId = (await PaymentAttempt.create({ ...base, status: 'APROBADO', appliedToQuotas: true, quotaValue: 1000000 }))._id;
    }
    await Commission.create({
      ...scope, contractId: contract._id, sellerId, totalAmount: 300000,
      installments: [
        { milestoneKey: 'QUOTA_NUMBER', quotaNumber: 1, amount: 100000, status: installmentStatus },
        { milestoneKey: 'QUOTA_NUMBER', quotaNumber: 2, amount: 200000, status: 'PENDING' },
      ],
    });
    return { contract, attemptId };
  };

  const installmentStatus = async (contractId, quotaNumber) => {
    const commission = await Commission.findOne({ contractId });
    return commission.installments.find((i) => i.quotaNumber === quotaNumber).status;
  };

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner com', fullName: 'Owner com', email: `owner.${stamp}@comrevert.test`,
      password, confirmPassword: password,
      tenantName: `Tenant com ${stamp}`, companyName: `Company com ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    scope = { tenantId: owner.tenantId, companyId: owner.companyId };
    sellerId = (await User.findOne({ tenantId: owner.tenantId }))._id;
    client = await Client.create({ ...scope, name: 'Com Buyer', idNumber: `C${stamp}`, phone: '3000000001' });
  });

  afterAll(async () => {
    const tenantId = owner?.tenantId;
    await AuditLog.deleteMany({ tenantId });
    await Commission.deleteMany({ tenantId });
    await PaymentAttempt.deleteMany({ tenantId });
    await Quota.deleteMany({ tenantId });
    await Contract.deleteMany({ tenantId });
    await Client.deleteMany({ tenantId });
    await UserCompany.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Company.deleteMany({ tenantId });
    await Tenant.deleteMany({ _id: tenantId });
    await UserAccount.deleteMany({ email: /comrevert\.test$/ });
  });

  it('editing the payment down puts an available commission back to pending', async () => {
    const { contract, attemptId } = await paidContract();
    const res = await auth(request(app).put(`/api/payments/${attemptId}/edit?companyId=${owner.companyId}`))
      .send({ amount: 400000, reason: 'Monto mal digitado' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.commissionWarning).toMatch(/pendiente/);
    expect(await installmentStatus(contract._id, 1)).toBe('PENDING');
  });

  it('editing the payment without lowering it keeps the commission available', async () => {
    const { contract, attemptId } = await paidContract();
    const res = await auth(request(app).put(`/api/payments/${attemptId}/edit?companyId=${owner.companyId}`))
      .send({ amount: 1000000, paymentMethod: 'Efectivo', reason: 'Cambio de medio' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.commissionWarning).toBeNull();
    expect(await installmentStatus(contract._id, 1)).toBe('AVAILABLE');
  });

  it('a filed commission is not changed, only reported for review', async () => {
    const { contract, attemptId } = await paidContract({ installmentStatus: 'FILED' });
    const res = await auth(request(app).put(`/api/payments/${attemptId}/edit?companyId=${owner.companyId}`))
      .send({ amount: 400000, reason: 'Monto mal digitado' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.commissionWarning).toMatch(/radicada/);
    expect(await installmentStatus(contract._id, 1)).toBe('FILED');
  });

  it('rejecting a pending payment that was already on the quota takes the commission back', async () => {
    const { contract, attemptId } = await paidContract({ legacyPending: true });
    const res = await auth(request(app).put(`/api/payments/${attemptId}/reject?companyId=${owner.companyId}`))
      .send({ rejectedReason: 'Comprobante falso' });
    expect(res.statusCode).toBe(200);
    expect(await installmentStatus(contract._id, 1)).toBe('PENDING');
    expect(await installmentStatus(contract._id, 2)).toBe('PENDING');
  });
});
