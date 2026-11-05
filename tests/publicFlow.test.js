import request from 'supertest';
import app from '../src/app.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import Bank from '../src/models/Bank.js';
import VerificationToken from '../src/models/VerificationToken.js';
import { publicLinkUrl } from '../src/utils/publicLinks.js';

const stamp = Date.now();
const password = 'Password123!';

describe('Public payment flow and bank scoping', () => {
  let a;
  let b;
  let slug;

  const register = async (name) => {
    const res = await request(app).post('/api/auth/register').send({
      name: `Owner ${name}`, fullName: `Owner ${name}`, email: `owner-${name}.${stamp}@public.test`,
      password, confirmPassword: password,
      tenantName: `Tenant ${name} ${stamp}`, companyName: `Company ${name} ${stamp}`,
    });
    return {
      token: res.body.data.accessToken,
      companyId: res.body.data.company._id,
      tenantId: res.body.data.company.tenantId,
    };
  };

  beforeAll(async () => {
    a = await register('a');
    b = await register('b');
    const company = await Company.findById(a.companyId);
    slug = company.slug || `public-${stamp}`;
    if (!company.slug) await Company.updateOne({ _id: company._id }, { slug });
    await Client.create({
      tenantId: a.tenantId, companyId: a.companyId, name: 'Buyer Secret Name',
      idNumber: `P${stamp}`, phone: '3001234567', email: `buyer.${stamp}@public.test`,
    });
  });

  afterAll(async () => {
    const tenantIds = [a?.tenantId, b?.tenantId].filter(Boolean);
    await VerificationToken.deleteMany({ tenantId: { $in: tenantIds } });
    await Bank.deleteMany({ socialDenomination: /PUBLIC TEST/ });
    await Client.deleteMany({ tenantId: { $in: tenantIds } });
    await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
    await User.deleteMany({ tenantId: { $in: tenantIds } });
    await Company.deleteMany({ tenantId: { $in: tenantIds } });
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    await UserAccount.deleteMany({ email: /public\.test$/ });
  });

  it('the lookup by id number returns only masked contact data', async () => {
    const res = await request(app).get(`/api/public/${slug}/client/P${stamp}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.contracts).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/Buyer Secret Name|3001234567|buyer\./);
    expect(res.body.data.client.phone).toMatch(/\*+4567$/);
  });

  it('a client gets at most three codes in ten minutes', async () => {
    const send = () => request(app).post(`/api/public/${slug}/verification/send-code`)
      .send({ idNumber: `P${stamp}`, type: 'email' });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await send()).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('bulk bank loads stay in the requester company', async () => {
    const res = await request(app).post(`/api/banks/bulk?companyId=${a.companyId}`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ banks: [
        { type: '1', code: '901', socialDenomination: 'PUBLIC TEST GLOBAL', acronym: 'PTG', tenantId: null, companyId: null },
        { type: '1', code: '902', socialDenomination: 'PUBLIC TEST OTHER', acronym: 'PTO', tenantId: b.tenantId, companyId: b.companyId },
      ] });
    expect(res.statusCode).toBe(201);
    const created = await Bank.find({ socialDenomination: /PUBLIC TEST/ });
    expect(created).toHaveLength(2);
    created.forEach((bank) => {
      expect(bank.tenantId.toString()).toBe(a.tenantId.toString());
      expect(bank.companyId.toString()).toBe(a.companyId.toString());
    });
  });

  it('updating a bank cannot move it to another company', async () => {
    const bank = await Bank.findOne({ socialDenomination: 'PUBLIC TEST GLOBAL' });
    const url = `/api/banks/${bank._id}?companyId=${a.companyId}`;
    const auth = { Authorization: `Bearer ${a.token}` };
    const foreignCompany = await request(app).put(url).set(auth).send({ acronym: 'X', companyId: b.companyId });
    const foreignTenant = await request(app).put(url).set(auth).send({ acronym: 'PTG2', tenantId: b.tenantId });
    expect([foreignCompany.statusCode, foreignTenant.statusCode]).toEqual([404, 200]);
    const after = await Bank.findById(bank._id);
    expect(after.acronym).toBe('PTG2');
    expect(after.tenantId.toString()).toBe(a.tenantId.toString());
    expect(after.companyId.toString()).toBe(a.companyId.toString());
  });
  it('receipt and statement links need their own signature', async () => {
    const id = '0123456789abcdef01234567';
    const other = 'fedcba9876543210fedcba98';
    const signed = (kind, rid) => publicLinkUrl(kind, rid, '').replace(/^.*\/api/, '/api');
    const statuses = await Promise.all([
      request(app).get(`/api/public/statement/${id}`),
      request(app).get(`/api/public/statement/${id}?s=forged`),
      request(app).get(signed('statement', other).replace(other, id)),
      request(app).get(signed('receipt', id).replace('/receipt/', '/statement/')),
      request(app).get(`/api/public/receipt/${id}`),
      request(app).get(signed('statement', id)),
      request(app).get(signed('receipt', id)),
    ].map((p) => p.then((r) => r.statusCode)));
    // a valid signature passes the check and reaches the lookup (404: no such document)
    expect(statuses).toEqual([403, 403, 403, 403, 403, 404, 404]);
  });
});

describe('parseBusinessDate', () => {
  it('keeps date-only values on the same day in Colombia', async () => {
    const { parseBusinessDate } = await import('../src/utils/dates.js');
    const d = parseBusinessDate('2026-11-05');
    expect(d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })).toBe('2026-11-05');
    expect(d.toISOString().slice(0, 10)).toBe('2026-11-05');
    const fallback = new Date(0);
    expect(parseBusinessDate('', fallback)).toBe(fallback);
    expect(parseBusinessDate('not a date', fallback)).toBe(fallback);
  });
});

describe('unsigned public links grace period', () => {
  const id = '0123456789abcdef01234567';
  afterEach(() => { delete process.env.PUBLIC_LINKS_UNSIGNED_UNTIL; });

  it('old unsigned links open only while the grace date has not passed', async () => {
    const get = (q = '') => request(app).get(`/api/public/statement/${id}${q}`).then((r) => r.statusCode);
    expect(await get()).toBe(403);
    process.env.PUBLIC_LINKS_UNSIGNED_UNTIL = '2999-12-31';
    expect(await get()).toBe(404);
    expect(await get('?s=forged')).toBe(403);
    process.env.PUBLIC_LINKS_UNSIGNED_UNTIL = '2000-01-01';
    expect(await get()).toBe(403);
  });
});

describe('company bank accounts on payments', () => {
  let companyId;
  let otherCompanyId;
  let active;
  let inactive;
  let foreign;

  beforeAll(async () => {
    const tenant = await Tenant.create({ name: `Bank tenant ${stamp}` });
    const c = await Company.create({
      tenantId: tenant._id, name: `Bank company ${stamp}`, slug: `bank-company-${stamp}`,
      bankAccounts: [
        { banco: 'BANCOLOMBIA', tipoCuenta: 'Ahorros', numeroCuenta: '111', accountingAccount: '11100501' },
        { banco: 'DAVIVIENDA', tipoCuenta: 'Corriente', numeroCuenta: '222', isActive: false },
      ],
    });
    const other = await Company.create({
      tenantId: tenant._id, name: `Other bank company ${stamp}`, slug: `other-bank-company-${stamp}`,
      bankAccounts: [{ banco: 'BBVA', tipoCuenta: 'Ahorros', numeroCuenta: '333' }],
    });
    companyId = c._id;
    otherCompanyId = other._id;
    [active, inactive] = c.bankAccounts;
    [foreign] = other.bankAccounts;
  });

  afterAll(async () => {
    await Company.deleteMany({ _id: { $in: [companyId, otherCompanyId] } });
    await Tenant.deleteMany({ name: `Bank tenant ${stamp}` });
  });

  it('stores the bank of the chosen active account, and rejects inactive or foreign ones', async () => {
    const { resolveBankChoice } = await import('../src/utils/bankAccounts.js');
    expect(await resolveBankChoice(companyId, { bankAccountId: active._id.toString(), bank: 'whatever' }))
      .toEqual({ banco: 'BANCOLOMBIA', bankAccountId: active._id });
    await expect(resolveBankChoice(companyId, { bankAccountId: inactive._id.toString() })).rejects.toMatchObject({ statusCode: 400 });
    await expect(resolveBankChoice(companyId, { bankAccountId: foreign._id.toString() })).rejects.toMatchObject({ statusCode: 400 });
    expect(await resolveBankChoice(companyId, { bank: 'NEQUI' })).toEqual({ banco: 'NEQUI', bankAccountId: null });
  });
});
