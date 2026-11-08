import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Bank from '../src/models/Bank.js';

describe('Integration Test - Banks API', () => {
  let adminToken = '';
  let companyId = '';
  let testBankId = '';
  
  const testEmail = `admin.banks.test.${Date.now()}@example.com`;
  const testPassword = 'Password123';

  // SETUP: Create a test user, tenant and company to get an auth token
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Admin Test Banks',
        fullName: 'Admin Test Banks',
        email: testEmail,
        password: testPassword,
        confirmPassword: testPassword,
        tenantName: 'Tenant Banks Test',
        companyName: 'Company Banks Test'
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
        
        await Bank.deleteMany({ companyId });
        await Company.deleteMany({ _id: companyId });
        await Tenant.deleteMany({ _id: { $in: tenantIds } });
        await User.deleteMany({ accountId: account._id });
        await UserAccount.deleteOne({ _id: account._id });
      }
    }
    // await mongoose.connection.close();
  });

  it('should create a new bank (CREATE)', async () => {
    const res = await request(app)
      .post('/api/banks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyId,
        socialDenomination: 'BANCO TEST S.A.',
        acronym: 'TESTBANK',
        code: '999',
        type: 'BANCO'
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.acronym).toBe('TESTBANK');
    
    testBankId = res.body.data._id;
  });

  it('should list banks (LIST)', async () => {
    const res = await request(app)
      .get(`/api/banks?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.banks)).toBe(true);
    
    const bank = res.body.data.banks.find(b => b._id === testBankId);
    expect(bank).toBeDefined();
  });

  it('should update bank details (UPDATE)', async () => {
    const res = await request(app)
      .put(`/api/banks/${testBankId}?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        socialDenomination: 'BANCO TEST ACTUALIZADO'
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.socialDenomination).toBe('BANCO TEST ACTUALIZADO');
  });

  it('should bulk create banks (BULK)', async () => {
    const res = await request(app)
      .post(`/api/banks/bulk?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        banks: [
          { companyId, socialDenomination: 'BULK 1', acronym: 'B1', code: '001', type: 'BANCO' },
          { companyId, socialDenomination: 'BULK 2', acronym: 'B2', code: '002', type: 'BANCO' }
        ]
      });

    if (res.body.count !== 2) {
      console.error('Bulk Create failed:', res.body);
    }
    expect(res.statusCode).toBe(201);
    expect(res.body.count).toBe(2);
  });

  it('should deactivate/delete a bank (DELETE)', async () => {
    const res = await request(app)
      .delete(`/api/banks/${testBankId}?companyId=${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Verify status in DB: non-superadmin without payments deletes the record
    const dbBank = await Bank.findById(testBankId);
    expect(dbBank).toBeNull();
  });

  it('the public bank list follows the page slug even with a panel session in the browser', async () => {
    const company = await Company.findById(companyId);
    const res = await request(app)
      .get(`/api/banks?companySlug=${company.slug}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data.banks)).toBe(true);
  });
});
