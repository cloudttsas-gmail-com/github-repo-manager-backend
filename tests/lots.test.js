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

describe('Integration Test - Lots API', () => {
  let adminToken = '';
  let companyId = '';
  let testLotId = '';
  let testClientId = '';
  let alternateClientId = '';
  
  const testEmail = `admin.lots.test.${Date.now()}@example.com`;
  const testPassword = 'Password123';

  // SETUP: Create a test user, tenant and company to get an auth token
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Admin Test Lots',
        fullName: 'Admin Test Lots', // passing both in case of inconsistencies
        email: testEmail,
        password: testPassword,
        confirmPassword: testPassword,
        tenantName: 'Tenant Lots Test',
        companyName: 'Company Lots Test'
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
      // Find the account to get tenantId
      const account = await UserAccount.findOne({ email: testEmail });
      if (account) {
        const memberships = await User.find({ accountId: account._id });
        const tenantIds = memberships.map(m => m.tenantId);
        
        // Delete all related data
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

  it('should create a new lot (CREATE)', async () => {
    const res = await request(app)
      .post('/api/lots')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        stage: 'Fase 1',
        nomenclature: 'Manzana A',
        lotNumber: '10',
        area: 120,
        price: 50000000
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('_id');
    expect(res.body.data.status).toBe('disponible');
    
    testLotId = res.body.data._id;

    // DIRECT DB ASSERTION: Verificamos que se haya guardado realmente en Mongoose
    const dbLot = await Lot.findById(testLotId);
    expect(dbLot).not.toBeNull();
    expect(dbLot.stage).toBe('Fase 1');
    expect(dbLot.price).toBe(50000000);
    expect(dbLot.status).toBe('disponible');
  });

  it('should fetch the list of lots (READ LIST)', async () => {
    const res = await request(app)
      .get(`/api/lots?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.lots)).toBe(true);
    expect(res.body.data.lots.length).toBeGreaterThanOrEqual(1);
  });

  it('should fetch a single lot by ID (READ ONE)', async () => {
    const res = await request(app)
      .get(`/api/lots/${testLotId}?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBe(testLotId);
  });

  it('should update a lot (UPDATE)', async () => {
    const res = await request(app)
      .put(`/api/lots/${testLotId}?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        price: 55000000
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.price).toBe(55000000);

    // DIRECT DB ASSERTION
    const dbLot = await Lot.findById(testLotId);
    expect(dbLot.price).toBe(55000000);
  });

  it('should create a test client needed for reservations', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        name: 'Cliente Test',
        idNumber: `123456789${Date.now()}`
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    testClientId = res.body.data._id;
    
    // Create an alternate client
    const res2 = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        name: 'Cliente Test Alterno',
        idNumber: `987654321${Date.now()}`
      });
      
    alternateClientId = res2.body.data._id;
  });

  it('should reserve a lot as "apartado"', async () => {
    const res = await request(app)
      .post(`/api/lots/${testLotId}/reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        clientId: testClientId,
        type: 'apartado'
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('apartado');

    // DIRECT DB ASSERTION
    const dbLot = await Lot.findById(testLotId);
    expect(dbLot.status).toBe('apartado');
    expect(dbLot.reservationBy.toString()).toBe(testClientId);
    expect(dbLot.reservedAt).toBeDefined();
  });

  it('should release a reserved lot', async () => {
    const res = await request(app)
      .post(`/api/lots/${testLotId}/release`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        reason: 'El cliente no prosiguió'
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('disponible');

    // DIRECT DB ASSERTION
    const dbLot = await Lot.findById(testLotId);
    expect(dbLot.status).toBe('disponible');
    expect(dbLot.reservationBy).toBeUndefined();
    expect(dbLot.reservedAt).toBeUndefined();
  });

  it('should reserve a lot as "separado" (requires amount)', async () => {
    // Attempting without minimum amount should fail
    const resFail = await request(app)
      .post(`/api/lots/${testLotId}/reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        clientId: testClientId,
        type: 'separado',
        amount: 100 // below 500,000 limit
      });

    expect(resFail.statusCode).toBe(400);

    // Attempting with minimum amount should succeed
    const res = await request(app)
      .post(`/api/lots/${testLotId}/reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        clientId: testClientId,
        type: 'separado',
        amount: 500000 
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('separado');

    // DIRECT DB ASSERTION
    const dbLot = await Lot.findById(testLotId);
    expect(dbLot.status).toBe('separado');
  });

  it('should prevent selling a reserved lot to a different client', async () => {
    const res = await request(app)
      .post(`/api/lots/${testLotId}/sell`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        clientId: alternateClientId,
        totalValue: 55000000,
        installmentsCount: 12
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/reservado/i);
  });

  it('should sell the lot to the correct client who reserved it', async () => {
    const res = await request(app)
      .post(`/api/lots/${testLotId}/sell`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        clientId: testClientId,
        totalValue: 55000000,
        installmentsCount: 12,
        initialQuotaPercentage: 20
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.contract).toBeDefined();

    // DIRECT DB ASSERTION: Verificamos lote
    const dbLot = await Lot.findById(testLotId);
    expect(dbLot.status).toBe('vendido');
    
    // DIRECT DB ASSERTION: Verificamos contrato guardado
    const dbContract = await Contract.findOne({ lot: testLotId });
    expect(dbContract).toBeDefined();
    expect(dbContract.client.toString()).toBe(testClientId);
    expect(dbContract.totalValue).toBe(55000000);

    // DIRECT DB ASSERTION: Verificamos cuotas generadas
    const dbQuotas = await Quota.find({ contract: dbContract._id });
    expect(dbQuotas.length).toBeGreaterThan(0);
    // Como pedimos 12 cuotas y tiene una inicial del 20%, deberían ser 12 
    // a menos que genere una cuota inicial explícita también. 
    // Con verificar que están asociadas en BD es suficiente.
  });

  it('should refuse to delete a lot with an active contract', async () => {
    const res = await request(app)
      .delete(`/api/lots/${testLotId}?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/contrato activo/i);

    const dbLot = await Lot.findById(testLotId);
    expect(dbLot.isDeleted).toBe(false);
  });

  // Deleting a lot is a soft delete (archived with who/when/why), not a hard delete
  it('should soft-delete an available lot (DELETE)', async () => {
    const created = await request(app)
      .post('/api/lots')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ companyId, stage: 'Fase 1', nomenclature: 'Manzana A', lotNumber: '11', area: 120, price: 50000000 });
    expect(created.statusCode).toBe(201);
    const freeLotId = created.body.data._id;

    const res = await request(app)
      .delete(`/api/lots/${freeLotId}?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Lote duplicado' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const dbLot = await Lot.findById(freeLotId);
    expect(dbLot.isDeleted).toBe(true);
    expect(dbLot.deletedAt).toBeDefined();
    expect(dbLot.deletedReason).toBe('Lote duplicado');

    const list = await request(app)
      .get(`/api/lots?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.data.lots.some((l) => l._id === freeLotId)).toBe(false);
  });
});
