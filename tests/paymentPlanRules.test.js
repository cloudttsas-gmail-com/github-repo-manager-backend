import 'dotenv/config';
import { jest } from '@jest/globals';
import request from 'supertest';
import mongoose from 'mongoose';

// No R2 in tests: documents "upload" to a fake URL
jest.unstable_mockModule('../src/utils/storage.js', () => ({
  buildObjectKey: (folder) => `${folder}/test`,
  uploadToR2: async (file, folder) => `https://files.test/${folder}/test.pdf`,
  deleteFromR2: async () => {},
  default: {},
}));
const { default: app } = await import('../src/app.js');
const rules = await import('../src/services/paymentPlanRules.js');
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import Lot from '../src/models/Lot.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import PaymentAttempt from '../src/models/PaymentAttempt.js';
import AuditLog from '../src/models/AuditLog.js';

const { buildSalePlan, firstOrdinaryDate, recalculateOrdinariesAfterInitial, rebuildOrdinariesForOtrosi, toCalendarDate, toISODate, fromCalendarDate } = rules;
const iso = (date) => toISODate(toCalendarDate(date));
const SALE = '2026-11-05';
const first = (initialEnd, paymentDay, earlyStart) => iso(fromCalendarDate(firstOrdinaryDate({
  initialEnd, saleDate: SALE, paymentDay, minDays: 30, earlyStart,
})));

