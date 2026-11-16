import 'dotenv/config';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { generateAccessToken } from '../src/utils/jwt.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import Lot from '../src/models/Lot.js';
import PaymentAttempt from '../src/models/PaymentAttempt.js';
import CollectionAction from '../src/models/CollectionAction.js';

const stamp = Date.now();
const password = 'Password123!';
const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n) => new Date(Date.now() + n * DAY);
const isoDay = (date) => date.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

const register = async (tag) => {
  const res = await request(app).post('/api/auth/register').send({
    name: `Owner ${tag}`, fullName: `Owner ${tag}`, email: `owner.${tag}.${stamp}@gest.test`,
    password, confirmPassword: password,
    tenantName: `Tenant gest ${tag} ${stamp}`, companyName: `Company gest ${tag} ${stamp}`,
  });
  const company = res.body.data.company;
  return { token: res.body.data.accessToken, companyId: String(company._id), tenantId: String(company.tenantId) };
};

const addMember = async (org, role, tag) => {
  const account = await UserAccount.create({ email: `${tag}.${stamp}@gest.test`, passwordHash: password, fullName: `Miembro ${tag}`, status: 'active' });
  const user = await User.create({ accountId: account._id, tenantId: org.tenantId, role, status: 'active' });
  await UserCompany.create({ userId: user._id, companyId: org.companyId, tenantId: org.tenantId, role });
  const token = generateAccessToken({ accountId: account._id, userId: user._id, tenantId: org.tenantId, role, companies: [org.companyId] });
  return { token, userId: String(user._id) };
};

