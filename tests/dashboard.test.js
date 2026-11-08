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
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

describe('Dashboard figures are calculated, not fixed at 0', () => {
  let owner;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner dash', fullName: 'Owner dash', email: `owner.${stamp}@dash.test`,
      password, confirmPassword: password,
      tenantName: `Tenant dash ${stamp}`, companyName: `Company dash ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    const scope = { tenantId: owner.tenantId, companyId: owner.companyId };
    const client = await Client.create({ ...scope, name: 'Dash Buyer', idNumber: `D${stamp}`, phone: '3000000000' });

    // Contract A: one quota 20 days overdue (1,000,000 pending, 200,000 paid on account)
    const a = await Contract.create({ ...scope, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 3000000 });
    await Quota.create({ ...scope, contract: a._id, number: 1, type: 'normal', value: 1200000, amountPaid: 200000, dueDate: daysAgo(20), status: 'pendiente' });
    await Quota.create({ ...scope, contract: a._id, number: 2, type: 'normal', value: 1800000, dueDate: daysAgo(-20), status: 'pendiente' });
    // Contract B: up to date, with a payment approved today
    const b = await Contract.create({ ...scope, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 2000000 });
    const paid = await Quota.create({ ...scope, contract: b._id, number: 1, type: 'normal', value: 2000000, amountPaid: 2000000, dueDate: daysAgo(-5), status: 'pagado' });
    await PaymentAttempt.create({
      ...scope, contractId: b._id, clientId: client._id, quotas: [{ quotaId: paid._id, amount: 2000000 }], amount: 2000000,
      banco: 'NEQUI', paymentMethod: 'Transferencia bancaria', fechaPago: new Date(), status: 'APROBADO', appliedToQuotas: true,
    });
    await PaymentAttempt.create({
      ...scope, contractId: a._id, clientId: client._id, quotas: [{ quotaId: paid._id, amount: 1 }], amount: 1, quotaValue: 1,
      banco: 'NEQUI', paymentMethod: 'Transferencia bancaria', fechaPago: new Date(), status: 'PENDIENTE', appliedToQuotas: false,
    });
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
    await UserAccount.deleteMany({ email: /dash\.test$/ });
  });

  it('the summary reports overdue, collected and pending payments', async () => {
    const res = await request(app).get(`/api/dashboard/summary?companyId=${owner.companyId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(res.statusCode).toBe(200);
    const { mora, recaudoMensual, operacion, cartera } = res.body.data;
    expect(mora).toMatchObject({ contratosAlDia: 1, contratosMora16a30: 1, contratosMora1a15: 0, porcentajeMora: 50, dineroEnMora: 1000000 });
    expect(recaudoMensual.mesActual).toBe(2000000);
    expect(recaudoMensual.variacion).toBeNull();
    expect(operacion.comprobantesPendientes).toBe(1);
    // partial payments count in what was collected
    expect(cartera.totalRecaudado).toBe(2200000);
  });

  it('the monthly chart has the last six months with what fell due', async () => {
    const res = await request(app).get(`/api/dashboard/recaudo-mensual?companyId=${owner.companyId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(res.statusCode).toBe(200);
    const months = res.body.data.data;
    expect(months).toHaveLength(6);
    expect(months[5].recaudado).toBe(2000000);
    expect(months.every((m) => typeof m.mes === 'string' && typeof m.meta === 'number')).toBe(true);
  });
});
