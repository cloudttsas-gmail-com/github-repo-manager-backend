import 'dotenv/config';
import request from 'supertest';
import mongoose from 'mongoose';
import XLSX from 'xlsx';
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
import IdempotencyKey from '../src/models/IdempotencyKey.js';

const stamp = Date.now();
const password = 'Password123!';
const future = () => new Date(Date.now() + 30 * 86400000);

// Errors found while writing the help center (26 Nov): payments and Siigo
describe('Payment fixes from the help center review', () => {
  let org;
  let seller;
  let client;
  const q = () => `companyId=${org.companyId}`;

  const member = async (role, tag) => {
    const account = await UserAccount.create({ email: `${tag}.${stamp}@helppay.test`, passwordHash: password, fullName: `Miembro ${tag}`, status: 'active' });
    const user = await User.create({ accountId: account._id, tenantId: org.tenantId, role, status: 'active' });
    await UserCompany.create({ userId: user._id, companyId: org.companyId, tenantId: org.tenantId, role });
    return { userId: String(user._id), token: generateAccessToken({ accountId: account._id, userId: user._id, tenantId: org.tenantId, role, companies: [org.companyId] }) };
  };

  // A contract with two quotas of 1,000,000
  const buildContract = async (sellerId) => {
    const contract = await Contract.create({
      tenantId: org.tenantId, companyId: org.companyId, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 2000000,
      ...(sellerId ? { sellerId } : {}),
    });
    const base = { tenantId: org.tenantId, companyId: org.companyId, contract: contract._id, dueDate: future(), status: 'pendiente', type: 'normal', value: 1000000 };
    const quotas = [await Quota.create({ ...base, number: 1 }), await Quota.create({ ...base, number: 2 })];
    return { contract, quotas };
  };

  const report = (quota, contract, amount, observations) => PaymentAttempt.create({
    tenantId: org.tenantId, companyId: org.companyId, contractId: contract._id, clientId: client._id,
    quotas: [{ quotaId: quota._id, amount }], amount, quotaValue: quota.value, banco: 'NEQUI', observations,
    paymentMethod: 'Transferencia bancaria', fechaPago: new Date(), status: 'PENDIENTE', appliedToQuotas: false,
  });

  const approve = (attempt, body = {}) => request(app).put(`/api/payments/${attempt._id}/approve?${q()}`)
    .set('Authorization', `Bearer ${org.token}`).send(body);

  const manual = (quota, amount) => request(app).post(`/api/payments/manual?${q()}`)
    .set('Authorization', `Bearer ${org.token}`)
    .send({ quotaId: quota._id.toString(), amount, bank: 'NEQUI', paymentMethod: 'Transferencia bancaria', paymentOption: 'otro', requestId: `r-${Math.random()}` });

  const siigoRows = async (token) => {
    const res = await request(app).get(`/api/payments/siigo-export?${q()}`).set('Authorization', `Bearer ${token}`)
      .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.statusCode).toBe(200);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(1);
  };

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner', fullName: 'Owner', email: `owner.${stamp}@helppay.test`, password, confirmPassword: password,
      tenantName: `Tenant helppay ${stamp}`, companyName: `Company helppay ${stamp}`,
    });
    const company = res.body.data.company;
    org = { token: res.body.data.accessToken, companyId: String(company._id), tenantId: String(company.tenantId) };
    seller = await member('vendedor', 'seller');
    client = await Client.create({ tenantId: org.tenantId, companyId: org.companyId, name: 'Help Buyer', idNumber: `H${stamp}`, phone: '3000000000' });
  });

  afterAll(async () => {
    const tenantId = org?.tenantId;
    await PaymentAttempt.deleteMany({ tenantId });
    await Quota.deleteMany({ tenantId });
    await Contract.deleteMany({ tenantId });
    await Lot.deleteMany({ tenantId });
    await Client.deleteMany({ tenantId });
    await UserCompany.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Company.deleteMany({ tenantId });
    await Tenant.deleteMany({ _id: tenantId });
    await IdempotencyKey.deleteMany({ key: new RegExp(String(org?.companyId)) });
    await UserAccount.deleteMany({ email: /helppay\.test$/ });
  });

  it('a seller exports to Siigo only the payments of their own sales', async () => {
    const own = await buildContract(seller.userId);
    const others = await buildContract();
    expect((await manual(own.quotas[0], 1000000)).statusCode).toBe(200);
    expect((await manual(others.quotas[0], 1000000)).statusCode).toBe(200);

    const ownerRows = await siigoRows(org.token);
    const sellerRows = await siigoRows(seller.token);
    expect(sellerRows.length).toBeGreaterThan(0);
    expect(sellerRows.length).toBe(ownerRows.length / 2);
  });

  it("the approver's note does not replace the buyer's observations", async () => {
    const { contract, quotas } = await buildContract();
    const attempt = await report(quotas[0], contract, 1000000, 'Pago desde Bancolombia, ref 123');
    expect((await approve(attempt, { observacion: 'Verificado en extracto' })).statusCode).toBe(200);

    const saved = await PaymentAttempt.findById(attempt._id);
    expect(saved.observations).toBe('Pago desde Bancolombia, ref 123');
    expect(saved.approvalNotes).toBe('Verificado en extracto');

    const list = await request(app).get(`/api/payments/all?${q()}&clientId=${client._id}&limit=100`).set('Authorization', `Bearer ${org.token}`);
    const row = list.body.data.payments.find((p) => String(p.id) === String(attempt._id));
    expect(row.observations).toBe('Pago desde Bancolombia, ref 123');
    expect(row.approvalNotes).toBe('Verificado en extracto');
  });

  it('approving a payment beyond the contract balance returns the leftover amount', async () => {
    const { contract, quotas } = await buildContract();
    const attempt = await report(quotas[0], contract, 2500000);
    const res = await approve(attempt);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.unappliedAmount).toBe(500000);
  });

  it('a manual payment cannot go beyond what the contract still owes', async () => {
    const { quotas } = await buildContract();
    const over = await manual(quotas[0], 2000001);
    expect(over.statusCode).toBe(400);
    expect(over.body.message).toMatch(/supera lo pendiente/);
    expect((await Quota.findById(quotas[0]._id)).amountPaid || 0).toBe(0);

    expect((await manual(quotas[0], 2000000)).statusCode).toBe(200);
    const paidOff = await manual(quotas[1], 1);
    expect(paidOff.statusCode).toBe(400);
    expect(paidOff.body.message).toMatch(/no tiene saldo pendiente/);
  });
});
