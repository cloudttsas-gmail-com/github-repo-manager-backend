import request from 'supertest';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Lot from '../src/models/Lot.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import CommissionPlan from '../src/models/CommissionPlan.js';
import Commission from '../src/models/Commission.js';
import Quota from '../src/models/Quota.js';
import { buildCommissionForContract, evaluateCommissionMilestones } from '../src/services/commission.service.js';

describe('Integration Test - Commission Plans API', () => {
  let adminToken = '';
  let companyId = '';
  let tenantId = '';
  let sellerId = '';

  const testEmail = `admin.commissions.test.${Date.now()}@example.com`;
  const testPassword = 'Password123';

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Commissions Tester',
        fullName: 'Commissions Tester',
        email: testEmail,
        password: testPassword,
        confirmPassword: testPassword,
        tenantName: 'Commissions Test Tenant',
        companyName: 'Commissions Test Project'
      });

    if (res.body.success) {
      adminToken = res.body.data.accessToken;
      companyId = res.body.data.company._id;
      const company = await Company.findById(companyId);
      tenantId = company.tenantId;

      const account = await UserAccount.findOne({ email: testEmail });
      const user = await User.findOne({ accountId: account._id });
      sellerId = user._id.toString();
    } else {
      throw new Error(`Registration failed: ${JSON.stringify(res.body)}`);
    }
  }, 90000);

  afterAll(async () => {
    if (adminToken) {
      const account = await UserAccount.findOne({ email: testEmail });
      if (account) {
        const memberships = await User.find({ accountId: account._id });
        const tenantIds = memberships.map(m => m.tenantId);

        await Commission.deleteMany({ companyId });
        await CommissionPlan.deleteMany({ companyId });
        await Contract.deleteMany({ companyId });
        await Lot.deleteMany({ companyId });
        await Client.deleteMany({ companyId });
        await Company.deleteMany({ _id: companyId });
        await Tenant.deleteMany({ _id: { $in: tenantIds } });
        await User.deleteMany({ accountId: account._id });
        await UserAccount.deleteOne({ _id: account._id });
      }
    }
  });

  const api = () => request(app).get(`/api/commission-plans?companyId=${companyId}`).set('Authorization', `Bearer ${adminToken}`);

  it('should create a Marbella-style plan with tiers by initial quota %', async () => {
    const res = await request(app)
      .post(`/api/commission-plans?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Comisión venta de lote',
        baseType: 'fixed',
        baseValue: 5000000,
        tiers: [
          { initialQuotaPercentage: 10, milestones: [
            { key: 'INITIAL_QUOTA', amount: 2500000 },
            { key: 'QUOTA_NUMBER', quotaNumber: 6, amount: 2500000 },
          ] },
          { initialQuotaPercentage: 20, milestones: [
            { key: 'INITIAL_QUOTA', amount: 4000000 },
            { key: 'QUOTA_NUMBER', quotaNumber: 6, amount: 1000000 },
          ] },
          { initialQuotaPercentage: 30, milestones: [
            { key: 'INITIAL_QUOTA', amount: 5000000 },
          ] },
        ],
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.plan.tiers.length).toBe(3);
  });

  it('should reject a plan whose tier amounts do not sum to the base value', async () => {
    const res = await request(app)
      .post(`/api/commission-plans?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plan inválido',
        baseType: 'fixed',
        baseValue: 5000000,
        tiers: [
          { initialQuotaPercentage: 10, milestones: [
            { key: 'INITIAL_QUOTA', amount: 1000000 },
          ] },
        ],
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain('Deben coincidir');
  });

  it('should reject percentage base combined with tiers', async () => {
    const res = await request(app)
      .post(`/api/commission-plans?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plan mixto',
        baseType: 'percentage',
        baseValue: 5,
        tiers: [
          { initialQuotaPercentage: 10, milestones: [{ key: 'INITIAL_QUOTA', amount: 1000000 }] },
        ],
      });

    expect(res.statusCode).toBe(400);
  });

  it('should list the configured plans', async () => {
    const res = await api();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.plans.length).toBeGreaterThanOrEqual(1);
  });

  it('should build the Commission with the tier matching the contract CI %', async () => {
    const client = await Client.create({ tenantId, companyId, name: 'Client CI 20', idNumber: '111222333' });
    const lot = await Lot.create({ tenantId, companyId, lotNumber: 'LC1', status: 'vendido', sellerId, price: 100000000 });
    const contract = await Contract.create({
      tenantId, companyId, client: client._id, lot: lot._id, sellerId,
      contractDate: new Date(), totalValue: 100000000, initialQuotaPercentage: 20, status: 'ACTIVO',
    });

    const commission = await buildCommissionForContract({ contract, tenantId, companyId });

    expect(commission).not.toBeNull();
    expect(commission.totalAmount).toBe(5000000);
    expect(commission.installments.length).toBe(2);

    const initial = commission.installments.find((i) => i.milestoneKey === 'INITIAL_QUOTA');
    expect(initial.amount).toBe(4000000);
    expect(initial.status).toBe('PENDING');

    const sixth = commission.installments.find((i) => i.milestoneKey === 'QUOTA_NUMBER');
    expect(sixth.quotaNumber).toBe(6);
    expect(sixth.amount).toBe(1000000);
  });

  // A CI % between tiers falls into the highest tier it reaches ("30% o más" rule), so only a CI %
  // below the lowest tier (10%) has no tier.
  it('should NOT build a Commission when the contract CI % is below every tier', async () => {
    const client = await Client.create({ tenantId, companyId, name: 'Client CI 5', idNumber: '444555666' });
    const lot = await Lot.create({ tenantId, companyId, lotNumber: 'LC2', status: 'vendido', sellerId, price: 100000000 });
    const contract = await Contract.create({
      tenantId, companyId, client: client._id, lot: lot._id, sellerId,
      contractDate: new Date(), totalValue: 100000000, initialQuotaPercentage: 5, status: 'ACTIVO',
    });

    const commission = await buildCommissionForContract({ contract, tenantId, companyId });
    expect(commission).toBeNull();
  });

  it('should use the highest tier the contract CI % reaches when it falls between tiers', async () => {
    const client = await Client.create({ tenantId, companyId, name: 'Client CI 25', idNumber: '444555667' });
    const lot = await Lot.create({ tenantId, companyId, lotNumber: 'LC2B', status: 'vendido', sellerId, price: 100000000 });
    const contract = await Contract.create({
      tenantId, companyId, client: client._id, lot: lot._id, sellerId,
      contractDate: new Date(), totalValue: 100000000, initialQuotaPercentage: 25, status: 'ACTIVO',
    });

    const commission = await buildCommissionForContract({ contract, tenantId, companyId });
    expect(commission).not.toBeNull();
    expect(commission.installments.find((i) => i.milestoneKey === 'INITIAL_QUOTA').amount).toBe(4000000);
  });

  it('should support percentage plans with global milestones (portion split)', async () => {
    const res = await request(app)
      .post(`/api/commission-plans?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Comisión porcentual',
        baseType: 'percentage',
        baseValue: 5,
        milestones: [
          { key: 'INITIAL_QUOTA', portion: 0.5 },
          { key: 'QUOTA_NUMBER', quotaNumber: 6, portion: 0.5 },
        ],
      });

    expect(res.statusCode).toBe(201);

    const client = await Client.create({ tenantId, companyId, name: 'Client %', idNumber: '777888999' });
    const lot = await Lot.create({ tenantId, companyId, lotNumber: 'LC3', status: 'vendido', sellerId, price: 100000000 });
    const contract = await Contract.create({
      tenantId, companyId, client: client._id, lot: lot._id, sellerId,
      contractDate: new Date(), totalValue: 100000000, initialQuotaPercentage: 30, status: 'ACTIVO',
    });

    const commission = await buildCommissionForContract({ contract, tenantId, companyId });

    expect(commission).not.toBeNull();
    expect(commission.totalAmount).toBe(5000000);
    expect(commission.installments.length).toBe(2);
    expect(commission.installments[0].amount).toBe(2500000);
    expect(commission.installments[1].amount).toBe(2500000);
  });

  it('should activate INITIAL_QUOTA and QUOTA_NUMBER milestones when quotas are paid', async () => {
    // Fresh fixed-tiers plan so it becomes the active one
    await request(app)
      .post(`/api/commission-plans?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plan hitos',
        baseType: 'fixed',
        baseValue: 5000000,
        tiers: [
          { initialQuotaPercentage: 20, milestones: [
            { key: 'INITIAL_QUOTA', amount: 4000000 },
            { key: 'QUOTA_NUMBER', quotaNumber: 6, amount: 1000000 },
          ] },
        ],
      });

    const client = await Client.create({ tenantId, companyId, name: 'Client Hitos', idNumber: '222333444' });
    const lot = await Lot.create({ tenantId, companyId, lotNumber: 'LCH', status: 'vendido', sellerId, price: 100000000 });
    const contract = await Contract.create({
      tenantId, companyId, client: client._id, lot: lot._id, sellerId,
      contractDate: new Date(), totalValue: 100000000, initialQuotaPercentage: 20, status: 'ACTIVO',
    });

    // Initial quota PAID + normal quotas 1 and 6 pending
    await Quota.create({ tenantId, companyId, contract: contract._id, type: 'inicial', number: 1, value: 20000000, status: 'pagado' });
    await Quota.create({ tenantId, companyId, contract: contract._id, type: 'normal', number: 1, value: 20000000, status: 'pendiente' });
    await Quota.create({ tenantId, companyId, contract: contract._id, type: 'normal', number: 6, value: 20000000, status: 'pendiente' });

    const commission = await buildCommissionForContract({ contract, tenantId, companyId });
    expect(commission).not.toBeNull();
    expect(commission.installments.every((i) => i.status === 'PENDING')).toBe(true);

    // 1. Initial quota paid → INITIAL_QUOTA becomes AVAILABLE
    await evaluateCommissionMilestones({ contractId: contract._id, tenantId, companyId });
    let refreshed = await Commission.findById(commission._id);
    expect(refreshed.installments[0].status).toBe('AVAILABLE');
    expect(refreshed.installments[1].status).toBe('PENDING');

    // 2. Normal quota #6 paid → QUOTA_NUMBER becomes AVAILABLE
    const quota6 = await Quota.findOne({ contract: contract._id, type: 'normal', number: 6 });
    quota6.status = 'pagado';
    await quota6.save();

    await evaluateCommissionMilestones({ contractId: contract._id, tenantId, companyId });
    refreshed = await Commission.findById(commission._id);
    expect(refreshed.installments[1].status).toBe('AVAILABLE');
  });

  it('should flow: radicar → rechazar (con motivo) → re-radicar → aprobar → pagar', async () => {
    const client = await Client.create({ tenantId, companyId, name: 'Client Flujo', idNumber: '555666777' });
    const lot = await Lot.create({ tenantId, companyId, lotNumber: 'LCF', status: 'vendido', sellerId, price: 100000000 });
    const contract = await Contract.create({
      tenantId, companyId, client: client._id, lot: lot._id, sellerId,
      contractDate: new Date(), totalValue: 100000000, initialQuotaPercentage: 20, status: 'ACTIVO',
    });
    await Quota.create({ tenantId, companyId, contract: contract._id, type: 'inicial', number: 1, value: 20000000, status: 'pagado' });

    const commission = await buildCommissionForContract({ contract, tenantId, companyId });
    await evaluateCommissionMilestones({ contractId: contract._id, tenantId, companyId });
    const fresh = await Commission.findById(commission._id);

    const api = (action, body) => request(app)
      .post(`/api/commissions/${commission._id}/${action}?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

    // Filing requires the four support documents
    const supportDocs = {
      invoiceUrl: 'https://files.test/invoice.pdf',
      socialSecurityUrl: 'https://files.test/social-security.pdf',
      rutUrl: 'https://files.test/rut.pdf',
      bankCertUrl: 'https://files.test/bank-cert.pdf',
    };
    const payment = {
      paymentDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }),
      paymentMethod: 'Transferencia desde Bancolombia',
    };

    // Radicar sin soportes → 400
    const radicarNoDocs = await api('radicar', { installmentIndex: 0 });
    expect(radicarNoDocs.statusCode).toBe(400);

    // Radicar desembolso inicial (index 0)
    const radicarRes = await api('radicar', { installmentIndex: 0, ...supportDocs });
    expect(radicarRes.statusCode).toBe(200);
    expect(radicarRes.body.data.commission.installments[0].status).toBe('FILED');
    expect(radicarRes.body.data.commission.installments[0].billingNumber).toBeGreaterThan(0);

    // Rechazar sin motivo → 400
    const rejectNoReason = await api('rechazar', { installmentIndex: 0 });
    expect(rejectNoReason.statusCode).toBe(400);

    // Rechazar con motivo → REJECTED
    const rejectRes = await api('rechazar', { installmentIndex: 0, rejectedReason: 'Valores no coinciden con el contrato' });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.body.data.commission.installments[0].status).toBe('REJECTED');
    expect(rejectRes.body.data.commission.installments[0].rejectedReason).toContain('no coinciden');

    // Re-radicar desde REJECTED → FILED con nuevo consecutivo
    const reRadicarRes = await api('radicar', { installmentIndex: 0, ...supportDocs });
    expect(reRadicarRes.statusCode).toBe(200);
    expect(reRadicarRes.body.data.commission.installments[0].status).toBe('FILED');

    // Aprobar → APPROVED
    const aprobarRes = await api('aprobar', { installmentIndex: 0, observacion: 'Cuenta correcta' });
    expect(aprobarRes.statusCode).toBe(200);
    expect(aprobarRes.body.data.commission.installments[0].status).toBe('APPROVED');
    expect(aprobarRes.body.data.commission.installments[0].approvedAt).toBeDefined();

    // Pagar desde FILED → 400
    const payFiled = await api('pagar', { installmentIndex: 1, ...payment });
    expect(payFiled.statusCode).toBe(400);

    // Pagar → PAID
    const pagarRes = await api('pagar', { installmentIndex: 0, ...payment });
    expect(pagarRes.statusCode).toBe(200);
    expect(pagarRes.body.data.commission.installments[0].status).toBe('PAID');
    expect(pagarRes.body.data.commission.installments[0].paidAt).toBeDefined();
    expect(fresh.installments.length).toBe(2);
  }, 30000);
});
