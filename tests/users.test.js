import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';

describe('Integration Test - User Management (Admin)', () => {
  let adminToken = '';
  let adminUserId = '';
  let companyId = '';
  let createdMembershipId = '';
  let createdAccountId = '';
  
  const testAdminEmail = `admin.users.test.${Date.now()}@example.com`;
  const sellerEmail = `vendedor.test.${Date.now()}@example.com`;
  const testPassword = 'Password123!';

  // SETUP: Create a test user, tenant and company to get an auth token
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Admin User Test',
        fullName: 'Admin User Test',
        email: testAdminEmail,
        password: testPassword,
        confirmPassword: testPassword,
        tenantName: `Tenant Users Test ${Date.now()}`,
        companyName: `Company Users Test ${Date.now()}`
      });
      
    if (res.body.success) {
      adminToken = res.body.data.accessToken;
      companyId = res.body.data.company._id;
      
      // Obtenemos el ID del membresia del admin buscando su cuenta
      const account = await UserAccount.findOne({ email: testAdminEmail });
      const membership = await User.findOne({ accountId: account._id });
      adminUserId = membership._id.toString();
    } else {
      throw new Error(`Registration failed in test setup: ${JSON.stringify(res.body)}`);
    }
  });

  // TEARDOWN: Clean up all created test data
  afterAll(async () => {
    if (adminToken) {
      const adminAccount = await UserAccount.findOne({ email: testAdminEmail });
      const sellerAccount = await UserAccount.findOne({ email: sellerEmail });
      
      if (adminAccount) {
        const memberships = await User.find({ accountId: adminAccount._id });
        const tenantIds = memberships.map(m => m.tenantId);
        
        await Company.deleteMany({ _id: companyId });
        await Tenant.deleteMany({ _id: { $in: tenantIds } });
        await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
        await User.deleteMany({ tenantId: { $in: tenantIds } });
        await UserAccount.deleteOne({ _id: adminAccount._id });
      }

      if (sellerAccount) {
        await UserAccount.deleteOne({ _id: sellerAccount._id });
      }
    }
    // await mongoose.connection.close();
  });

  it('should have properly authenticated setup', () => {
    expect(adminToken).toBeDefined();
    expect(companyId).toBeDefined();
    expect(adminUserId).toBeDefined();
  });

  it('should list all users for the tenant (READ ALL)', async () => {
    const res = await request(app)
      .get(`/api/admin-users/all`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // At least the admin user should be here
    expect(res.body.data.users.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.users[0].email).toBe(testAdminEmail);
  });

  it('should create a new seller user (CREATE)', async () => {
    const res = await request(app)
      .post('/api/admin-users/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fullName: 'Vendedor Test',
        email: sellerEmail,
        password: 'Password123!',
        role: 'vendedor',
        companyIds: [companyId]
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toHaveProperty('id');
    expect(res.body.data.user.role).toBe('vendedor');
    
    createdMembershipId = res.body.data.user.id;
    createdAccountId = res.body.data.user.accountId;

    // DIRECT DB ASSERTION: Verificamos UserAccount
    const dbAccount = await UserAccount.findById(createdAccountId);
    expect(dbAccount).not.toBeNull();
    expect(dbAccount.email).toBe(sellerEmail);

    // DIRECT DB ASSERTION: Verificamos User (Membership)
    const dbMembership = await User.findById(createdMembershipId);
    expect(dbMembership).not.toBeNull();
    expect(dbMembership.role).toBe('vendedor');

    // DIRECT DB ASSERTION: Verificamos UserCompany assignment
    const dbUserCompany = await UserCompany.findOne({ userId: createdMembershipId, companyId });
    expect(dbUserCompany).not.toBeNull();
    expect(dbUserCompany.role).toBe('vendedor');
  });

  it('should fetch the newly created seller in the sellers list', async () => {
    // getSellers without companyId
    const res = await request(app)
      .get(`/api/admin-users/sellers`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    
    // Check if newly created seller is in the array
    const includesSeller = res.body.data.some(seller => seller.email === sellerEmail);
    expect(includesSeller).toBe(true);
  });

  it('should update the seller role to agent (UPDATE)', async () => {
    const res = await request(app)
      .put(`/api/admin-users/update/${createdMembershipId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        role: 'agent',
        fullName: 'Vendedor Test Modificado'
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.role).toBe('agent');
    expect(res.body.data.user.fullName).toBe('Vendedor Test Modificado');

    // DIRECT DB ASSERTION
    const dbMembership = await User.findById(createdMembershipId);
    expect(dbMembership.role).toBe('agent');

    const dbAccount = await UserAccount.findById(createdAccountId);
    expect(dbAccount.fullName).toBe('Vendedor Test Modificado');
  });

  it('should change the password of the created user', async () => {
    // Before we change, grab the old passwordHash
    const oldAccount = await UserAccount.findById(createdAccountId).select('+passwordHash');
    const oldHash = oldAccount.passwordHash;

    const res = await request(app)
      .put(`/api/admin-users/change-password/${createdMembershipId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        password: 'NewStrongPassword456!'
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    // DIRECT DB ASSERTION
    const newAccount = await UserAccount.findById(createdAccountId).select('+passwordHash');
    expect(newAccount.passwordHash).not.toBe(oldHash); 
  });

  it('should prevent deleting your own membership (DELETE ERROR)', async () => {
    const res = await request(app)
      .delete(`/api/admin-users/delete/${adminUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/no puedes eliminar tu propio usuario/i);
  });

  it('should delete the newly created user membership (DELETE)', async () => {
    const res = await request(app)
      .delete(`/api/admin-users/delete/${createdMembershipId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    // DIRECT DB ASSERTION: Ensure membership and company assignments are gone
    const dbMembership = await User.findById(createdMembershipId);
    expect(dbMembership).toBeNull();

    const dbUserCompany = await UserCompany.findOne({ userId: createdMembershipId });
    expect(dbUserCompany).toBeNull();

    // The core UserAccount should still exist since deleteUser only removes membership
    const dbAccount = await UserAccount.findById(createdAccountId);
    expect(dbAccount).not.toBeNull();
  });
});
