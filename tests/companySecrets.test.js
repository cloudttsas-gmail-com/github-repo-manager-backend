import request from 'supertest';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Contract from '../src/models/Contract.js';

const stamp = Date.now();
const password = 'Password123!';

describe('Company secrets stay on the server', () => {
  let owner;
  let memberToken;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner sec', fullName: 'Owner sec', email: `owner.${stamp}@secrets.test`,
      password, confirmPassword: password,
      tenantName: `Tenant sec ${stamp}`, companyName: `Company sec ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id, tenantId: res.body.data.company.tenantId };
    await Company.updateOne({ _id: owner.companyId }, {
      slug: `secrets-${stamp}`,
      integrations: { whatsappEnabled: true, whatsappAccessToken: 'SECRET-TOKEN', whatsappApiKey: 'SECRET-KEY', whatsappWabaId: 'WABA-1', whatsappPhoneId: 'PHONE-1' },
      bankAccounts: [{ banco: 'BANCOLOMBIA', tipoCuenta: 'Ahorros', numeroCuenta: '1234', accountingAccount: '11100501', qrCode: 'https://files.test/qr.png' }],
    });
    await request(app).post(`/api/admin-users/create?companyId=${owner.companyId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ fullName: 'Aux', email: `aux.${stamp}@secrets.test`, password, role: 'auxiliar_cartera', companyIds: [owner.companyId] });
    memberToken = (await request(app).post('/api/auth/admin/login').send({ email: `aux.${stamp}@secrets.test`, password })).body.data.accessToken;
  });

  afterAll(async () => {
    const tenantId = owner?.tenantId;
    await Contract.deleteMany({ tenantId });
    await UserCompany.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Company.deleteMany({ tenantId });
    await Tenant.deleteMany({ _id: tenantId });
    await UserAccount.deleteMany({ email: /secrets\.test$/ });
  });

  it('no company endpoint returns the WhatsApp token or key', async () => {
    const responses = await Promise.all([
      request(app).get('/api/companies').set('Authorization', `Bearer ${memberToken}`),
      request(app).get(`/api/companies/${owner.companyId}`).set('Authorization', `Bearer ${owner.token}`),
      request(app).get('/api/auth/me').set('Authorization', `Bearer ${memberToken}`),
    ]);
    responses.forEach((r) => {
      expect(r.statusCode).toBe(200);
      expect(JSON.stringify(r.body)).not.toMatch(/SECRET-TOKEN|SECRET-KEY/);
    });
    expect(JSON.stringify(responses[0].body)).toMatch(/"whatsappConnected":true/);
  });

  it('a populated company does not leak the token either', async () => {
    const contract = await Contract.create({ tenantId: owner.tenantId, companyId: owner.companyId, client: owner.companyId, lot: owner.companyId });
    const populated = await Contract.findById(contract._id).populate('companyId');
    expect(JSON.stringify(populated)).not.toMatch(/SECRET-TOKEN|SECRET-KEY/);
  });

  it('saving settings keeps the WhatsApp connection and cannot change it', async () => {
    const res = await request(app).put(`/api/companies/${owner.companyId}?companyId=${owner.companyId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ integrations: { whatsappEnabled: true, daptaEnabled: true, whatsappWabaId: 'OTHER-WABA', whatsappAccessToken: 'HIJACK' } });
    expect(res.statusCode).toBe(200);
    const stored = await Company.findById(owner.companyId);
    expect(stored.integrations.whatsappAccessToken).toBe('SECRET-TOKEN');
    expect(stored.integrations.whatsappWabaId).toBe('WABA-1');
    expect(stored.integrations.daptaEnabled).toBe(true);
  });

  it('the public accounts page does not show the accounting account', async () => {
    const res = await request(app).get(`/api/public/accounts/secrets-${stamp}`);
    expect(res.statusCode).toBe(200);
    const [account] = res.body.data.bankAccounts;
    expect(account.qrCode).toBe('https://files.test/qr.png');
    expect(account.accountingAccount).toBeUndefined();
  });
});
