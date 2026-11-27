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
import Lot from '../src/models/Lot.js';
import PaymentAttempt from '../src/models/PaymentAttempt.js';
import Quota from '../src/models/Quota.js';

const stamp = Date.now();
const password = 'Password123!';

describe('Buyer portal data for the redesign', () => {
  let org;
  let buyer;
  let contract;
  let token;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner portal', fullName: 'Owner portal', email: `owner.${stamp}@portal.test`,
      password, confirmPassword: password, tenantName: `Tenant portal ${stamp}`, companyName: `Company portal ${stamp}`,
    });
    const company = res.body.data.company;
    org = { companyId: String(company._id), tenantId: String(company.tenantId) };
    await Company.updateOne({ _id: org.companyId }, { $set: { bankAccounts: [
      { banco: 'Banco Uno', tipoCuenta: 'Ahorros', numeroCuenta: '123', titular: 'Proyecto', qrCode: 'https://files.test/qr.png', accountingAccount: '11200501' },
      { banco: 'Banco Viejo', tipoCuenta: 'Ahorros', numeroCuenta: '999', isActive: false },
    ] } });
    buyer = await Client.create({ tenantId: org.tenantId, companyId: org.companyId, name: 'Ana Portal', idNumber: `P${stamp}` });
    const lot = await Lot.create({ tenantId: org.tenantId, companyId: org.companyId, stage: 'E1', manzana: 'A', lotNumber: `L${stamp}`, area: 100, price: 1000, status: 'vendido' });
    contract = await Contract.create({ tenantId: org.tenantId, companyId: org.companyId, client: buyer._id, lot: lot._id, totalValue: 500000 });
    await Quota.insertMany([
      { tenantId: org.tenantId, companyId: org.companyId, contract: contract._id, number: 1, type: 'inicial', value: 200000, amountPaid: 200000, status: 'pagado', dueDate: new Date('2026-10-01T12:00:00-05:00'), receiptNumber: 7 },
      { tenantId: org.tenantId, companyId: org.companyId, contract: contract._id, number: 1, type: 'normal', value: 150000, status: 'pendiente', dueDate: new Date('2099-12-05T12:00:00-05:00') },
      { tenantId: org.tenantId, companyId: org.companyId, contract: contract._id, number: 2, type: 'normal', value: 150000, status: 'pendiente', dueDate: new Date('2100-01-05T12:00:00-05:00') },
    ]);
    const base = { tenantId: org.tenantId, companyId: org.companyId, contractId: contract._id, clientId: buyer._id, banco: 'Banco Uno', paymentMethod: 'transferencia', fechaPago: new Date('2026-11-10T12:00:00-05:00') };
    await PaymentAttempt.create([
      { ...base, amount: 70000, quotaValue: 150000, status: 'PENDIENTE', appliedToQuotas: false },
      { ...base, amount: 30000, quotaValue: 150000, status: 'PENDIENTE', appliedToQuotas: false },
      // A legacy pending row already on the quotas: not «in review»
      { ...base, amount: 99000, status: 'PENDIENTE' },
      { ...base, amount: 10000, status: 'RECHAZADO', rejectedReason: 'El comprobante no se lee' },
    ]);
    const account = await UserAccount.create({ email: `buyer.${stamp}@portal.test`, passwordHash: password, fullName: 'Ana Portal', status: 'active' });
    // The session needs a real, active access to the inmobiliaria, like the portal login gives
    const membership = await User.create({ accountId: account._id, tenantId: org.tenantId, role: 'cliente', clientId: buyer._id });
    token = generateAccessToken({ accountId: account._id, userId: membership._id, tenantId: org.tenantId, role: 'cliente', clientId: buyer._id, companies: [] });
  });

  afterAll(async () => {
    await PaymentAttempt.deleteMany({ tenantId: org.tenantId });
    await Quota.deleteMany({ tenantId: org.tenantId });
    await Contract.deleteMany({ tenantId: org.tenantId });
    await Lot.deleteMany({ tenantId: org.tenantId });
    await Client.deleteMany({ tenantId: org.tenantId });
    await UserCompany.deleteMany({ tenantId: org.tenantId });
    await User.deleteMany({ tenantId: org.tenantId });
    await Company.deleteMany({ tenantId: org.tenantId });
    await Tenant.deleteMany({ _id: org.tenantId });
    await UserAccount.deleteMany({ email: /portal\.test$/ });
  });

  it('the summary says how many payments of each contract are in review', async () => {
    const res = await request(app).get('/api/portal/summary').set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.contracts[0].inReview).toEqual({ count: 2, amount: 100000 });
  });

  it('«Mis pagos» brings the paid date, bank, property and rejection reason', async () => {
    const res = await request(app).get('/api/portal/payments').set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    const rejected = res.body.data.payments.find((payment) => payment.status === 'rejected');
    expect(rejected).toMatchObject({ rejectedReason: 'El comprobante no se lee', banco: 'Banco Uno' });
    expect(rejected.lotLabel).toContain(`L${stamp}`);
    expect(res.body.data.payments.find((payment) => payment.status === 'pending').rejectedReason).toBeNull();
  });

  it('«Cómo pagar» lists active accounts with their QR and never the accounting account', async () => {
    const res = await request(app).get('/api/portal/bank-accounts').set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.bankAccounts).toHaveLength(1);
    expect(res.body.data.bankAccounts[0]).toMatchObject({ banco: 'Banco Uno', qrCode: 'https://files.test/qr.png' });
    expect(res.body.data.bankAccounts[0].accountingAccount).toBeUndefined();
  });

  it('the contract detail names each quota, gives its receipt and the next quota like the statement', async () => {
    const res = await request(app).get(`/api/portal/contract/${contract._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    const [initial, first] = res.body.data.planPagos;
    expect(initial).toMatchObject({ tipo: 'inicial', estado: 'pagada', reciboNumero: 7 });
    expect(initial.reciboUrl).toContain('?s=');
    expect(first).toMatchObject({ etiqueta: expect.stringContaining('1'), estado: 'pendiente', reciboUrl: null });
    expect(res.body.data.proximaCuota).toMatchObject({ number: 1, type: 'normal' });
  });
});
