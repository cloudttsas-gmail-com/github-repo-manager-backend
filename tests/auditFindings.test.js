import request from 'supertest';
import app from '../src/app.js';
import Lot from '../src/models/Lot.js';
import Company from '../src/models/Company.js';
import AuditLog from '../src/models/AuditLog.js';

const stamp = Date.now();
const password = 'Password123!';
const email = (name) => `${name}.${stamp}@audit-findings.test`;

describe('Help-center audit findings', () => {
  let owner;
  let auth;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner', fullName: 'Owner', email: email('owner'), password, confirmPassword: password,
      tenantName: `Tenant ${stamp}`, companyName: `Company ${stamp}`,
    });
    owner = { token: res.body.data.accessToken, companyId: res.body.data.company._id };
    auth = { Authorization: `Bearer ${owner.token}` };
  });

  it('ends the open session of a user whose access was deactivated', async () => {
    const created = await request(app).post(`/api/admin-users/create?companyId=${owner.companyId}`).set(auth)
      .send({ fullName: 'Gerente', email: email('gerente'), role: 'gerente', password, companyIds: [owner.companyId] });
    const memberId = created.body.data.user.id;
    const token = (await request(app).post('/api/auth/admin/login').send({ email: email('gerente'), password })).body.data.accessToken;

    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).statusCode).toBe(200);

    const off = await request(app).put(`/api/admin-users/update/${memberId}?companyId=${owner.companyId}`).set(auth).send({ status: 'inactive' });
    expect(off.statusCode).toBe(200);

    const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(after.statusCode).toBe(401);
  });

  it('takes one photo off a lot and logs it', async () => {
    const lot = await Lot.create({
      tenantId: (await Company.findById(owner.companyId)).tenantId, companyId: owner.companyId,
      stage: 'Fase 1', nomenclature: 'Manzana Z', lotNumber: `F${stamp}`, area: 100, price: 1000000,
      images: ['https://files.example/a.jpg', 'https://files.example/b.jpg'],
    });
    const url = `/api/lots/${lot._id}/images?companyId=${owner.companyId}`;

    const missing = await request(app).delete(url).set(auth).send({ url: 'https://files.example/zzz.jpg' });
    expect(missing.statusCode).toBe(404);

    const res = await request(app).delete(url).set(auth).send({ url: 'https://files.example/a.jpg' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.images).toEqual(['https://files.example/b.jpg']);
    expect((await Lot.findById(lot._id)).images).toEqual(['https://files.example/b.jpg']);
    expect(await AuditLog.countDocuments({ action: 'REMOVE_LOT_IMAGE', targetId: lot._id })).toBe(1);
  });

  it('saves the project phone used by the WhatsApp templates', async () => {
    const res = await request(app).put(`/api/companies/${owner.companyId}?companyId=${owner.companyId}`).set(auth).send({ phone: '601 555 9876' });
    expect(res.statusCode).toBe(200);
    expect((await Company.findById(owner.companyId)).phone).toBe('601 555 9876');
  });
});
