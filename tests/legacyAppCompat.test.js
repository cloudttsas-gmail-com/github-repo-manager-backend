import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import Lot from '../src/models/Lot.js';
import Commission from '../src/models/Commission.js';

// app-dev keeps the previous app while Meta reviews Operix: these are the calls it still makes
const stamp = Date.now();
const password = 'Password123!';
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe('The previous app keeps working against the redesign API', () => {
  let owner;
  let scope;
  let ownerUserId;
  const auth = (req) => req.set('Authorization', `Bearer ${owner.token}`);
  const q = () => `companyId=${owner.companyId}`;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner', fullName: 'Owner', email: `owner.${stamp}@legacy.test`, password, confirmPassword: password,
      tenantName: `Tenant legacy ${stamp}`, companyName: `Company legacy ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    scope = { tenantId: owner.tenantId, companyId: owner.companyId };
    ownerUserId = (await User.findOne({ tenantId: owner.tenantId }))._id;

    // Three contracts 10, 20 and 75 days in arrears
    for (const [i, days] of [10, 20, 75].entries()) {
      const client = await Client.create({ ...scope, name: `Comprador ${i}`, idNumber: `L${stamp}${i}` });
      const contract = await Contract.create({ ...scope, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 1000000, sellerId: ownerUserId });
      await Quota.create({ ...scope, contract: contract._id, number: 1, type: 'normal', value: 100000, amountPaid: 0, status: 'pendiente', dueDate: daysAgo(days) });
    }
  });

  it('marks a commission paid without a date or method, as the previous app did', async () => {
    const commission = await Commission.create({
      ...scope, contractId: new mongoose.Types.ObjectId(), sellerId: ownerUserId, totalAmount: 100000,
      installments: [{ milestoneKey: 'QUOTA_NUMBER', quotaNumber: 1, amount: 100000, status: 'APPROVED', billingNumber: 1 }],
    });
    const res = await auth(request(app).post(`/api/commissions/${commission._id}/pagar?${q()}`)).send({ installmentIndex: 0 });
    expect(res.statusCode).toBe(200);
    const paid = (await Commission.findById(commission._id)).installments[0];
    expect(paid.status).toBe('PAID');
    expect(paid.paymentDate).toBeInstanceOf(Date);
    expect(paid.paymentMethod).toBe('Sin registrar');
  });

  it('still refuses a blank date or method from the current app', async () => {
    const commission = await Commission.create({
      ...scope, contractId: new mongoose.Types.ObjectId(), sellerId: ownerUserId, totalAmount: 100000,
      installments: [{ milestoneKey: 'QUOTA_NUMBER', quotaNumber: 1, amount: 100000, status: 'APPROVED', billingNumber: 2 }],
    });
    const res = await auth(request(app).post(`/api/commissions/${commission._id}/pagar?${q()}`)).send({ installmentIndex: 0, paymentDate: '', paymentMethod: '' });
    expect([res.statusCode, res.body.message]).toEqual([400, 'La fecha del pago es obligatoria']);
  });

  it('gives Inicio both the current and the previous arrears ranges', async () => {
    const res = await auth(request(app).get(`/api/dashboard/summary?${q()}`));
    expect(res.statusCode).toBe(200);
    const { mora } = res.body.data;
    expect([mora.contratosMora1a30, mora.contratosMora61a90]).toEqual([2, 1]);
    expect([mora.contratosMora1a15, mora.contratosMora16a30, mora.contratosMora31a60, mora.contratosMora60plus]).toEqual([1, 1, 0, 1]);
  });

  it('filters Cartera by the previous 1-15 and 16-30 ranges', async () => {
    const r15 = await auth(request(app).get(`/api/clients?${q()}&moraRange=MORA_1_15`));
    const r30 = await auth(request(app).get(`/api/clients?${q()}&moraRange=MORA_16_30`));
    const names = (r) => (r.body.data.clients || r.body.data).map((c) => c.name);
    expect(names(r15)).toEqual(['Comprador 0']);
    expect(names(r30)).toEqual(['Comprador 1']);
  });

  it('reserves in the name of whoever registers it when the previous app sends no seller, and with none when the current app says so', async () => {
    const make = (n) => Lot.create({ ...scope, stage: 'Fase 1', nomenclature: 'Manzana L', lotNumber: `R${stamp}${n}`, area: 100, price: 1000000 });
    const clientData = (n) => ({ name: `Reserva ${n}`, idNumber: `RS${stamp}${n}`, phone: '3001234567' });
    const legacyLot = await make(1);
    const currentLot = await make(2);

    const legacy = await auth(request(app).post(`/api/lots/${legacyLot._id}/reserve?${q()}`)).send({ type: 'apartado', clientData: clientData(1) });
    const current = await auth(request(app).post(`/api/lots/${currentLot._id}/reserve?${q()}`)).send({ type: 'apartado', clientData: clientData(2), sellerId: '' });
    expect([legacy.statusCode, current.statusCode]).toEqual([200, 200]);
    expect(String((await Lot.findById(legacyLot._id)).sellerId)).toBe(String(ownerUserId));
    expect((await Lot.findById(currentLot._id)).sellerId).toBeUndefined();
  });
});
