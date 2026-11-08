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
const { publicLinkUrl } = await import('../src/utils/publicLinks.js');
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
import IdempotencyKey from '../src/models/IdempotencyKey.js';

const stamp = Date.now();
const password = 'Password123!';
const future = () => new Date(Date.now() + 30 * 86400000);

const registerOwner = async (tag) => {
  const res = await request(app).post('/api/auth/register').send({
    name: `Owner ${tag}`, fullName: `Owner ${tag}`, email: `owner.${tag}.${stamp}@audit.test`,
    password, confirmPassword: password,
    tenantName: `Tenant ${tag} ${stamp}`, companyName: `Company ${tag} ${stamp}`,
  });
  return { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
};

describe('Payment and lot fixes from the 8 Nov audit', () => {
  let owner;
  let other;
  let client;

  // A contract with an initial quota of 4,000,000 and three ordinary quotas of 2,000,000
  const buildContract = async (who = owner) => {
    const contract = await Contract.create({
      tenantId: who.tenantId, companyId: who.companyId, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 10000000,
    });
    const base = { tenantId: who.tenantId, companyId: who.companyId, contract: contract._id, dueDate: future(), status: 'pendiente' };
    const initial = await Quota.create({ ...base, number: 1, type: 'inicial', value: 4000000 });
    const ordinaries = [];
    for (let n = 1; n <= 3; n += 1) ordinaries.push(await Quota.create({ ...base, number: n, type: 'normal', value: 2000000 }));
    return { contract, initial, ordinaries };
  };

  const report = (quota, contract, amount) => PaymentAttempt.create({
    tenantId: owner.tenantId, companyId: owner.companyId, contractId: contract._id, clientId: client._id,
    quotas: [{ quotaId: quota._id, amount }], amount, quotaValue: quota.value, banco: 'NEQUI',
    paymentMethod: 'Transferencia bancaria', fechaPago: new Date(), status: 'PENDIENTE', appliedToQuotas: false,
  });

  const manual = (quota, amount, extra = {}) => request(app).post(`/api/payments/manual?companyId=${owner.companyId}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ quotaId: quota._id.toString(), amount, bank: 'NEQUI', paymentMethod: 'Transferencia bancaria', requestId: `r-${Math.random()}`, ...extra });

  const approve = (attempt) => request(app).put(`/api/payments/${attempt._id}/approve?companyId=${owner.companyId}`)
    .set('Authorization', `Bearer ${owner.token}`).send({});
  const reject = (attempt) => request(app).put(`/api/payments/${attempt._id}/reject?companyId=${owner.companyId}`)
    .set('Authorization', `Bearer ${owner.token}`).send({ observacion: 'Duplicado' });

  beforeAll(async () => {
    owner = await registerOwner('a');
    other = await registerOwner('b');
    client = await Client.create({ tenantId: owner.tenantId, companyId: owner.companyId, name: 'Audit Buyer', idNumber: `A${stamp}`, phone: '3000000000' });
  });

  afterAll(async () => {
    for (const who of [owner, other]) {
      const tenantId = who?.tenantId;
      await PaymentAttempt.deleteMany({ tenantId });
      await Quota.deleteMany({ tenantId });
      await Contract.deleteMany({ tenantId });
      await Lot.deleteMany({ tenantId });
      await Client.deleteMany({ tenantId });
      await UserCompany.deleteMany({ tenantId });
      await User.deleteMany({ tenantId });
      await Company.deleteMany({ tenantId });
      await Tenant.deleteMany({ _id: tenantId });
      await IdempotencyKey.deleteMany({ key: new RegExp(String(who?.companyId)) });
    }
    await UserAccount.deleteMany({ email: /audit\.test$/ });
  });

  it('P1: rejecting a pending report leaves the money already on the quota', async () => {
    const { contract, initial } = await buildContract();
    expect((await manual(initial, 1000000)).statusCode).toBe(200);
    const duplicate = await report(initial, contract, 1000000);

    expect((await reject(duplicate)).statusCode).toBe(200);
    const after = await Quota.findById(initial._id);
    expect(after.amountPaid).toBe(1000000);
    expect(after.paymentBank).toBe('NEQUI');
    // and it cannot be rejected again
    expect((await reject(duplicate)).statusCode).toBe(400);
  });

  it('P2: an approval records the whole cascade, and the listing creates no phantom payments', async () => {
    const { contract, initial, ordinaries } = await buildContract();
    const attempt = await report(initial, contract, 8600000);
    expect((await approve(attempt)).statusCode).toBe(200);

    const approved = await PaymentAttempt.findById(attempt._id);
    expect(approved.status).toBe('APROBADO');
    expect(approved.appliedToQuotas).toBe(true);
    expect(approved.quotas.map((q) => q.amount)).toEqual([4000000, 2000000, 2000000, 600000]);
    expect(approved.quotas.reduce((sum, q) => sum + q.amount, 0)).toBe(8600000);
    expect((await Quota.findById(ordinaries[2]._id)).amountPaid).toBe(600000);

    const list = await request(app).get(`/api/payments/all?companyId=${owner.companyId}&limit=100`).set('Authorization', `Bearer ${owner.token}`);
    expect(list.statusCode).toBe(200);
    expect(await PaymentAttempt.countDocuments({ contractId: contract._id })).toBe(1);

    // editing it down takes the whole cascade back before applying the new amount
    const edit = await request(app).put(`/api/payments/${attempt._id}/edit?companyId=${owner.companyId}`)
      .set('Authorization', `Bearer ${owner.token}`).send({ amount: 5000000, reason: 'Monto real' });
    expect(edit.statusCode).toBe(200);
    const quotas = await Quota.find({ contract: contract._id }).sort({ type: 1, number: 1 });
    expect(quotas.map((q) => q.amountPaid || 0)).toEqual([4000000, 1000000, 0, 0]);
    const edited = await PaymentAttempt.findById(attempt._id);
    expect(edited.editReason).toBe('Monto real');
  });

  it('P4 and P5: a pending payment cannot be edited, and a rejected one cannot be approved', async () => {
    const { contract, initial } = await buildContract();
    const attempt = await report(initial, contract, 1000000);
    const edit = await request(app).put(`/api/payments/${attempt._id}/edit?companyId=${owner.companyId}`)
      .set('Authorization', `Bearer ${owner.token}`).send({ amount: 1000000 });
    expect(edit.statusCode).toBe(400);
    expect((await Quota.findById(initial._id)).amountPaid || 0).toBe(0);

    expect((await reject(attempt)).statusCode).toBe(200);
    expect((await approve(attempt)).statusCode).toBe(400);
    expect((await Quota.findById(initial._id)).amountPaid || 0).toBe(0);
  });

  it('P5: two approvals at the same time apply the payment once', async () => {
    const { contract, initial } = await buildContract();
    const attempt = await report(initial, contract, 1000000);
    const statuses = (await Promise.all([approve(attempt), approve(attempt)])).map((r) => r.statusCode).sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    expect((await Quota.findById(initial._id)).amountPaid).toBe(1000000);
  });

  it('a pending payment created by the old migration was already on the quota: approving does not add it again', async () => {
    const { contract, initial } = await buildContract();
    await Quota.updateOne({ _id: initial._id }, { $set: { amountPaid: 500000 } });
    // migrated payments have no flag and no quota value
    const legacy = await PaymentAttempt.create({
      tenantId: owner.tenantId, companyId: owner.companyId, contractId: contract._id, clientId: client._id,
      quotas: [{ quotaId: initial._id, amount: 500000 }], amount: 500000, banco: 'Desconocido',
      paymentMethod: 'Transferencia bancaria', fechaPago: new Date(), status: 'PENDIENTE',
    });
    expect((await approve(legacy)).statusCode).toBe(200);
    expect((await Quota.findById(initial._id)).amountPaid).toBe(500000);
  });

  it('P6: negative, zero and non-numeric amounts are rejected', async () => {
    const { contract, initial } = await buildContract();
    expect((await manual(initial, 2000000)).statusCode).toBe(200);
    for (const amount of [-1500000, 0, 'abc']) {
      expect((await manual(initial, amount)).statusCode).toBe(400);
    }
    expect((await Quota.findById(initial._id)).amountPaid).toBe(2000000);

    const negative = await report(initial, contract, -1000000);
    expect((await approve(negative)).statusCode).toBe(400);
    expect((await PaymentAttempt.findById(negative._id)).status).toBe('PENDIENTE');
    expect((await Quota.findById(initial._id)).amountPaid).toBe(2000000);
  });

  it('P3: a receipt number added to a signed link never opens another company\'s receipt', async () => {
    const otherClient = await Client.create({ tenantId: other.tenantId, companyId: other.companyId, name: 'Other Buyer', idNumber: `B${stamp}`, phone: '3000000001' });
    const otherContract = await Contract.create({
      tenantId: other.tenantId, companyId: other.companyId, client: otherClient._id, lot: new mongoose.Types.ObjectId(), totalValue: 1000000,
    });
    const otherQuota = await Quota.create({
      tenantId: other.tenantId, companyId: other.companyId, contract: otherContract._id, number: 1, type: 'normal',
      value: 1000000, amountPaid: 1000000, status: 'pagado', dueDate: future(), receiptNumber: 777,
    });
    await PaymentAttempt.create({
      tenantId: other.tenantId, companyId: other.companyId, contractId: otherContract._id, clientId: otherClient._id,
      quotas: [{ quotaId: otherQuota._id, amount: 1000000 }], amount: 1000000, banco: 'NEQUI', paymentMethod: 'Transferencia bancaria',
      fechaPago: new Date(), status: 'APROBADO', receiptNumber: 777, appliedToQuotas: true,
    });

    // our own quota without payments: with the global search, the number found the other receipt
    const { initial } = await buildContract();
    const link = new URL(publicLinkUrl('receipt', initial._id, 'http://localhost'));
    const res = await request(app).get(`${link.pathname}${link.search}&receiptNumber=777`);
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type'] || '').not.toContain('pdf');
  });

  it('L1 and L2: a sold lot cannot be released, and another tenant\'s lot cannot be reserved or released', async () => {
    const base = { tenantId: owner.tenantId, companyId: owner.companyId, stage: 'E1', manzana: 'M1', area: 100, price: 10000000 };
    const sold = await Lot.create({ ...base, lotNumber: `S${stamp}`, status: 'vendido' });
    const reserved = await Lot.create({ ...base, lotNumber: `R${stamp}`, status: 'apartado' });
    const free = await Lot.create({ ...base, lotNumber: `F${stamp}`, status: 'disponible' });

    const release = (lot, who) => request(app).post(`/api/lots/${lot._id}/release?companyId=${who.companyId}`)
      .set('Authorization', `Bearer ${who.token}`).send({ reason: 'cancelacion_cliente' });

    expect((await release(sold, owner)).statusCode).toBe(400);
    expect((await Lot.findById(sold._id)).status).toBe('vendido');

    expect((await release(reserved, other)).statusCode).toBe(404);
    expect((await Lot.findById(reserved._id)).status).toBe('apartado');

    const reserve = await request(app).post(`/api/lots/${free._id}/reserve?companyId=${other.companyId}`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ type: 'apartado', clientData: { name: 'Intruso', idNumber: `X${stamp}`, phone: '3000000002' } });
    expect(reserve.statusCode).toBe(404);
    expect((await Lot.findById(free._id)).status).toBe('disponible');

    expect((await release(reserved, owner)).statusCode).toBe(200);
    expect((await Lot.findById(reserved._id)).status).toBe('disponible');
  });
});