describe('Payment plan rules (pure date math)', () => {
  it('case A: initial paid on time, day 5 -> 5 Jan 2027 with or without early start', () => {
    expect(first('2026-12-05', 5, false)).toBe('2027-01-05');
    expect(first('2026-12-05', 5, true)).toBe('2027-01-05');
  });

  it('case B: initial finished on 20 Nov, day 5 -> 5 Jan 2027, early start 5 Dec 2026', () => {
    expect(first('2026-11-20', 5, false)).toBe('2027-01-05');
    expect(first('2026-11-20', 5, true)).toBe('2026-12-05');
  });

  it('case C: day 30 -> 30 Jan 2027, early start 30 Dec 2026', () => {
    expect(first('2026-12-05', 30, false)).toBe('2027-01-30');
    expect(first('2026-12-05', 30, true)).toBe('2026-12-30');
  });

  it('case D: deadline extended to 60 days, day 15 -> 15 Feb 2027, early start 15 Jan 2027', () => {
    expect(first('2027-01-04', 15, false)).toBe('2027-02-15');
    expect(first('2027-01-04', 15, true)).toBe('2027-01-15');
  });

  it('never falls in the month of the sale', () => {
    // A 3-day deadline with early start would allow 15 Nov; the sale was in November
    expect(first('2026-11-08', 15, true)).toBe('2026-12-15');
  });

  it('day 30 falls on the last day of February and comes back to 30 in March', () => {
    const plan = buildSalePlan({
      saleDate: SALE, totalValue: 10000000, initialQuotaPercentage: 30, installmentsCount: 4, paymentDay: 30, policy: {},
    });
    const ordinary = plan.quotas.filter((q) => q.type === 'normal').map((q) => iso(q.dueDate));
    expect(ordinary).toEqual(['2027-01-30', '2027-02-28', '2027-03-30', '2027-04-30']);
    expect(iso(plan.initialDeadline)).toBe('2026-12-05');
  });

  it('leap years use 29 February', () => {
    const plan = buildSalePlan({
      saleDate: '2027-11-05', totalValue: 10000000, initialQuotaPercentage: 30, installmentsCount: 4, paymentDay: 30, policy: {},
    });
    expect(plan.quotas.filter((q) => q.type === 'normal').map((q) => iso(q.dueDate))[1]).toBe('2028-02-29');
  });

  it('free mode: one initial quota (minus separation) due at the deadline', () => {
    const plan = buildSalePlan({
      saleDate: SALE, totalValue: 10000000, initialQuotaPercentage: 30, separationAmount: 500000, installmentsCount: 12, paymentDay: 5, policy: {},
    });
    const initial = plan.quotas.filter((q) => q.type === 'inicial');
    expect(initial).toHaveLength(2);
    expect(initial[0]).toMatchObject({ number: 0, value: 500000, status: 'pagado' });
    expect(initial[1]).toMatchObject({ number: 1, value: 2500000, status: 'pendiente' });
    expect(iso(initial[1].dueDate)).toBe('2026-12-05');
    const ordinary = plan.quotas.filter((q) => q.type === 'normal');
    expect(ordinary).toHaveLength(12);
    expect(ordinary.reduce((s, q) => s + q.value, 0)).toBe(7000000);
    expect(iso(ordinary[0].dueDate)).toBe('2027-01-05');
  });

  it('the plan always adds up to the sale value: bad separation or no ordinary quotas are rejected', () => {
    const base = { saleDate: SALE, totalValue: 30000000, initialQuotaPercentage: 10, installmentsCount: 12, paymentDay: 5, policy: {} };
    expect(() => buildSalePlan({ ...base, separationAmount: 5000000 })).toThrow('La separación no puede ser mayor que la cuota inicial');
    expect(() => buildSalePlan({ ...base, separationAmount: -1000000 })).toThrow('La separación no puede ser negativa');
    expect(() => buildSalePlan({ ...base, installmentsCount: 0 })).toThrow('número de cuotas ordinarias');
    const sum = (plan) => plan.quotas.reduce((s, q) => s + q.value, 0);
    expect(sum(buildSalePlan({ ...base, separationAmount: 3000000 }))).toBe(30000000);
    expect(sum(buildSalePlan({ ...base, initialQuotaPercentage: 100, installmentsCount: 0 }))).toBe(30000000);
    // quotas are rounded to thousands (existing rule), so the plan adds up to the rounded value
    expect(sum(buildSalePlan({ ...base, totalValue: 10000400, installmentsCount: 7 }))).toBe(10000000);
    expect(sum(buildSalePlan({ ...base, totalValue: 10000600, initialQuotaPercentage: 15, installmentsCount: 7 }))).toBe(10001000);
  });

  it('an empty list of payment days is rejected', () => {
    expect(() => rules.validatePaymentPlanPolicy({ allowedPaymentDays: [] })).toThrow('al menos un día de pago');
  });

  it('early start only when the project allows it', () => {
    expect(() => buildSalePlan({
      saleDate: SALE, totalValue: 1000000, initialQuotaPercentage: 30, installmentsCount: 2, paymentDay: 30, earlyStart: true, policy: {},
    })).toThrow(/no permite empezar/);
    const plan = buildSalePlan({
      saleDate: SALE, totalValue: 1000000, initialQuotaPercentage: 30, installmentsCount: 2, paymentDay: 30, earlyStart: true, policy: { allowEarlyStart: true },
    });
    expect(iso(plan.firstOrdinaryDate)).toBe('2026-12-30');
  });

  it('the payment day must be one of the allowed days', () => {
    expect(() => buildSalePlan({
      saleDate: SALE, totalValue: 1000000, initialQuotaPercentage: 30, installmentsCount: 2, paymentDay: 10, policy: {},
    })).toThrow(/5, 15, 20, 30/);
    const plan = buildSalePlan({
      saleDate: SALE, totalValue: 1000000, initialQuotaPercentage: 30, installmentsCount: 2, paymentDay: 10, policy: { allowedPaymentDays: [10, 25] },
    });
    expect(iso(plan.firstOrdinaryDate)).toBe('2027-01-10');
  });

  it('fixed mode: N monthly initial quotas within the deadline', () => {
    const plan = buildSalePlan({
      saleDate: SALE, totalValue: 10000000, initialQuotaPercentage: 30, installmentsCount: 2, paymentDay: 5,
      policy: { initialDeadlineDays: 90, initialQuotaMode: 'fixed' }, initialQuotasCount: 3,
    });
    const initial = plan.quotas.filter((q) => q.type === 'inicial');
    expect(initial.map((q) => iso(q.dueDate))).toEqual(['2026-12-05', '2027-01-05', '2027-02-03']);
    expect(initial.map((q) => q.value)).toEqual([1000000, 1000000, 1000000]);
    expect(iso(plan.firstOrdinaryDate)).toBe('2027-03-05');
  });

  it('fixed mode cannot go past the deadline and the mode follows the project', () => {
    expect(() => buildSalePlan({
      saleDate: SALE, totalValue: 10000000, initialQuotaPercentage: 30, installmentsCount: 2, paymentDay: 5,
      policy: { initialQuotaMode: 'fixed' }, initialQuotasCount: 2,
    })).toThrow(/no caben 2 cuotas/);
    expect(() => buildSalePlan({
      saleDate: SALE, totalValue: 10000000, initialQuotaPercentage: 30, installmentsCount: 2, paymentDay: 5,
      policy: {}, initialQuotaMode: 'fixed',
    })).toThrow(/no permite cambiar el modo/);
  });

  it('the maximum of ordinary quotas is the lot one, lowered by the project policy', () => {
    expect(() => buildSalePlan({
      saleDate: SALE, totalValue: 1000000, initialQuotaPercentage: 30, installmentsCount: 13, paymentDay: 5,
      policy: { maxOrdinaryQuotas: 12 }, maxInstallments: 24,
    })).toThrow(/máximo de cuotas permitido es 12/);
  });

  it('recalculation after the initial: uses the completion date, not a late one, and skips ordinaries with payments', () => {
    const base = [
      { type: 'inicial', number: 1, status: 'pagado', dueDate: new Date('2026-12-05T17:00:00Z'), paymentDate: new Date('2026-11-20T17:00:00Z') },
      { type: 'normal', number: 1, status: 'pendiente', dueDate: new Date('2027-01-30T17:00:00Z') },
      { type: 'normal', number: 2, status: 'pendiente', dueDate: new Date('2027-02-28T17:00:00Z') },
    ];
    const result = recalculateOrdinariesAfterInitial({ quotas: base, saleDate: SALE, paymentDay: 30, minDays: 30, earlyStart: false });
    expect(result.changes.map((c) => iso(c.to))).toEqual(['2026-12-30', '2027-01-30']);

    const late = base.map((q) => (q.type === 'inicial' ? { ...q, paymentDate: new Date('2027-01-20T17:00:00Z') } : q));
    expect(recalculateOrdinariesAfterInitial({ quotas: late, saleDate: SALE, paymentDay: 30, minDays: 30, earlyStart: false }).changes).toHaveLength(0);

    const withPayment = base.map((q) => (q.type === 'normal' && q.number === 1 ? { ...q, amountPaid: 1000 } : q));
    expect(recalculateOrdinariesAfterInitial({ quotas: withPayment, saleDate: SALE, paymentDay: 30, minDays: 30, earlyStart: false })).toBeNull();
  });

  it('otrosí rebuild never touches paid quotas and never makes a quota due earlier', () => {
    const quotas = [
      { _id: 'a', type: 'normal', number: 1, status: 'pagado', amountPaid: 1000000, value: 1000000, dueDate: new Date('2027-01-30T17:00:00Z') },
      { _id: 'b', type: 'normal', number: 2, status: 'pendiente', value: 1000000, dueDate: new Date('2027-02-28T17:00:00Z') },
      { _id: 'c', type: 'normal', number: 3, status: 'pendiente', value: 1000000, dueDate: new Date('2027-03-30T17:00:00Z') },
    ];
    const plan = rebuildOrdinariesForOtrosi({ quotas, paymentDay: 5 });
    expect(plan.kept.map((q) => q._id)).toEqual(['a']);
    expect(plan.update.map((u) => iso(u.dueDate))).toEqual(['2027-03-05', '2027-04-05']);
    const longer = rebuildOrdinariesForOtrosi({ quotas, paymentDay: 30, installmentsCount: 5 });
    expect(longer.update).toHaveLength(2);
    expect(longer.create.map((q) => q.number)).toEqual([4, 5]);
    expect([...longer.update, ...longer.create].reduce((s, q) => s + q.value, 0)).toBe(2000000);
  });
});