describe('Collection actions, promises and Pendientes', () => {
  let a;
  let b;
  let seller;
  let otherSeller;
  let cartera;
  let buyer;
  let contract;
  let otherBuyer;
  let otherContract;
  const q = (org) => `companyId=${org.companyId}`;

  beforeAll(async () => {
    a = await register('a');
    b = await register('b');
    seller = await addMember(a, 'vendedor', 'seller');
    otherSeller = await addMember(a, 'vendedor', 'other');
    cartera = await addMember(a, 'jefe_cartera', 'cartera');

    buyer = await Client.create({ tenantId: a.tenantId, companyId: a.companyId, name: 'Ana Gestion', idNumber: `G${stamp}`, phone: '3001112233' });
    otherBuyer = await Client.create({ tenantId: a.tenantId, companyId: a.companyId, name: 'Beto (Otro) +', idNumber: `H${stamp}`, phone: '3004445566' });
    contract = await Contract.create({ tenantId: a.tenantId, companyId: a.companyId, client: buyer._id, lot: new mongoose.Types.ObjectId(), totalValue: 500000, sellerId: seller.userId });
    otherContract = await Contract.create({ tenantId: a.tenantId, companyId: a.companyId, client: otherBuyer._id, lot: new mongoose.Types.ObjectId(), totalValue: 300000, sellerId: otherSeller.userId });
    // The other buyer also bought from `seller`: the record must hide `otherContract` from `seller`
    await Contract.create({ tenantId: a.tenantId, companyId: a.companyId, client: otherBuyer._id, lot: new mongoose.Types.ObjectId(), totalValue: 100000, sellerId: seller.userId });
    await Quota.insertMany([
      { tenantId: a.tenantId, companyId: a.companyId, contract: contract._id, number: 1, type: 'normal', value: 100000, status: 'pendiente', dueDate: daysFromNow(-5) },
      { tenantId: a.tenantId, companyId: a.companyId, contract: contract._id, number: 2, type: 'normal', value: 100000, status: 'pendiente', dueDate: daysFromNow(25) },
    ]);
    await Lot.create({ tenantId: a.tenantId, companyId: a.companyId, stage: 'E1', lotNumber: `L${stamp}`, area: 100, price: 1000, status: 'apartado', expiresAt: daysFromNow(1), sellerId: seller.userId });
    await PaymentAttempt.create({
      tenantId: a.tenantId, companyId: a.companyId, contractId: contract._id, clientId: buyer._id, amount: 50000,
      banco: 'Banco', paymentMethod: 'transferencia', fechaPago: new Date(), status: 'PENDIENTE',
    });
  });

  afterAll(async () => {
    const tenantIds = [a?.tenantId, b?.tenantId].filter(Boolean);
    await CollectionAction.deleteMany({ tenantId: { $in: tenantIds } });
    await PaymentAttempt.deleteMany({ tenantId: { $in: tenantIds } });
    await Lot.deleteMany({ tenantId: { $in: tenantIds } });
    await Quota.deleteMany({ tenantId: { $in: tenantIds } });
    await Contract.deleteMany({ tenantId: { $in: tenantIds } });
    await Client.deleteMany({ tenantId: { $in: tenantIds } });
    await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
    await User.deleteMany({ tenantId: { $in: tenantIds } });
    await Company.deleteMany({ tenantId: { $in: tenantIds } });
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    await UserAccount.deleteMany({ email: /gest\.test$/ });
  });

  describe('POST /api/collection-actions', () => {
    it('records an action with a promise and validates it', async () => {
      const bad = await request(app).post(`/api/collection-actions?${q(a)}`).set('Authorization', `Bearer ${a.token}`)
        .send({ clientId: buyer._id, channel: 'llamada', result: 'promesa', promise: { amount: 0, dueDate: isoDay(new Date()) } });
      expect(bad.statusCode).toBe(400);

      const past = await request(app).post(`/api/collection-actions?${q(a)}`).set('Authorization', `Bearer ${a.token}`)
        .send({ clientId: buyer._id, channel: 'llamada', result: 'promesa', promise: { amount: 1000, dueDate: isoDay(daysFromNow(-2)) } });
      expect(past.statusCode).toBe(400);

      const ok = await request(app).post(`/api/collection-actions?${q(a)}`).set('Authorization', `Bearer ${a.token}`)
        .send({ clientId: buyer._id, contractId: contract._id, channel: 'llamada', result: 'promesa', notes: '  Paga el viernes  ', promise: { amount: 80000, dueDate: isoDay(new Date()) } });
      expect(ok.statusCode).toBe(201);
      expect(ok.body.data).toMatchObject({ channel: 'llamada', result: 'promesa', notes: 'Paga el viernes' });
    });

    it('rejects a contract of another client, a client of another org and unknown values', async () => {
      const wrongContract = await request(app).post(`/api/collection-actions?${q(a)}`).set('Authorization', `Bearer ${a.token}`)
        .send({ clientId: buyer._id, contractId: otherContract._id, channel: 'llamada', result: 'contactado' });
      expect(wrongContract.statusCode).toBe(400);
      const crossOrg = await request(app).post(`/api/collection-actions?${q(b)}`).set('Authorization', `Bearer ${b.token}`)
        .send({ clientId: buyer._id, channel: 'llamada', result: 'contactado' });
      expect(crossOrg.statusCode).toBe(404);
      const badChannel = await request(app).post(`/api/collection-actions?${q(a)}`).set('Authorization', `Bearer ${a.token}`)
        .send({ clientId: buyer._id, channel: 'paloma', result: 'contactado' });
      expect(badChannel.statusCode).toBe(400);
    });

    it('a seller records actions only on the clients of their sales', async () => {
      const own = await request(app).post(`/api/collection-actions?${q(a)}`).set('Authorization', `Bearer ${seller.token}`)
        .send({ clientId: buyer._id, channel: 'whatsapp', result: 'no_contesta' });
      expect(own.statusCode).toBe(201);
      const notOwn = await request(app).post(`/api/collection-actions?${q(a)}`).set('Authorization', `Bearer ${otherSeller.token}`)
        .send({ clientId: buyer._id, channel: 'whatsapp', result: 'no_contesta' });
      expect(notOwn.statusCode).toBe(403);
    });
  });

  describe('GET /api/collection-actions', () => {
    it('lists the actions with the promise state, and sellers see only their clients', async () => {
      const all = await request(app).get(`/api/collection-actions?${q(a)}&clientId=${buyer._id}`).set('Authorization', `Bearer ${a.token}`);
      expect(all.statusCode).toBe(200);
      expect(all.body.data.actions.length).toBe(2);
      const promise = all.body.data.actions.find((action) => action.result === 'promesa');
      expect(promise.promiseState).toBe('vigente');
      expect(promise.client.name).toBe('Ana Gestion');

      const other = await request(app).get(`/api/collection-actions?${q(a)}`).set('Authorization', `Bearer ${otherSeller.token}`);
      expect(other.statusCode).toBe(200);
      expect(other.body.data.actions.length).toBe(0);
    });

    it('a promise is kept once approved payments in its window reach the amount', async () => {
      await PaymentAttempt.create({
        tenantId: a.tenantId, companyId: a.companyId, contractId: contract._id, clientId: buyer._id, amount: 80000,
        banco: 'Banco', paymentMethod: 'transferencia', fechaPago: new Date(), status: 'APROBADO',
      });
      const kept = await request(app).get(`/api/collection-actions?${q(a)}&promise=cumplida`).set('Authorization', `Bearer ${a.token}`);
      expect(kept.statusCode).toBe(200);
      expect(kept.body.data.actions.length).toBe(1);
      expect(kept.body.data.actions[0].promisePaid).toBe(80000);
      await PaymentAttempt.deleteMany({ tenantId: a.tenantId, status: 'APROBADO' });
    });

    it('a broken promise followed by a newer one is replaced, not counted as broken', async () => {
      await CollectionAction.create({
        tenantId: a.tenantId, companyId: a.companyId, clientId: buyer._id, channel: 'visita', result: 'promesa',
        promise: { amount: 50000, dueDate: daysFromNow(-3) }, createdBy: new mongoose.Types.ObjectId(), createdAt: daysFromNow(-6),
      });
      const replaced = await request(app).get(`/api/collection-actions?${q(a)}&promise=reemplazada`).set('Authorization', `Bearer ${a.token}`);
      expect(replaced.body.data.actions.length).toBe(1);
      const broken = await request(app).get(`/api/collection-actions?${q(a)}&promise=incumplida`).set('Authorization', `Bearer ${a.token}`);
      expect(broken.body.data.actions.length).toBe(0);
    });

    it('a broken promise with no newer one is broken; one payment keeps only one of two promises', async () => {
      await CollectionAction.create([
        { tenantId: a.tenantId, companyId: a.companyId, clientId: otherBuyer._id, channel: 'llamada', result: 'promesa',
          promise: { amount: 40000, dueDate: daysFromNow(-2) }, createdBy: new mongoose.Types.ObjectId(), createdAt: daysFromNow(-9) },
      ]);
      const broken = await request(app).get(`/api/collection-actions?${q(a)}&promise=incumplida`).set('Authorization', `Bearer ${a.token}`);
      expect(broken.body.data.actions.map((x) => String(x.clientId))).toEqual([String(otherBuyer._id)]);
      await CollectionAction.deleteMany({ clientId: otherBuyer._id });

      // Two open promises of 30.000 for the same client; one approved payment of 30.000 keeps only the older
      await CollectionAction.create([
        { tenantId: a.tenantId, companyId: a.companyId, clientId: otherBuyer._id, channel: 'llamada', result: 'promesa',
          promise: { amount: 30000, dueDate: daysFromNow(5) }, createdBy: new mongoose.Types.ObjectId(), createdAt: daysFromNow(-2) },
        { tenantId: a.tenantId, companyId: a.companyId, clientId: otherBuyer._id, channel: 'llamada', result: 'promesa',
          promise: { amount: 30000, dueDate: daysFromNow(6) }, createdBy: new mongoose.Types.ObjectId(), createdAt: daysFromNow(-1) },
      ]);
      await PaymentAttempt.create({
        tenantId: a.tenantId, companyId: a.companyId, contractId: otherContract._id, clientId: otherBuyer._id, amount: 30000,
        banco: 'Banco', paymentMethod: 'transferencia', fechaPago: new Date(), status: 'APROBADO',
      });
      const list = await request(app).get(`/api/collection-actions?${q(a)}&clientId=${otherBuyer._id}`).set('Authorization', `Bearer ${a.token}`);
      expect(list.body.data.actions.map((x) => x.promiseState).sort()).toEqual(['cumplida', 'vigente']);

      // A payment reported and waiting for approval puts the open one «en revisión»
      await PaymentAttempt.create({
        tenantId: a.tenantId, companyId: a.companyId, contractId: otherContract._id, clientId: otherBuyer._id, amount: 30000, quotaValue: 30000,
        banco: 'Banco', paymentMethod: 'transferencia', fechaPago: new Date(), status: 'PENDIENTE', appliedToQuotas: false,
      });
      const review = await request(app).get(`/api/collection-actions?${q(a)}&clientId=${otherBuyer._id}`).set('Authorization', `Bearer ${a.token}`);
      expect(review.body.data.actions.map((x) => x.promiseState).sort()).toEqual(['cumplida', 'en_revision']);
      await CollectionAction.deleteMany({ clientId: otherBuyer._id });
      await PaymentAttempt.deleteMany({ clientId: otherBuyer._id });
    });

    it('rejects promise dates beyond the limit and agents writing', async () => {
      const far = await request(app).post(`/api/collection-actions?${q(a)}`).set('Authorization', `Bearer ${a.token}`)
        .send({ clientId: buyer._id, channel: 'llamada', result: 'promesa', promise: { amount: 1000, dueDate: isoDay(daysFromNow(400)) } });
      expect(far.statusCode).toBe(400);
      const bad = await request(app).post(`/api/collection-actions?${q(a)}`).set('Authorization', `Bearer ${a.token}`)
        .send({ clientId: buyer._id, channel: 'llamada', result: 'promesa', promise: { amount: 1000, dueDate: '2026-13-45' } });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('GET /api/dashboard/pending', () => {
    const byKey = (res) => Object.fromEntries(res.body.data.items.map((item) => [item.key, item]));

    it('the owner sees payments to approve, promises, arrears, contracts without a plan and reservations', async () => {
      const res = await request(app).get(`/api/dashboard/pending?${q(a)}`).set('Authorization', `Bearer ${a.token}`);
      expect(res.statusCode).toBe(200);
      const items = byKey(res);
      expect(items.payments_to_approve.count).toBe(1);
      expect(items.promises_due_today.count).toBe(1);
      expect(items.promises_broken.count).toBe(0);
      expect(items.clients_in_arrears.count).toBe(1);
      expect(items.contracts_without_plan.count).toBe(2);
      expect(items.reservations_expiring.count).toBe(1);
    });

    it('a seller sees their own arrears and reservations, never payments to approve', async () => {
      const res = await request(app).get(`/api/dashboard/pending?${q(a)}`).set('Authorization', `Bearer ${seller.token}`);
      const items = byKey(res);
      expect(items.payments_to_approve).toBeUndefined();
      expect(items.my_clients_in_arrears.count).toBe(1);
      expect(items.my_reservations_expiring.count).toBe(1);
      const other = byKey(await request(app).get(`/api/dashboard/pending?${q(a)}`).set('Authorization', `Bearer ${otherSeller.token}`));
      expect(other.my_clients_in_arrears.count).toBe(0);
      expect(other.my_reservations_expiring.count).toBe(0);
    });

    it('cartera sees payments and promises but not commissions to pay', async () => {
      const items = byKey(await request(app).get(`/api/dashboard/pending?${q(a)}`).set('Authorization', `Bearer ${cartera.token}`));
      expect(items.payments_to_approve.count).toBe(1);
      expect(items.promises_due_today).toBeDefined();
      expect(items.commissions_to_pay).toBeUndefined();
    });
  });

  describe('record support', () => {
    it('GET /clients/:id gives a seller only their contracts and the summary quotas', async () => {
      const res = await request(app).get(`/api/clients/${otherBuyer._id}?${q(a)}`).set('Authorization', `Bearer ${seller.token}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.contracts.length).toBe(1);
      const own = await request(app).get(`/api/clients/${buyer._id}?${q(a)}`).set('Authorization', `Bearer ${a.token}`);
      expect(own.body.data.contracts[0].statement.quotas.map((quota) => quota.state)).toEqual(['mora', 'pendiente']);
      const bad = await request(app).get(`/api/clients/not-an-id?${q(a)}`).set('Authorization', `Bearer ${a.token}`);
      expect(bad.statusCode).toBe(404);
    });

    it('GET /payments/all?clientId= lists only that client', async () => {
      const res = await request(app).get(`/api/payments/all?${q(a)}&clientId=${buyer._id}`).set('Authorization', `Bearer ${a.token}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.payments.every((payment) => payment.contract.client.cedula === buyer.idNumber)).toBe(true);
    });

    it('searches with regex characters match literally instead of failing', async () => {
      const clients = await request(app).get(`/api/clients?${q(a)}&search=${encodeURIComponent('(Otro) +')}`).set('Authorization', `Bearer ${a.token}`);
      expect(clients.statusCode).toBe(200);
      expect(clients.body.data.clients.map((client) => client.name)).toEqual(['Beto (Otro) +']);
      const lots = await request(app).get(`/api/lots?${q(a)}&search=${encodeURIComponent('E1(')}`).set('Authorization', `Bearer ${a.token}`);
      expect(lots.statusCode).toBe(200);
    });
  });
});
