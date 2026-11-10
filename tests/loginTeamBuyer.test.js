import request from 'supertest';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import VerificationToken from '../src/models/VerificationToken.js';
import { registerPortalUserForClient } from '../src/utils/clientAuthHelper.js';

const stamp = Date.now();
const password = 'Password123!';
const email = `gerente.${stamp}@teambuyer.test`;

// Within one team an account has a single membership (accountId + tenantId is unique), so the
// lockout happens across teams: another company registers a buyer with this member's email
describe('A buyer registered with a team member\'s email does not lock that member out', () => {
  let owner;
  let other;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Gerente', fullName: 'Gerente', email,
      password, confirmPassword: password,
      tenantName: `Tenant tb ${stamp}`, companyName: `Company tb ${stamp}`,
    });
    owner = { companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    const res2 = await request(app).post('/api/auth/register').send({
      name: 'Otra', fullName: 'Otra', email: `otra.${stamp}@teambuyer.test`,
      password, confirmPassword: password,
      tenantName: `Tenant tb2 ${stamp}`, companyName: `Company tb2 ${stamp}`,
    });
    other = { companyId: res2.body.data.company._id, tenantId: res2.body.data.company.tenantId };
    // A seller of the other company registers a buyer with the manager's email
    const client = await Client.create({
      tenantId: other.tenantId, companyId: other.companyId, name: 'Buyer TB', idNumber: `TB${stamp}`, phone: '3001234567', email,
    });
    await registerPortalUserForClient(client, other.tenantId, other.companyId);
  });

  afterAll(async () => {
    const tenantId = { $in: [owner?.tenantId, other?.tenantId] };
    await VerificationToken.deleteMany({ tenantId });
    await Client.deleteMany({ tenantId });
    await UserCompany.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Company.deleteMany({ tenantId });
    await Tenant.deleteMany({ _id: tenantId });
    await UserAccount.deleteMany({ email: /teambuyer\.test$/ });
  });

  it('the account now also has a buyer membership', async () => {
    const account = await UserAccount.findOne({ email });
    expect(await User.countDocuments({ accountId: account._id, role: 'cliente' })).toBe(1);
  });

  it('the panel login still opens the team session', async () => {
    const res = await request(app).post('/api/auth/admin/login').send({ email, password });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.requiresOtp).toBeUndefined();
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.role).not.toBe('cliente');
  });

  it('the client portal login asks for the buyer code and masks the phone', async () => {
    const res = await request(app).post('/api/auth/admin/login').send({ email, password, portal: 'cliente' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.requiresOtp).toBe(true);
    expect(res.body.data.phone).toBe('******4567');
  });
});