const stamp = Date.now();
const password = 'Password123!';
const email = (name) => `${name}.${stamp}@plan.test`;

const registerTenant = async (name) => {
  const res = await request(app).post('/api/auth/register').send({
    name: `Owner ${name}`, fullName: `Owner ${name}`, email: email(`owner-${name}`), password, confirmPassword: password,
    tenantName: `Tenant plan ${name} ${stamp}`, companyName: `Company plan ${name} ${stamp}`,
  });
  if (!res.body.success) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
};

const createMemberToken = async (owner, role) => {
  const res = await request(app).post(`/api/admin-users/create?companyId=${owner.companyId}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ password, companyIds: [owner.companyId], fullName: `Member ${role}`, email: email(role), role });
  if (res.statusCode !== 201) throw new Error(`member failed: ${JSON.stringify(res.body)}`);
  const login = await request(app).post('/api/auth/admin/login').send({ email: email(role), password });
  return login.body.data.accessToken;
};

describe('Payment plan rules (API)', () => {
  let a;
  let b;
  let gerenteToken;
  let jefeToken;
  let client;
  let lotCounter = 0;

  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const newLot = () => Lot.create({
    tenantId: a.tenantId, companyId: a.companyId, lotNumber: `P${stamp}-${++lotCounter}`, manzana: 'M1', area: 100, price: 10000000, status: 'disponible',
  });
  const sell = (lot, body = {}) => request(app).post(`/api/lots/${lot._id}/sell?companyId=${a.companyId}`)
    .set(auth(a.token))
    .send({ clientId: client._id.toString(), totalValue: 10000000, initialQuotaPercentage: 30, installmentsCount: 4, contractDate: SALE, paymentDay: 30, ...body });
  const quotasOf = (contractId) => Quota.find({ contract: contractId }).sort({ type: 1, number: 1 });
  const payManual = (quotaId, amount, paymentDate) => request(app).post(`/api/payments/manual?companyId=${a.companyId}`)
    .set(auth(a.token))
    .send({ quotaId: quotaId.toString(), amount, bank: 'Efectivo', paymentMethod: 'Efectivo', paymentDate });

  beforeAll(async () => {
    a = await registerTenant('a');
    b = await registerTenant('b');
    gerenteToken = await createMemberToken(a, 'gerente');
    jefeToken = await createMemberToken(a, 'jefe_cartera');
    client = await Client.create({ tenantId: a.tenantId, companyId: a.companyId, name: 'Plan Buyer', idNumber: `PL${stamp}`, phone: '3000000000' });
  });

  afterAll(async () => {
    const tenantIds = [a?.tenantId, b?.tenantId].filter(Boolean);
    await PaymentAttempt.deleteMany({ tenantId: { $in: tenantIds } });
    await Quota.deleteMany({ tenantId: { $in: tenantIds } });
    await Contract.deleteMany({ tenantId: { $in: tenantIds } });
    await Lot.deleteMany({ tenantId: { $in: tenantIds } });
    await Client.deleteMany({ tenantId: { $in: tenantIds } });
    await AuditLog.deleteMany({ tenantId: { $in: tenantIds } });
    await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
    await User.deleteMany({ tenantId: { $in: tenantIds } });
    await Company.deleteMany({ tenantId: { $in: tenantIds } });
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    await UserAccount.deleteMany({ email: /plan\.test$/ });
  });

  describe('project policy', () => {
    it('returns the defaults and lets only configuration roles change it', async () => {
      const res = await request(app).get(`/api/payment-plan/policy?companyId=${a.companyId}`).set(auth(jefeToken));
      expect(res.statusCode).toBe(200);
      expect(res.body.data.policy).toMatchObject({
        initialDeadlineDays: 30, allowedPaymentDays: [5, 15, 20, 30], minDaysBeforeFirstOrdinary: 30,
        allowEarlyStart: false, initialQuotaMode: 'free', allowInitialModeOverride: false, maxOrdinaryQuotas: null,
      });

      const denied = await request(app).put(`/api/payment-plan/policy?companyId=${a.companyId}`).set(auth(gerenteToken)).send({ allowEarlyStart: true });
      expect(denied.statusCode).toBe(403);

      const invalid = await request(app).put(`/api/payment-plan/policy?companyId=${a.companyId}`).set(auth(a.token)).send({ allowedPaymentDays: [0, 40] });
      expect(invalid.statusCode).toBe(400);
    });

    it('another tenant cannot read or change it', async () => {
      const res = await request(app).put(`/api/payment-plan/policy?companyId=${a.companyId}`).set(auth(b.token)).send({ allowEarlyStart: true });
      expect(res.statusCode).toBe(404);
      const company = await Company.findById(a.companyId);
      expect(company.paymentPlanPolicy?.allowEarlyStart).not.toBe(true);
    });
  });

  describe('sale', () => {
    it('previews the plan without saving anything', async () => {
      const lot = await newLot();
      const res = await request(app).post(`/api/lots/${lot._id}/sale-preview?companyId=${a.companyId}`).set(auth(a.token))
        .send({ totalValue: 10000000, initialQuotaPercentage: 30, installmentsCount: 4, contractDate: SALE, paymentDay: 30 });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.initialDeadline).toBe('2026-12-05');
      expect(res.body.data.firstOrdinaryDate).toBe('2027-01-30');
      expect(res.body.data.quotas.filter((q) => q.type === 'normal').map((q) => q.dueDate)).toEqual(['2027-01-30', '2027-02-28', '2027-03-30', '2027-04-30']);
      expect(await Contract.countDocuments({ lot: lot._id })).toBe(0);
    });

    it('rejects a payment day the project does not allow, before creating anything', async () => {
      const lot = await newLot();
      const res = await sell(lot, { paymentDay: 10 });
      expect(res.statusCode).toBe(400);
      expect(await Contract.countDocuments({ lot: lot._id })).toBe(0);
      expect((await Lot.findById(lot._id)).status).toBe('disponible');
    });

    it('a lot of another tenant cannot be sold', async () => {
      const lot = await newLot();
      const res = await request(app).post(`/api/lots/${lot._id}/sell?companyId=${b.companyId}`).set(auth(b.token))
        .send({ clientData: { name: 'X', idNumber: `X${stamp}` }, totalValue: 1000000, installmentsCount: 2, paymentDay: 5 });
      expect(res.statusCode).toBe(404);
    });

    it('creates a v2 contract with the initial at 30 days and the first ordinary at the rule', async () => {
      const lot = await newLot();
      const res = await sell(lot);
      expect(res.statusCode).toBe(200);
      const contract = await Contract.findById(res.body.data.contract._id);
      expect(contract.planRules).toBe('v2');
      expect(contract.legalStatus).toBe('sin_firmar');
      expect(contract.paymentDay).toBe(30);
      expect(iso(contract.initialDeadline)).toBe('2026-12-05');
      const quotas = await quotasOf(contract._id);
      expect(quotas.filter((q) => q.type === 'inicial').map((q) => [q.number, q.value, iso(q.dueDate)])).toEqual([[1, 3000000, '2026-12-05']]);
      expect(quotas.filter((q) => q.type === 'normal').map((q) => iso(q.dueDate))).toEqual(['2027-01-30', '2027-02-28', '2027-03-30', '2027-04-30']);
    });
  });

  describe('recalculation when the initial is fully paid (decision b)', () => {
    it('moves the unpaid ordinaries from the completion date, in free partial payments', async () => {
      const lot = await newLot();
      const sale = await sell(lot);
      const contractId = sale.body.data.contract._id;
      const initial = (await quotasOf(contractId)).find((q) => q.type === 'inicial');

      expect((await payManual(initial._id, 800000, '2026-11-13')).statusCode).toBe(200);
      let quotas = await quotasOf(contractId);
      expect(iso(quotas.find((q) => q.type === 'normal').dueDate)).toBe('2027-01-30');

      expect((await payManual(initial._id, 2200000, '2026-11-20')).statusCode).toBe(200);
      quotas = await quotasOf(contractId);
      expect(quotas.find((q) => q.type === 'inicial').status).toBe('pagado');
      expect(quotas.filter((q) => q.type === 'normal').map((q) => iso(q.dueDate))).toEqual(['2026-12-30', '2027-01-30', '2027-02-28', '2027-03-30']);

      const contract = await Contract.findById(contractId);
      expect(contract.planHistory.map((h) => h.kind)).toEqual(['recalculation']);
      expect(await AuditLog.countDocuments({ action: 'RECALCULATE_PLAN_AFTER_INITIAL', targetId: contract._id })).toBe(1);
    });

    const createContract = async (planRules, ordinaryPaid = 0) => {
      const contract = await Contract.create({
        tenantId: a.tenantId, companyId: a.companyId, client: client._id, lot: new mongoose.Types.ObjectId(),
        totalValue: 4000000, contractDate: new Date('2026-11-05T17:00:00Z'), paymentDay: 30, planRules,
        planPolicy: planRules ? { initialDeadlineDays: 30, minDaysBeforeFirstOrdinary: 30, earlyStart: false, initialQuotaMode: 'free' } : undefined,
      });
      const base = { tenantId: a.tenantId, companyId: a.companyId, contract: contract._id };
      await Quota.insertMany([
        { ...base, type: 'inicial', number: 1, value: 1000000, dueDate: new Date('2026-12-05T17:00:00Z'), status: 'pendiente' },
        { ...base, type: 'normal', number: 1, value: 1500000, dueDate: new Date('2027-01-30T17:00:00Z'), status: 'pendiente', amountPaid: ordinaryPaid },
        { ...base, type: 'normal', number: 2, value: 1500000, dueDate: new Date('2027-02-28T17:00:00Z'), status: 'pendiente' },
      ]);
      return contract;
    };

    it('never touches a contract sold before the new rules', async () => {
      const contract = await createContract(undefined);
      const initial = (await quotasOf(contract._id)).find((q) => q.type === 'inicial');
      expect((await payManual(initial._id, 1000000, '2026-11-20')).statusCode).toBe(200);
      const quotas = await quotasOf(contract._id);
      expect(quotas.filter((q) => q.type === 'normal').map((q) => iso(q.dueDate))).toEqual(['2027-01-30', '2027-02-28']);
      expect((await Contract.findById(contract._id)).planHistory || []).toHaveLength(0);
    });

    it('does nothing when an ordinary quota already has a payment', async () => {
      const contract = await createContract('v2', 1000);
      const initial = (await quotasOf(contract._id)).find((q) => q.type === 'inicial');
      expect((await payManual(initial._id, 1000000, '2026-11-20')).statusCode).toBe(200);
      const quotas = await quotasOf(contract._id);
      expect(quotas.filter((q) => q.type === 'normal').map((q) => iso(q.dueDate))).toEqual(['2027-01-30', '2027-02-28']);
    });
  });

  describe('extension of the initial deadline and otrosí', () => {
    let contractId;
    const extension = (token, body, companyId = a.companyId) => request(app)
      .post(`/api/contracts/${contractId}/initial-extension?companyId=${companyId}`).set(auth(token))
      .send({ newDeadline: '2027-01-04', reason: 'Cliente espera cesantías', approvedByName: 'Gerente comercial', approvedAt: '2026-11-25', ...body });

    beforeAll(async () => {
      const lot = await newLot();
      const sale = await sell(lot, { paymentDay: 15 });
      contractId = sale.body.data.contract._id;
    });

    it('only authorized roles register it, and the reason is mandatory', async () => {
      expect((await extension(jefeToken)).statusCode).toBe(403);
      expect((await extension(gerenteToken, { reason: '  ' })).statusCode).toBe(400);
    });

    it('another tenant cannot register it on this contract', async () => {
      expect((await extension(b.token, {}, b.companyId)).statusCode).toBe(404);
      expect((await extension(b.token, {}, a.companyId)).statusCode).toBe(404);
    });

    it('case D: unsigned contract, extension to 60 days moves the first ordinary to 15 Feb', async () => {
      const res = await extension(gerenteToken);
      expect(res.statusCode).toBe(200);
      const quotas = await quotasOf(contractId);
      expect(iso(quotas.find((q) => q.type === 'inicial').dueDate)).toBe('2027-01-04');
      expect(iso(quotas.find((q) => q.type === 'normal').dueDate)).toBe('2027-02-15');
      const contract = await Contract.findById(contractId);
      expect(contract.legalStatus).toBe('sin_firmar');
      expect(contract.planHistory.at(-1)).toMatchObject({ kind: 'extension', reason: 'Cliente espera cesantías', approvedByName: 'Gerente comercial' });
      expect(await AuditLog.countDocuments({ action: 'REGISTER_INITIAL_EXTENSION', targetId: contract._id })).toBe(1);
    });

    it('the new deadline must be later than the current one', async () => {
      expect((await extension(gerenteToken, { newDeadline: '2026-12-20' })).statusCode).toBe(400);
    });

    it('with the contract signed the extension is recorded as an otrosí', async () => {
      const signed = await request(app).put(`/api/contracts/${contractId}/legal-status?companyId=${a.companyId}`)
        .set(auth(gerenteToken)).send({ legalStatus: 'firmado', signedAt: '2026-11-26' });
      expect(signed.statusCode).toBe(200);
      expect(signed.body.data.contract.legalStatus).toBe('firmado');

      const res = await extension(gerenteToken, { newDeadline: '2027-01-20' });
      expect(res.statusCode).toBe(200);
      const contract = await Contract.findById(contractId);
      expect(contract.legalStatus).toBe('con_otrosi');
      expect(contract.planHistory.at(-1)).toMatchObject({ kind: 'otrosi', contractSigned: true });
    });

    it('an otrosí changes the payment day of the unpaid quotas only, with its signed PDF', async () => {
      const quotas = await quotasOf(contractId);
      const firstOrdinary = quotas.find((q) => q.type === 'normal' && q.number === 1);
      firstOrdinary.status = 'pagado';
      firstOrdinary.amountPaid = firstOrdinary.value;
      await firstOrdinary.save();
      const paidDate = iso(firstOrdinary.dueDate);

      const denied = await request(app).post(`/api/contracts/${contractId}/otrosi?companyId=${a.companyId}`).set(auth(jefeToken))
        .field('paymentDay', '5').field('reason', 'x').field('approvedByName', 'y').field('approvedAt', '2026-12-01');
      expect(denied.statusCode).toBe(403);

      const res = await request(app).post(`/api/contracts/${contractId}/otrosi?companyId=${a.companyId}`).set(auth(gerenteToken))
        .field('paymentDay', '5').field('reason', 'Cambio de fecha de nómina').field('approvedByName', 'Gerente comercial').field('approvedAt', '2026-12-01')
        .attach('document', Buffer.from('%PDF-1.4 test'), { filename: 'otrosi.pdf', contentType: 'application/pdf' });
      expect(res.statusCode).toBe(200);

      const after = await quotasOf(contractId);
      const ordinary = after.filter((q) => q.type === 'normal');
      expect(iso(ordinary[0].dueDate)).toBe(paidDate);
      expect(ordinary.slice(1).every((q) => toCalendarDate(q.dueDate).d === 5)).toBe(true);
      const contract = await Contract.findById(contractId);
      expect(contract.paymentDay).toBe(5);
      expect(contract.planHistory.at(-1)).toMatchObject({ kind: 'otrosi', documentUrl: 'https://files.test/contracts/test.pdf' });
    });

    it('an otrosí with a day the project does not allow is rejected', async () => {
      const res = await request(app).post(`/api/contracts/${contractId}/otrosi?companyId=${a.companyId}`).set(auth(gerenteToken))
        .send({ paymentDay: 10, reason: 'x', approvedByName: 'y', approvedAt: '2026-12-01' });
      expect(res.statusCode).toBe(400);
    });
  });
});
