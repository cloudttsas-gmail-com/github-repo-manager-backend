import 'dotenv/config';
import { jest } from '@jest/globals';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { generateAccessToken } from '../src/utils/jwt.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';

jest.setTimeout(60000);

// Route-level RBAC matrix. Each run registers its own inmobiliaria (the registering owner is the
// tenant_admin, «admin» below) and adds a superadmin and a vendedor membership with project access.
const stamp = Date.now();
const password = 'Password123!';

describe('Full 100% RBAC Coverage Test Suite', () => {
  let org;
  const tokens = {};
  const lotId = new mongoose.Types.ObjectId().toString();
  const clientId = new mongoose.Types.ObjectId().toString();

  // Superadmin is a platform role that can't be given from a team, so it is created directly.
  // Like the tenant_admin it reaches every project of the tenant, so only other roles get a UserCompany.
  const member = async (role, tag) => {
    const account = await UserAccount.create({ email: `${tag}.${stamp}@rbac.test`, passwordHash: password, fullName: `Miembro ${tag}`, status: 'active' });
    const user = await User.create({ accountId: account._id, tenantId: org.tenantId, role, status: 'active' });
    if (role !== 'superadmin') await UserCompany.create({ userId: user._id, companyId: org.companyId, tenantId: org.tenantId, role });
    return generateAccessToken({ accountId: account._id, userId: user._id, tenantId: org.tenantId, role, companies: [org.companyId] });
  };

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner', fullName: 'Owner', email: `owner.${stamp}@rbac.test`, password, confirmPassword: password,
      tenantName: `Tenant rbac ${stamp}`, companyName: `Company rbac ${stamp}`,
    });
    if (!res.body.success) throw new Error(`Registration failed: ${JSON.stringify(res.body)}`);
    const company = res.body.data.company;
    org = { companyId: String(company._id), tenantId: String(company.tenantId) };
    tokens.admin = res.body.data.accessToken;
    tokens.superadmin = await member('superadmin', 'superadmin');
    tokens.vendedor = await member('vendedor', 'vendedor');
  });

  afterAll(async () => {
    const tenantIds = [org?.tenantId].filter(Boolean);
    await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
    await User.deleteMany({ tenantId: { $in: tenantIds } });
    await Company.deleteMany({ tenantId: { $in: tenantIds } });
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    await UserAccount.deleteMany({ email: /rbac\.test$/ });
  });

  // Paths are functions because the project only exists once beforeAll has run
  const q = () => `companyId=${org.companyId}`;
  const testCases = [
    { method: 'get', name: 'GET /api/lots', path: () => `/api/lots?${q()}`, roles: { superadmin: true, admin: true, vendedor: true } },
    { method: 'post', name: 'POST /api/lots', path: () => '/api/lots', body: () => ({ companyId: org.companyId }), roles: { superadmin: true, admin: true, vendedor: false } },
    { method: 'delete', name: 'DELETE /api/lots/:id', path: () => `/api/lots/${lotId}?${q()}`, roles: { superadmin: true, admin: true, vendedor: false } },
    { method: 'post', name: 'POST /api/import/excel-lots', path: () => `/api/import/excel-lots?${q()}`, roles: { superadmin: true, admin: true, vendedor: false } },
    { method: 'get', name: 'GET /api/clients', path: () => `/api/clients?${q()}`, roles: { superadmin: true, admin: true, vendedor: true } },
    { method: 'post', name: 'POST /api/clients', path: () => '/api/clients', body: () => ({ companyId: org.companyId }), roles: { superadmin: true, admin: true, vendedor: true } },
    // Editing a buyer needs CLIENTES_EDIT, which sellers don't have
    { method: 'put', name: 'PUT /api/clients/:id', path: () => `/api/clients/${clientId}?${q()}`, body: () => ({ name: 'X' }), roles: { superadmin: true, admin: true, vendedor: false } },
    { method: 'get', name: 'GET /api/payments/all', path: () => `/api/payments/all?${q()}`, roles: { superadmin: true, admin: true, vendedor: true } },
    { method: 'get', name: 'GET /api/dashboard/summary', path: () => `/api/dashboard/summary?${q()}`, roles: { superadmin: true, admin: true, vendedor: true } },
    { method: 'get', name: 'GET /api/admin-users/all', path: () => '/api/admin-users/all', roles: { superadmin: true, admin: true, vendedor: false } },
    { method: 'get', name: 'GET /api/admin-users/logs', path: () => '/api/admin-users/logs', roles: { superadmin: true, admin: false, vendedor: false } },
    { method: 'get', name: 'GET /api/transactions', path: () => '/api/transactions', roles: { superadmin: true, admin: true, vendedor: false } },
    { method: 'get', name: 'GET /api/categories', path: () => '/api/categories', roles: { superadmin: true, admin: true, vendedor: false } },
    { method: 'get', name: 'GET /api/banks', path: () => `/api/banks?${q()}`, isPublic: true, roles: { superadmin: true, admin: true, vendedor: true } },
    { method: 'post', name: 'POST /api/banks', path: () => '/api/banks', body: () => ({ companyId: org.companyId }), roles: { superadmin: true, admin: true, vendedor: false } },
    { method: 'post', name: 'POST /api/import/excel', path: () => '/api/import/excel', body: () => ({ companyId: org.companyId }), roles: { superadmin: true, admin: true, vendedor: false } },
  ];

  testCases.forEach(({ method, name, path, roles, body, isPublic }) => {
    describe(name, () => {
      it(`should ${isPublic ? 'ALLOW' : 'BLOCK'} unauthenticated access`, async () => {
        const res = await request(app)[method](path());
        expect(res.statusCode).toBe(isPublic ? 200 : 401);
      });

      Object.entries(roles).forEach(([roleName, isAllowed]) => {
        it(`should ${isAllowed ? 'ALLOW' : 'BLOCK'} access for ${roleName}`, async () => {
          const token = tokens[roleName];
          if (!token) throw new Error(`Token for ${roleName} is missing.`);

          let req = request(app)[method](path()).set('Authorization', `Bearer ${token}`);
          if (body) req = req.send(body());

          const res = await req;

          if (isAllowed) {
            expect(res.statusCode).not.toBe(403);
            expect(res.statusCode).not.toBe(401);
          } else {
            expect(res.statusCode).toBe(403);
          }
        });
      });
    });
  });
});
