import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Commission from '../src/models/Commission.js';
import AuditLog from '../src/models/AuditLog.js';

const stamp = Date.now();
const password = 'Password123!';

describe('Approving, rejecting and paying a commission leaves a trace in the audit log', () => {
  let owner;
  let scope;
  let sellerId;

  const post = (path) => request(app).post(`${path}?companyId=${owner.companyId}`).set('Authorization', `Bearer ${owner.token}`);

  const filedCommission = (billingNumber) => Commission.create({
    ...scope, contractId: new mongoose.Types.ObjectId(), sellerId, totalAmount: 100000,
    installments: [{ milestoneKey: 'QUOTA_NUMBER', quotaNumber: 4, amount: 100000, status: 'FILED', billingNumber }],
  });

  const logsFor = (commission) => AuditLog.find({ tenantId: owner.tenantId, module: 'COMMISSIONS', targetId: String(commission._id) }).sort({ createdAt: 1 });

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner audit', fullName: 'Owner audit', email: `owner.${stamp}@comaudit.test`,
      password, confirmPassword: password,
      tenantName: `Tenant comaudit ${stamp}`, companyName: `Company comaudit ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    scope = { tenantId: owner.tenantId, companyId: owner.companyId };
    sellerId = (await User.findOne({ tenantId: owner.tenantId }))._id;
  });

  afterAll(async () => {
    const tenantId = owner?.tenantId;
    await AuditLog.deleteMany({ tenantId });
    await Commission.deleteMany({ tenantId });
    await UserCompany.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Company.deleteMany({ tenantId });
    await Tenant.deleteMany({ _id: tenantId });
    await UserAccount.deleteMany({ email: /comaudit\.test$/ });
  });

  it('records the approval and the payment with the billing and its amount', async () => {
    const commission = await filedCommission(11);

    const approved = await post(`/api/commissions/${commission._id}/aprobar`).send({ installmentIndex: 0, observacion: 'Soportes completos' });
    expect(approved.statusCode).toBe(200);
    const paid = await post(`/api/commissions/${commission._id}/pagar`).send({ installmentIndex: 0 });
    expect(paid.statusCode).toBe(200);

    const logs = await logsFor(commission);
    expect(logs.map((l) => l.action)).toEqual(['APPROVE_COMMISSION', 'PAY_COMMISSION']);
    expect(logs[0].details).toMatchObject({ billingNumber: 11, amount: 100000, milestone: 'QUOTA_4', note: 'Soportes completos' });
    expect(logs[1].companyId.toString()).toBe(String(owner.companyId));
  });

  it('records the rejection with its reason', async () => {
    const commission = await filedCommission(12);

    const rejected = await post(`/api/commissions/${commission._id}/rechazar`).send({ installmentIndex: 0, rejectedReason: 'Falta el RUT' });
    expect(rejected.statusCode).toBe(200);

    const logs = await logsFor(commission);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('REJECT_COMMISSION');
    expect(logs[0].details).toMatchObject({ billingNumber: 12, reason: 'Falta el RUT' });
  });

  it('records nothing when the action is refused', async () => {
    const commission = await filedCommission(13);

    const res = await post(`/api/commissions/${commission._id}/pagar`).send({ installmentIndex: 0 });
    expect(res.statusCode).toBe(400);
    expect(await logsFor(commission)).toHaveLength(0);
  });
});
