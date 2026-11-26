import 'dotenv/config';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { generateAccessToken } from '../src/utils/jwt.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import Lot from '../src/models/Lot.js';
import Commission from '../src/models/Commission.js';
import CommissionPlan from '../src/models/CommissionPlan.js';

const stamp = Date.now();
const password = 'Password123!';

describe('Selling a lot with a seller', () => {
  let org;
  let seller;
  let otherSeller;
  const q = () => `companyId=${org.companyId}`;

  const register = async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner', fullName: 'Owner', email: `owner.${stamp}@sale.test`, password, confirmPassword: password,
      tenantName: `Tenant sale ${stamp}`, companyName: `Company sale ${stamp}`,
    });
    const company = res.body.data.company;
    return { token: res.body.data.accessToken, companyId: String(company._id), tenantId: String(company.tenantId) };
  };
  const member = async (role, tag) => {
    const account = await UserAccount.create({ email: `${tag}.${stamp}@sale.test`, passwordHash: password, fullName: `Miembro ${tag}`, status: 'active' });
    const user = await User.create({ accountId: account._id, tenantId: org.tenantId, role, status: 'active' });
    await UserCompany.create({ userId: user._id, companyId: org.companyId, tenantId: org.tenantId, role });
    return { accountId: String(account._id), userId: String(user._id), token: generateAccessToken({ accountId: account._id, userId: user._id, tenantId: org.tenantId, role, companies: [org.companyId] }) };
  };
  const newLot = (n) => Lot.create({ tenantId: org.tenantId, companyId: org.companyId, lotNumber: `S-${n}-${stamp}`, area: 100, price: 30000000, status: 'disponible' });
  const sell = (token, lot, body) => request(app).post(`/api/lots/${lot._id}/sell?${q()}`).set('Authorization', `Bearer ${token}`)
    .send({ clientData: { name: `Comprador ${lot.lotNumber}`, idNumber: lot.lotNumber }, initialQuotaPercentage: 10, installmentsCount: 12, paymentDay: 5, ...body });

  beforeAll(async () => {
    org = await register();
    seller = await member('vendedor', 'seller');
    otherSeller = await member('vendedor', 'other');
    await CommissionPlan.create({ tenantId: org.tenantId, companyId: org.companyId, name: 'Plan', baseType: 'fixed', baseValue: 1000, milestones: [{ key: 'INITIAL_QUOTA', portion: 1 }] });
  });

  afterAll(async () => {
    const tenantIds = [org?.tenantId].filter(Boolean);
    await Commission.deleteMany({ tenantId: { $in: tenantIds } });
    await CommissionPlan.deleteMany({ tenantId: { $in: tenantIds } });
    await Quota.deleteMany({ tenantId: { $in: tenantIds } });
    await Contract.deleteMany({ tenantId: { $in: tenantIds } });
    await Client.deleteMany({ tenantId: { $in: tenantIds } });
    await Lot.deleteMany({ tenantId: { $in: tenantIds } });
    await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
    await User.deleteMany({ tenantId: { $in: tenantIds } });
    await Company.deleteMany({ tenantId: { $in: tenantIds } });
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    await UserAccount.deleteMany({ email: /sale\.test$/ });
  });

  it('rejects a seller that is not a member of the team (an account id, a random id)', async () => {
    const byAccount = await sell(org.token, await newLot(1), { sellerId: seller.accountId });
    expect(byAccount.statusCode).toBe(400);
    const random = await sell(org.token, await newLot(2), { sellerId: new mongoose.Types.ObjectId() });
    expect(random.statusCode).toBe(400);
  });

  it('a seller sells only in their own name', async () => {
    const forOther = await sell(seller.token, await newLot(3), { sellerId: otherSeller.userId });
    expect(forOther.statusCode).toBe(403);
    const lot = await newLot(4);
    const own = await sell(seller.token, lot, { totalValue: 30000000 });
    expect(own.statusCode).toBe(200);
    expect(String((await Contract.findOne({ lot: lot._id })).sellerId)).toBe(seller.userId);
  });

  it('a seller sells at the list price, dated today and without a separation nobody recorded', async () => {
    const lot = await newLot(6);
    const cheaper = await sell(seller.token, lot, { totalValue: 25000000 });
    expect(cheaper.statusCode).toBe(403);
    expect(cheaper.body.message).toMatch(/precio de lista/);
    const backdated = await sell(seller.token, lot, { contractDate: '2025-01-15' });
    expect(backdated.statusCode).toBe(403);
    const declared = await sell(seller.token, lot, { separationAmount: 500000 });
    expect(declared.statusCode).toBe(403);
    expect((await Lot.findById(lot._id)).status).toBe('disponible');
    // The office keeps those exceptions
    const office = await sell(org.token, lot, { totalValue: 25000000, separationAmount: 500000 });
    expect(office.statusCode).toBe(200);
  });

  it('a seller sells their own separation with the amount recorded, and never another seller\'s reservation', async () => {
    const reserve = (token, lot, body) => request(app).post(`/api/lots/${lot._id}/reserve?${q()}`).set('Authorization', `Bearer ${token}`)
      .send({ clientData: { name: `Comprador ${lot.lotNumber}`, idNumber: lot.lotNumber, phone: '3000000000' }, ...body });

    const mine = await newLot(7);
    expect((await reserve(seller.token, mine, { type: 'separado', amount: 600000 })).statusCode).toBe(200);
    expect((await sell(seller.token, mine, { separationAmount: 500000 })).statusCode).toBe(403);
    const sold = await sell(seller.token, mine, { separationAmount: 600000 });
    expect(sold.statusCode).toBe(200);

    const theirs = await newLot(8);
    expect((await reserve(otherSeller.token, theirs, { type: 'apartado' })).statusCode).toBe(200);
    const taken = await sell(seller.token, theirs, {});
    expect(taken.statusCode).toBe(403);
    expect(taken.body.message).toMatch(/otro asesor/);
  });

  it('changing the seller of a sale stays with the office', async () => {
    const lot = await newLot(9);
    await sell(org.token, lot, { sellerId: otherSeller.userId });
    const bySeller = await request(app).post(`/api/lots/${lot._id}/assign-seller?${q()}`).set('Authorization', `Bearer ${seller.token}`).send({ sellerId: seller.userId });
    expect(bySeller.statusCode).toBe(403);
  });

  it('the owner names a team member, and reassigning moves a commission nothing was filed for', async () => {
    const lot = await newLot(5);
    const sold = await sell(org.token, lot, { sellerId: seller.userId });
    expect(sold.statusCode).toBe(200);
    const contract = await Contract.findOne({ lot: lot._id });
    expect(String((await Commission.findOne({ contractId: contract._id })).sellerId)).toBe(seller.userId);
    const moved = await request(app).post(`/api/lots/${lot._id}/assign-seller?${q()}`).set('Authorization', `Bearer ${org.token}`).send({ sellerId: otherSeller.userId });
    expect(moved.statusCode).toBe(200);
    expect(moved.body.data.commissionWarning).toBeNull();
    expect(String((await Commission.findOne({ contractId: contract._id })).sellerId)).toBe(otherSeller.userId);

    // Reassigning follows the sale's rule: a random id or an account id is not a team member
    const random = await request(app).post(`/api/lots/${lot._id}/assign-seller?${q()}`).set('Authorization', `Bearer ${org.token}`).send({ sellerId: new mongoose.Types.ObjectId().toString() });
    expect(random.statusCode).toBe(400);
    const notAnId = await request(app).post(`/api/lots/${lot._id}/assign-seller?${q()}`).set('Authorization', `Bearer ${org.token}`).send({ sellerId: 'abc' });
    expect(notAnId.statusCode).toBe(400);

    // Once an installment is filed the commission stays with its seller, and the answer says so
    await Commission.updateOne({ contractId: contract._id }, { $set: { 'installments.0.status': 'FILED' } });
    const kept = await request(app).post(`/api/lots/${lot._id}/assign-seller?${q()}`).set('Authorization', `Bearer ${org.token}`).send({ sellerId: seller.userId });
    expect(kept.statusCode).toBe(200);
    expect(kept.body.data.commissionWarning).toMatch(/asesor anterior/);
    expect(String((await Commission.findOne({ contractId: contract._id })).sellerId)).toBe(otherSeller.userId);
  });
});
