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

const stamp = Date.now();
const password = 'Password123!';
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// Counters must cover every client and payment of the project, not the page on screen
describe('Clientes, Cartera and Pagos counters cover the whole project', () => {
  let owner;
  let scope;

  const auth = (req) => req.set('Authorization', `Bearer ${owner.token}`);

  // A client with one contract whose only quota is due `overdueDays` ago (0: not due yet)
  const clientWithQuota = async (n, overdueDays, behavior = 'INDECISO') => {
    const client = await Client.create({ ...scope, name: `Total Buyer ${n}`, idNumber: `T${stamp}${n}`, phone: `30000000${n}`, behavior });
    const contract = await Contract.create({ ...scope, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 1000000 });
    await Quota.create({
      ...scope, contract: contract._id, number: 1, type: 'normal', value: 1000000, amountPaid: 0, status: 'pendiente',
      dueDate: overdueDays > 0 ? daysAgo(overdueDays) : daysAgo(-20),
    });
    return { client, contract };
  };

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner totals', fullName: 'Owner totals', email: `owner.${stamp}@totals.test`,
      password, confirmPassword: password,
      tenantName: `Tenant totals ${stamp}`, companyName: `Company totals ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    scope = { tenantId: owner.tenantId, companyId: owner.companyId };
    const { client, contract } = await clientWithQuota(1, 0, 'DISPUESTO');
    await clientWithQuota(2, 0, 'DISPUESTO');
    await clientWithQuota(3, 10, 'EVASIVO');
    await clientWithQuota(4, 45);
    await clientWithQuota(5, 120);
    const base = { ...scope, contractId: contract._id, clientId: client._id, amount: 1000, banco: 'NEQUI', paymentMethod: 'Transferencia bancaria', fechaPago: new Date() };
    await PaymentAttempt.create([
      { ...base, status: 'PENDIENTE', quotaValue: 1000, appliedToQuotas: false },
      { ...base, status: 'PENDIENTE', quotaValue: 1000, appliedToQuotas: false },
      { ...base, status: 'APROBADO', appliedToQuotas: true },
      { ...base, status: 'RECHAZADO', appliedToQuotas: false },
    ]);
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
    await UserAccount.deleteMany({ email: /totals\.test$/ });
  });

  it('client stats count every client, by arrears, range and behavior', async () => {
    const res = await auth(request(app).get(`/api/clients/stats?companyId=${owner.companyId}`));
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      total: 5, alDia: 2, enMora: 3,
      behavior: { DISPUESTO: 2, EVASIVO: 1, INDECISO: 2 },
      moraRanges: { MORA_1_15: 1, MORA_16_30: 0, MORA_31_60: 1, MORA_61_90: 0, MORA_90_PLUS: 1 },
    });
  });

  it('the list brings the days in arrears of each client', async () => {
    const res = await auth(request(app).get(`/api/clients?companyId=${owner.companyId}&limit=2&sortBy=diasMora&order=desc`));
    expect(res.body.data.pagination.total).toBe(5);
    expect(res.body.data.clients.map((c) => c.diasMora)).toEqual([120, 45]);
  });

  it('the arrears range is filtered on the server, so the total and pages follow it', async () => {
    const res = await auth(request(app).get(`/api/clients?companyId=${owner.companyId}&limit=1&moraRange=MORA_31_60`));
    expect(res.body.data.pagination.total).toBe(1);
    expect(res.body.data.clients[0].diasMora).toBe(45);
  });

  it('payment counters count all payments, whatever page or status is shown', async () => {
    const res = await auth(request(app).get(`/api/payments/all?companyId=${owner.companyId}&limit=1&status=RECHAZADO`));
    expect(res.statusCode).toBe(200);
    expect(res.body.data.pagination.total).toBe(1);
    expect(res.body.data.statusCounts).toEqual({ PENDIENTE: 2, PAGADO: 1, RECHAZADO: 1 });
  });
});
