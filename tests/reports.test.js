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
import Commission from '../src/models/Commission.js';

describe('Integration Test - Reports API', () => {
  let adminToken = '';
  let companyId = '';
  let sellerId = '';
  
  const testEmail = `admin.reports.test.${Date.now()}@example.com`;
  const testPassword = 'Password123';

  beforeAll(async () => {
    // 1. Register a new admin user (this creates tenant and company)
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Reports Tester',
        fullName: 'Reports Tester',
        email: testEmail,
        password: testPassword,
        confirmPassword: testPassword,
        tenantName: 'Reports Test Tenant',
        companyName: 'Reports Test Project'
      });
      
    if (res.body.success) {
      adminToken = res.body.data.accessToken;
      companyId = res.body.data.company._id;
      
      // Get the user ID to use as seller
      const account = await UserAccount.findOne({ email: testEmail });
      const user = await User.findOne({ accountId: account._id });
      sellerId = user._id;
    } else {
      throw new Error(`Registration failed: ${JSON.stringify(res.body)}`);
    }
  });

  afterAll(async () => {
    if (adminToken) {
      const account = await UserAccount.findOne({ email: testEmail });
      if (account) {
        const memberships = await User.find({ accountId: account._id });
        const tenantIds = memberships.map(m => m.tenantId);
        
        await Contract.deleteMany({ companyId });
        await Lot.deleteMany({ companyId });
        await Client.deleteMany({ companyId });
        await Commission.deleteMany({ companyId });
        await Company.deleteMany({ _id: companyId });
        await Tenant.deleteMany({ _id: { $in: tenantIds } });
        await User.deleteMany({ accountId: account._id });
        await UserAccount.deleteOne({ _id: account._id });
      }
    }
  });

  it('should fail to get sales report without token', async () => {
    const res = await request(app).get(`/api/reports/sales?companyId=${companyId}`);
    expect(res.statusCode).toBe(401);
  });

  it('should get an empty sales report initially', async () => {
    const res = await request(app)
      .get(`/api/reports/sales?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // The report now covers a period (current month by default) instead of «this month»
    expect(res.body.data.period).toBe('current_month');
    expect(res.body.data.salesInPeriod).toBe(0);
    expect(res.body.data.totalValueInPeriod).toBe(0);
    expect(res.body.data.topAdvisors).toEqual([]);
    expect(res.body.data.separatedLots).toBe(0);
    expect(res.body.data.topAdvisor).toBeNull();
    expect(res.body.data.lotStats).toBeInstanceOf(Array);
  });

  it('should reflect correct data after sales and reservations', async () => {
    // 1. Create a client
    const clientRes = await Client.create({
      tenantId: (await Company.findById(companyId)).tenantId,
      companyId,
      name: 'Client Test',
      idNumber: '123456789'
    });

    // 2. Create and sell a lot
    const lot1 = await Lot.create({
      tenantId: clientRes.tenantId,
      companyId,
      stage: 'Etapa 1',
      lotNumber: 'L1',
      status: 'vendido',
      sellerId,
      price: 100000
    });

    await Contract.create({
      tenantId: clientRes.tenantId,
      companyId,
      client: clientRes._id,
      lot: lot1._id,
      sellerId,
      contractDate: new Date(),
      totalValue: 100000,
      status: 'ACTIVO'
    });

    // 3. Create a separated lot
    await Lot.create({
      tenantId: clientRes.tenantId,
      companyId,
      stage: 'Etapa 1',
      lotNumber: 'L2',
      status: 'separado',
      price: 100000
    });

    // 4. Create an available lot in a different stage
    await Lot.create({
      tenantId: clientRes.tenantId,
      companyId,
      stage: 'Etapa 2',
      lotNumber: 'L3',
      status: 'disponible',
      price: 150000
    });

    // Fetch report
    const res = await request(app)
      .get(`/api/reports/sales?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.salesInPeriod).toBe(1);
    expect(res.body.data.totalValueInPeriod).toBe(100000);
    expect(res.body.data.separatedLots).toBe(1);
    expect(res.body.data.topAdvisor.name).toBe('Reports Tester');
    expect(res.body.data.topAdvisor.salesCount).toBe(1);
    expect(res.body.data.topAdvisor.totalSold).toBe(100000);

    // Verify lotStats
    const lotStats = res.body.data.lotStats;
    expect(lotStats.length).toBe(2);

    const etapa1 = lotStats.find(s => s.stage === 'Etapa 1');
    expect(etapa1.total).toBe(2);
    expect(etapa1.vendidos).toBe(1);
    expect(etapa1.separados).toBe(1);
    expect(etapa1.porcentajeVendido).toBe(50);

    const etapa2 = lotStats.find(s => s.stage === 'Etapa 2');
    expect(etapa2.total).toBe(1);
    expect(etapa2.disponibles).toBe(1);
    expect(etapa2.vendidos).toBe(0);
    expect(etapa2.porcentajeVendido).toBe(0);
  });

  it('should get cash flow projection', async () => {
    const res = await request(app)
      .get(`/api/reports/projection?companyId=${companyId}&months=3`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.data.length).toBe(3);
    expect(res.body.data[0]).toHaveProperty('expectedAmount');
    expect(res.body.data[0]).toHaveProperty('label');
  });

  it('should report sales and collection per advisor', async () => {
    const company = await Company.findById(companyId);

    // 1. Contract sold this month with an initial quota paid
    const lot2 = await Lot.create({
      tenantId: company.tenantId,
      companyId,
      stage: 'Etapa 1',
      lotNumber: 'L4',
      status: 'vendido',
      sellerId,
      price: 200000
    });

    const client2 = await Client.create({
      tenantId: company.tenantId,
      companyId,
      name: 'Advisor Report Client',
      idNumber: '987654321'
    });

    const contract = await Contract.create({
      tenantId: company.tenantId,
      companyId,
      client: client2._id,
      lot: lot2._id,
      sellerId,
      contractDate: new Date(),
      totalValue: 200000,
      initialQuotaPercentage: 10,
      status: 'ACTIVO'
    });

    // 2. One paid initial quota (20000) + one unpaid normal quota (180000)
    await Quota.create({
      tenantId: company.tenantId,
      companyId,
      contract: contract._id,
      type: 'inicial',
      number: 1,
      value: 20000,
      status: 'pagado',
      amountPaid: 20000,
      paymentDate: new Date()
    });
    await Quota.create({
      tenantId: company.tenantId,
      companyId,
      contract: contract._id,
      type: 'normal',
      number: 1,
      value: 180000,
      status: 'pendiente'
    });

    // 2B. Commission for this contract: 200000 generated, 100000 available
    await Commission.create({
      tenantId: company.tenantId,
      companyId,
      contractId: contract._id,
      sellerId,
      initialQuotaPercentage: 10,
      totalAmount: 200000,
      installments: [
        { milestoneKey: 'INITIAL_QUOTA', amount: 100000, status: 'AVAILABLE' },
        { milestoneKey: 'QUOTA_NUMBER', quotaNumber: 6, amount: 100000, status: 'PENDING' },
      ],
    });

    // 3. Advisor report (default: current month)
    const res = await request(app)
      .get(`/api/reports/advisors?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const advisor = res.body.data.advisors.find((a) => a.advisorId === sellerId.toString());
    expect(advisor).toBeDefined();
    expect(advisor.name).toBe('Reports Tester');
    expect(advisor.ventas).toBe(2);
    expect(advisor.valorVendido).toBe(300000);
    expect(advisor.recaudo).toBe(20000);
    expect(advisor.recaudoInicial).toBe(20000);
    expect(advisor.valorInicialTotal).toBe(20000);
    expect(advisor.comisionGenerada).toBe(200000);
    expect(advisor.comisionDisponible).toBe(100000);
    expect(advisor.comisionPagada).toBe(0);

    // 4. Totals consolidated
    expect(res.body.data.totals.ventas).toBe(2);
    expect(res.body.data.totals.valorVendido).toBe(300000);
    expect(res.body.data.totals.comisionGenerada).toBe(200000);

    // 5. Out-of-period sales are excluded
    const pastRes = await request(app)
      .get(`/api/reports/advisors?companyId=${companyId}&from=2020-01-01&to=2020-01-31`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(pastRes.statusCode).toBe(200);
    expect(pastRes.body.data.advisors.length).toBe(0);
    expect(pastRes.body.data.totals.ventas).toBe(0);

    // 6. Invalid range returns 400
    const invalidRes = await request(app)
      .get(`/api/reports/advisors?companyId=${companyId}&from=2025-01-01&to=2020-01-01`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(invalidRes.statusCode).toBe(400);
  });
});
