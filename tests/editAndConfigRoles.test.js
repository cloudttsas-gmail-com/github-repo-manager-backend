import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import PaymentAttempt from '../src/models/PaymentAttempt.js';
import AuditLog from '../src/models/AuditLog.js';

const stamp = Date.now();
const password = 'Password123!';
const email = (who) => `${who}.${stamp}@roles.test`;

// Decisions of 11 Nov: gerente and contador correct approved payments; company_admin and
// administrador save the configuration of the projects assigned to them
describe('Who corrects payments and who saves the project configuration', () => {
  let owner;
  let otherProjectId;
  const tokens = {};

  const createMember = (role) => request(app)
    .post(`/api/admin-users/create?companyId=${owner.companyId}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ password, companyIds: [owner.companyId], fullName: role, email: email(role), role });

  const approvedPayment = async () => {
    const scope = { tenantId: owner.tenantId, companyId: owner.companyId };
    const client = await Client.create({ ...scope, name: 'Roles Buyer', idNumber: `R${stamp}${Math.random()}`, phone: '3000000002' });
    const contract = await Contract.create({ ...scope, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 1000000 });
    const quota = await Quota.create({ ...scope, contract: contract._id, number: 1, type: 'normal', value: 1000000, amountPaid: 500000, status: 'pendiente', dueDate: new Date(Date.now() + 864e5) });
    return PaymentAttempt.create({
      ...scope, contractId: contract._id, clientId: client._id, quotas: [{ quotaId: quota._id, amount: 500000 }],
      amount: 500000, quotaValue: 1000000, banco: 'NEQUI', paymentMethod: 'Transferencia bancaria',
      fechaPago: new Date(), status: 'APROBADO', appliedToQuotas: true,
    });
  };
  const edit = (role, id) => request(app).put(`/api/payments/${id}/edit?companyId=${owner.companyId}`)
    .set('Authorization', `Bearer ${tokens[role]}`).send({ amount: 400000, reason: 'Monto mal digitado' });
  const saveCompany = (role, id, body) => request(app).put(`/api/companies/${id}`)
    .set('Authorization', `Bearer ${tokens[role]}`).send(body);

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner roles', fullName: 'Owner roles', email: email('owner'),
      password, confirmPassword: password,
      tenantName: `Tenant roles ${stamp}`, companyName: `Company roles ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    otherProjectId = (await Company.create({ tenantId: owner.tenantId, name: `Other project ${stamp}` }))._id.toString();
    for (const role of ['gerente', 'contador', 'jefe_cartera', 'company_admin', 'administrador']) {
      const created = await createMember(role);
      expect(created.statusCode).toBe(201);
      const login = await request(app).post('/api/auth/admin/login').send({ email: email(role), password });
      tokens[role] = login.body.data.accessToken;
    }
  });

  afterAll(async () => {
    const tenantId = owner?.tenantId;
    await AuditLog.deleteMany({ tenantId });
    await PaymentAttempt.deleteMany({ tenantId });
    await Quota.deleteMany({ tenantId });
    await Contract.deleteMany({ tenantId });
    await Client.deleteMany({ tenantId });
    await UserCompany.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Company.deleteMany({ tenantId });
    await Tenant.deleteMany({ _id: tenantId });
    await UserAccount.deleteMany({ email: /roles\.test$/ });
  });

  it('gerente and contador correct an approved payment', async () => {
    expect((await edit('gerente', (await approvedPayment())._id)).statusCode).toBe(200);
    expect((await edit('contador', (await approvedPayment())._id)).statusCode).toBe(200);
  });

  it('jefe de cartera still cannot correct one', async () => {
    expect((await edit('jefe_cartera', (await approvedPayment())._id)).statusCode).toBe(403);
  });

  it('company_admin and administrador save the configuration of their project', async () => {
    for (const role of ['company_admin', 'administrador']) {
      const res = await saveCompany(role, owner.companyId, { phone: `31${stamp % 100000000}` });
      expect(res.statusCode).toBe(200);
    }
  });

  it('they cannot configure a project they are not assigned to, nor switch theirs off', async () => {
    expect((await saveCompany('company_admin', otherProjectId, { phone: '1' })).statusCode).toBe(403);
    await saveCompany('administrador', owner.companyId, { status: 'inactive' });
    expect((await Company.findById(owner.companyId)).status).not.toBe('inactive');
  });

  it('roles without configuration still cannot save a project', async () => {
    expect((await saveCompany('gerente', owner.companyId, { phone: '1' })).statusCode).toBe(403);
  });
});
