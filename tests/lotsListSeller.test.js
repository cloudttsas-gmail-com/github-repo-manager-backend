import request from 'supertest';
import app from '../src/app.js';
import Lot from '../src/models/Lot.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import User from '../src/models/User.js';
import UserAccount from '../src/models/UserAccount.js';

const stamp = Date.now();
const password = 'Password123!';

describe('Lot list with a sold lot whose seller is only on the contract', () => {
  let token;
  let companyId;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner', fullName: 'Owner', email: `owner.${stamp}@lots-list.test`, password, confirmPassword: password,
      tenantName: `Tenant ${stamp}`, companyName: `Company ${stamp}`,
    });
    token = res.body.data.accessToken;
    companyId = res.body.data.company._id;
  });

  it('lists the lots and takes the seller from the contract', async () => {
    const tenantId = (await Lot.db.model('Company').findById(companyId)).tenantId;
    const account = await UserAccount.findOne({ email: `owner.${stamp}@lots-list.test` });
    const seller = await User.findOne({ accountId: account._id });
    const lot = await Lot.create({ tenantId, companyId, stage: 'Fase 1', nomenclature: 'Manzana Z', lotNumber: `S${stamp}`, area: 100, price: 1000000, status: 'vendido' });
    const client = await Client.create({ tenantId, companyId, name: 'Comprador Prueba', idNumber: `C${stamp}` });
    await Contract.create({ tenantId, companyId, client: client._id, lot: lot._id, sellerId: seller._id, totalValue: 1000000 });

    const res = await request(app).get(`/api/lots?companyId=${companyId}`).set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    const listed = (res.body.data.lots || res.body.data).find((l) => String(l._id) === String(lot._id));
    expect(String(listed.sellerId._id || listed.sellerId)).toBe(String(seller._id));
  });
});
