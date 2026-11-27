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
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const payment = (extra = {}) => ({ installmentIndex: 0, paymentDate: today(), paymentMethod: 'Transferencia desde Bancolombia', ...extra });

describe('Approving, rejecting, paying and undoing a commission leaves a trace in the audit log', () => {
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
    const paid = await post(`/api/commissions/${commission._id}/pagar`).send(payment({ paymentReceiptUrl: 'https://files.test/receipt.pdf' }));
    expect(paid.statusCode).toBe(200);

    const logs = await logsFor(commission);
    expect(logs.map((l) => l.action)).toEqual(['APPROVE_COMMISSION', 'PAY_COMMISSION']);
    expect(logs[0].details).toMatchObject({ billingNumber: 11, amount: 100000, milestone: 'QUOTA_4', note: 'Soportes completos' });
    expect(logs[1].companyId.toString()).toBe(String(owner.companyId));
    expect(logs[1].details).toMatchObject({ paymentDate: today(), paymentMethod: 'Transferencia desde Bancolombia', paymentReceiptUrl: 'https://files.test/receipt.pdf' });
  });

  it('keeps the payment date, method and receipt in the commission and its history', async () => {
    const commission = await filedCommission(14);
    await post(`/api/commissions/${commission._id}/aprobar`).send({ installmentIndex: 0 });
    const res = await post(`/api/commissions/${commission._id}/pagar`).send(payment({ paymentDate: '2026-01-15' }));
    expect(res.statusCode).toBe(200);

    const saved = (await Commission.findById(commission._id)).installments[0];
    expect(saved.status).toBe('PAID');
    expect(saved.paymentDate.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(saved.paymentMethod).toBe('Transferencia desde Bancolombia');
    expect(saved.paymentReceiptUrl).toBeUndefined();
    expect(saved.history.map((h) => h.action)).toEqual(['APPROVED', 'PAID']);
  });

  it('refuses to mark it paid without a date or a method, or with a future date', async () => {
    const commission = await filedCommission(15);
    await post(`/api/commissions/${commission._id}/aprobar`).send({ installmentIndex: 0 });
    const pay = (body) => post(`/api/commissions/${commission._id}/pagar`).send(body);

    expect((await pay(payment({ paymentDate: undefined }))).statusCode).toBe(400);
    expect((await pay(payment({ paymentMethod: '  ' }))).statusCode).toBe(400);
    expect((await pay(payment({ paymentDate: '2999-01-01' }))).statusCode).toBe(400);
    expect((await pay(payment({ paymentReceiptUrl: 'javascript:alert(1)' }))).statusCode).toBe(400);
    expect((await Commission.findById(commission._id)).installments[0].status).toBe('APPROVED');
  });

  it('an approved, unpaid billing goes back to filed with a reason, in the audit log and its history', async () => {
    const commission = await filedCommission(16);
    await post(`/api/commissions/${commission._id}/aprobar`).send({ installmentIndex: 0, observacion: 'Ok' });
    const undo = (body) => post(`/api/commissions/${commission._id}/deshacer-aprobacion`).send({ installmentIndex: 0, ...body });

    expect((await undo({ reason: ' ' })).statusCode).toBe(400);
    const res = await undo({ reason: 'El RUT está vencido' });
    expect(res.statusCode).toBe(200);

    const saved = (await Commission.findById(commission._id)).installments[0];
    expect(saved.status).toBe('FILED');
    expect(saved.approvedAt).toBeUndefined();
    expect(saved.history.map((h) => [h.action, h.note])).toEqual([['APPROVED', 'Ok'], ['APPROVAL_REVERTED', 'El RUT está vencido']]);
    const logs = await logsFor(commission);
    expect(logs.map((l) => l.action)).toEqual(['APPROVE_COMMISSION', 'REVERT_COMMISSION_APPROVAL']);
    expect(logs[1].details).toMatchObject({ billingNumber: 16, reason: 'El RUT está vencido' });

    // It can be approved again
    expect((await post(`/api/commissions/${commission._id}/aprobar`).send({ installmentIndex: 0 })).statusCode).toBe(200);
  });

  it('a paid billing cannot be undone', async () => {
    const commission = await filedCommission(17);
    await post(`/api/commissions/${commission._id}/aprobar`).send({ installmentIndex: 0 });
    await post(`/api/commissions/${commission._id}/pagar`).send(payment());
    const res = await post(`/api/commissions/${commission._id}/deshacer-aprobacion`).send({ installmentIndex: 0, reason: 'Error' });
    expect(res.statusCode).toBe(400);
    expect((await Commission.findById(commission._id)).installments[0].status).toBe('PAID');
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

    const res = await post(`/api/commissions/${commission._id}/pagar`).send(payment());
    expect(res.statusCode).toBe(400);
    expect(await logsFor(commission)).toHaveLength(0);
  });
});
