import { jest } from '@jest/globals';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Lot from '../src/models/Lot.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import PaymentAttempt from '../src/models/PaymentAttempt.js';

describe('Integration Test - Payments API', () => {
  let adminToken = '';
  let companyId = '';
  let testLotId = '';
  let testClientId = '';
  let testQuotaId = '';
  let testContractId = '';
  
  const testEmail = `admin.payments.test.${Date.now()}@example.com`;
  const testPassword = 'Password123';

  jest.setTimeout(30000);

  // SETUP: Create a test user, tenant and company to get an auth token
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Admin Test Payments',
        fullName: 'Admin Test Payments',
        email: testEmail,
        password: testPassword,
        confirmPassword: testPassword,
        tenantName: 'Tenant Payments Test',
        companyName: 'Company Payments Test'
      });
      
    if (res.body.success) {
      adminToken = res.body.data.accessToken;
      companyId = res.body.data.company._id;
    } else {
      console.error('Registration failed:', res.body);
    }
  });

  // TEARDOWN: Clean up all created test data
  afterAll(async () => {
    if (adminToken) {
      const account = await UserAccount.findOne({ email: testEmail });
      if (account) {
        const memberships = await User.find({ accountId: account._id });
        const tenantIds = memberships.map(m => m.tenantId);
        
        // Delete all related data in proper order
        await Quota.deleteMany({ companyId });
        await Contract.deleteMany({ companyId });
        await Lot.deleteMany({ companyId });
        await Client.deleteMany({ companyId });
        await Company.deleteMany({ _id: companyId });
        await Tenant.deleteMany({ _id: { $in: tenantIds } });
        await User.deleteMany({ accountId: account._id });
        await UserAccount.deleteOne({ _id: account._id });
      }
    }
    // await mongoose.connection.close();
  });

  it('should get authentication token', () => {
    expect(adminToken).toBeDefined();
    expect(companyId).toBeDefined();
  });

  it('should setup preparatory data (Lot, Client, Sale)', async () => {
    // 1. Create Lot
    const lotRes = await request(app)
      .post('/api/lots')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        stage: 'Proyecto Pago Test',
        nomenclature: 'MZ 1 LOTE 1',
        lotNumber: '1',
        area: 100,
        price: 40000000
      });
    testLotId = lotRes.body.data._id;

    // 2. Create Client
    const clientRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        name: 'Cliente Pagos',
        idNumber: `CC${Date.now()}`,
        phone: '3001234567',
        email: 'cliente@test.com'
      });
    testClientId = clientRes.body.data._id;

    // 3. Sell Lot (Generates Quotas)
    const sellRes = await request(app)
      .post(`/api/lots/${testLotId}/sell`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        clientId: testClientId,
        totalValue: 40000000,
        installmentsCount: 10,
        initialQuotaPercentage: 10 // 4M initial
      });
    
    expect(sellRes.statusCode).toBe(200);
    testContractId = sellRes.body.data.contract._id;

    // 4. Find one quota to work with
    const quota = await Quota.findOne({ contract: testContractId });
    expect(quota).not.toBeNull();
    testQuotaId = quota._id.toString();
  });

  it('should register a manual payment (REGISTER MANUAL)', async () => {
    const res = await request(app)
      .post('/api/payments/manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        quotaId: testQuotaId,
        amount: 4000000,
        bank: 'Bancolombia',
        observations: 'Pago inicial en efectivo registrado por admin',
        paymentDate: new Date()
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/exitosamente/i);

    // Verify in DB
    const updatedQuota = await Quota.findById(testQuotaId);
    expect(updatedQuota.status).toBe('pagado');
    expect(updatedQuota.amountPaid).toBe(4000000);
    expect(updatedQuota.paymentBank).toBe('Bancolombia');
  });

  it('an approved payment cannot be rejected: it is corrected with edit (REJECT)', async () => {
    const attempt = await PaymentAttempt.findOne({ contractId: testContractId });
    expect(attempt).not.toBeNull();
    const testAttemptId = attempt._id.toString();

    const res = await request(app)
      .put(`/api/payments/${testAttemptId}/reject?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Editar/);

    // Verify in DB
    const updatedQuota = await Quota.findById(testQuotaId);
    expect(updatedQuota.status).toBe('pagado');
    expect(updatedQuota.amountPaid).toBe(4000000);
  });

  it('should approve a reported payment (APPROVE)', async () => {
    const next = await Quota.findOne({ contract: testContractId, status: 'pendiente' }).sort({ type: 1, number: 1 });
    const attempt = await PaymentAttempt.create({
      tenantId: next.tenantId, companyId: next.companyId, contractId: testContractId, clientId: testClientId,
      quotas: [{ quotaId: next._id, amount: next.value }], amount: next.value, quotaValue: next.value,
      banco: 'Bancolombia', paymentMethod: 'Transferencia bancaria', fechaPago: new Date(), status: 'PENDIENTE', appliedToQuotas: false,
    });

    const res = await request(app)
      .put(`/api/payments/${attempt._id}/approve?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/aprobado|pagada/i);

    // Verify in DB
    const updatedQuota = await Quota.findById(next._id);
    expect(updatedQuota.status).toBe('pagado');
    await PaymentAttempt.deleteOne({ _id: attempt._id });
  });

  it('should fetch the list of payments (READ LIST)', async () => {
    const attempt = await PaymentAttempt.findOne({ contractId: testContractId });
    expect(attempt).not.toBeNull();
    const testAttemptId = attempt._id.toString();

    const res = await request(app)
      .get(`/api/payments/all?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.payments)).toBe(true);
    
    // The list filters for quotas that are "pagado" or have payment data
    const payment = res.body.data.payments.find(p => p.id.toString() === testAttemptId);
    expect(payment).toBeDefined();
    expect(payment.status).toBe('PAGADO');
    expect(payment.amount).toBeGreaterThan(0);
  });

  it('should error when approving an already paid quota', async () => {
    const attempt = await PaymentAttempt.findOne({ contractId: testContractId });
    expect(attempt).not.toBeNull();
    const testAttemptId = attempt._id.toString();

    const res = await request(app)
      .put(`/api/payments/${testAttemptId}/approve?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/ya fue aprobado|ya fue marcada como pagada/i);
  });

  it('should error when accessing non-existent quota', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .put(`/api/payments/${fakeId}/approve?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(404);
  });
});
