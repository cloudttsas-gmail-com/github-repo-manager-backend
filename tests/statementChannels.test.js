import 'dotenv/config';
import { jest } from '@jest/globals';
import request from 'supertest';
import mongoose from 'mongoose';
import XLSX from 'xlsx';

jest.unstable_mockModule('../src/utils/storage.js', () => ({
  buildObjectKey: (folder) => `${folder}/test`,
  uploadToR2: async () => 'https://files.test/payments/test.png',
  deleteFromR2: async () => {},
  default: {},
}));
const { default: app } = await import('../src/app.js');
const { buildStatementSummary } = await import('../src/services/statementSummary.service.js');
const { publicLinkUrl } = await import('../src/utils/publicLinks.js');
const { generateAccessToken } = await import('../src/utils/jwt.js');
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import VerificationToken from '../src/models/VerificationToken.js';
import StatementDelivery from '../src/models/StatementDelivery.js';
import AuditLog from '../src/models/AuditLog.js';

const stamp = Date.now();
const password = 'Password123!';
const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n) => new Date(Date.now() + n * DAY);

const register = async (tag) => {
  const res = await request(app).post('/api/auth/register').send({
    name: `Owner ${tag}`, fullName: `Owner ${tag}`, email: `owner.${tag}.${stamp}@stmt.test`,
    password, confirmPassword: password,
    tenantName: `Tenant stmt ${tag} ${stamp}`, companyName: `Company stmt ${tag} ${stamp}`,
  });
  const company = res.body.data.company;
  const slug = `stmt-${tag}-${stamp}`;
  await Company.updateOne({ _id: company._id }, { $set: { slug } });
  return { token: res.body.data.accessToken, companyId: company._id, tenantId: company.tenantId, slug };
};

// Paid initial 200k, partial 40k of 100k (overdue), unpaid 100k (overdue), 100k due later
const quotaFixtures = () => [
  { number: 1, type: 'inicial', value: 200000, amountPaid: 200000, status: 'pagado', dueDate: daysFromNow(-60) },
  { number: 1, type: 'normal', value: 100000, amountPaid: 40000, status: 'pendiente', dueDate: daysFromNow(-40) },
  { number: 2, type: 'normal', value: 100000, status: 'pendiente', dueDate: daysFromNow(-10) },
  { number: 3, type: 'normal', value: 100000, status: 'pendiente', dueDate: daysFromNow(20) },
];

describe('Account statement in every channel', () => {
  let a;
  let b;
  let clientA;
  let contractA;
  let clientB;

  beforeAll(async () => {
    a = await register('a');
    b = await register('b');
    clientA = await Client.create({
      tenantId: a.tenantId, companyId: a.companyId, name: 'Ana Compradora', idNumber: `S${stamp}`,
      phone: '3001112233', email: `ana.${stamp}@stmt.test`,
    });
    contractA = await Contract.create({
      tenantId: a.tenantId, companyId: a.companyId, client: clientA._id, lot: new mongoose.Types.ObjectId(), totalValue: 500000,
    });
    await Quota.insertMany(quotaFixtures().map((q) => ({ ...q, tenantId: a.tenantId, companyId: a.companyId, contract: contractA._id })));
    clientB = await Client.create({ tenantId: b.tenantId, companyId: b.companyId, name: 'Otro Cliente', idNumber: `T${stamp}`, phone: '3009998877' });
  });

  afterAll(async () => {
    const tenantIds = [a?.tenantId, b?.tenantId].filter(Boolean);
    await StatementDelivery.deleteMany({ tenantId: { $in: tenantIds } });
    await AuditLog.deleteMany({ tenantId: { $in: tenantIds } });
    await VerificationToken.deleteMany({ tenantId: { $in: tenantIds } });
    await Quota.deleteMany({ tenantId: { $in: tenantIds } });
    await Contract.deleteMany({ tenantId: { $in: tenantIds } });
    await Client.deleteMany({ tenantId: { $in: tenantIds } });
    await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
    await User.deleteMany({ tenantId: { $in: tenantIds } });
    await Company.deleteMany({ tenantId: { $in: tenantIds } });
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    await UserAccount.deleteMany({ email: /stmt\.test$/ });
  });

  describe('summary', () => {
    it('counts paid, partial and overdue quotas once, the same way everywhere', () => {
      const quotas = quotaFixtures().map((q) => ({ ...q, _id: new mongoose.Types.ObjectId() }));
      const s = buildStatementSummary({ _id: new mongoose.Types.ObjectId(), totalValue: 500000 }, quotas);
      expect(s.totalPaid).toBe(240000);
      expect(s.balance).toBe(260000);
      expect(s.percentPaid).toBe(48);
      expect(s.overdueCount).toBe(2);
      expect(s.overdueAmount).toBe(160000);
      expect(s.daysOverdue).toBe(40);
      expect(s.status).toBe('en_mora');
      expect(s.nextQuota).toMatchObject({ number: 1, type: 'normal', pending: 60000, overdue: true });
      expect(s.quotas.map((q) => q.state)).toEqual(['pagada', 'mora', 'mora', 'pendiente']);
      expect(s.statementUrl).toContain('?s=');
      expect(s.excelUrl).toContain('/api/public/statement/excel/');
    });

    it('a quota due today is not overdue yet, and the stored mora status does not decide', () => {
      const now = new Date('2026-11-08T20:00:00-05:00');
      const quotas = [
        { _id: new mongoose.Types.ObjectId(), number: 1, type: 'normal', value: 100, status: 'pendiente', dueDate: new Date('2026-11-08T12:00:00-05:00') },
        { _id: new mongoose.Types.ObjectId(), number: 2, type: 'normal', value: 100, status: 'mora', dueDate: new Date('2026-12-08T12:00:00-05:00') },
        { _id: new mongoose.Types.ObjectId(), number: 3, type: 'normal', value: 100, status: 'pagado', dueDate: new Date('2026-10-08T12:00:00-05:00') },
      ];
      const s = buildStatementSummary({ _id: new mongoose.Types.ObjectId(), totalValue: 300 }, quotas, { now });
      expect(s.overdueCount).toBe(0);
      expect(s.status).toBe('al_dia');
      expect(s.totalPaid).toBe(100);
      expect(s.nextQuota.number).toBe(1);
    });

    it('the client detail in the panel shows the same numbers', async () => {
      const res = await request(app).get(`/api/clients/${clientA._id}?companyId=${a.companyId}`).set('Authorization', `Bearer ${a.token}`);
      expect(res.statusCode).toBe(200);
      const [contract] = res.body.data.contracts;
      expect(contract.totalPagado).toBe(240000);
      expect(contract.diasMora).toBe(40);
      expect(contract.statement).toMatchObject({ balance: 260000, overdueCount: 2, overdueAmount: 160000 });
    });

    it('the client list marks the client in mora by due date and counts partial payments', async () => {
      const res = await request(app).get(`/api/clients?companyId=${a.companyId}&moraOnly=true`).set('Authorization', `Bearer ${a.token}`);
      expect(res.statusCode).toBe(200);
      const row = res.body.data.clients.find((c) => String(c._id) === String(clientA._id));
      expect(row).toBeDefined();
      expect(row.totalPaid).toBe(240000);
    });

    it('the Pagos overdue figure counts quotas past due, not the stored status', async () => {
      const res = await request(app).get(`/api/payments/overdue-stats?companyId=${a.companyId}`).set('Authorization', `Bearer ${a.token}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual({ overdueQuotas: 2, overdueAmount: 160000, overdueContracts: 1 });
    });
  });

  describe('signed links', () => {
    it('the Excel link opens with its signature and has the summary and quotas', async () => {
      const url = publicLinkUrl('statement-excel', contractA._id, '');
      const res = await request(app).get(url).buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      const wb = XLSX.read(res.body, { type: 'buffer' });
      expect(wb.SheetNames).toEqual(['Resumen', 'Cuotas']);
      const summary = Object.fromEntries(XLSX.utils.sheet_to_json(wb.Sheets.Resumen, { header: 1 }).filter((r) => r[0]));
      expect(summary.Saldo).toBe(260000);
      expect(summary['Cuotas en mora']).toBe(2);
      expect(XLSX.utils.sheet_to_json(wb.Sheets.Cuotas)).toHaveLength(4);
    });

    it('the Excel link without a signature, or with the PDF one, is rejected', async () => {
      const unsigned = await request(app).get(`/api/public/statement/excel/${contractA._id}`);
      expect(unsigned.statusCode).toBe(403);
      const pdfSig = publicLinkUrl('statement', contractA._id, '').split('?s=')[1];
      const wrong = await request(app).get(`/api/public/statement/excel/${contractA._id}?s=${pdfSig}`);
      expect(wrong.statusCode).toBe(403);
    });

    it('the PDF link still opens with its signature', async () => {
      const res = await request(app).get(publicLinkUrl('statement', contractA._id, ''));
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    });
  });

  describe('panel: send the statement', () => {
    it('sends by email to the registered address and records it in the history', async () => {
      const res = await request(app).post(`/api/clients/statement/${contractA._id}/send?companyId=${a.companyId}`)
        .set('Authorization', `Bearer ${a.token}`).send({ channel: 'email', to: 'someone@else.test' });
      expect(res.statusCode).toBe(200);
      // notifications are off in tests: nothing leaves, but the attempt is recorded
      expect(res.body.data.status).toBe('disabled');

      const history = await request(app).get(`/api/clients/${clientA._id}/statement-deliveries?companyId=${a.companyId}`)
        .set('Authorization', `Bearer ${a.token}`);
      expect(history.statusCode).toBe(200);
      const [last] = history.body.data;
      expect(last).toMatchObject({ channel: 'email', source: 'panel', destination: clientA.email });
      expect(last.snapshot).toMatchObject({ balance: 260000, overdueCount: 2 });
    });

    it('sends by WhatsApp and records the copied link', async () => {
      const wa = await request(app).post(`/api/clients/statement/${contractA._id}/send?companyId=${a.companyId}`)
        .set('Authorization', `Bearer ${a.token}`).send({ channel: 'whatsapp' });
      expect(wa.statusCode).toBe(200);
      const link = await request(app).post(`/api/clients/statement/${contractA._id}/link?companyId=${a.companyId}`)
        .set('Authorization', `Bearer ${a.token}`);
      expect(link.statusCode).toBe(200);
      expect(link.body.data.statementUrl).toContain('?s=');
      const channels = (await StatementDelivery.find({ contractId: contractA._id, source: 'panel' })).map((d) => d.channel);
      expect(channels).toEqual(expect.arrayContaining(['whatsapp', 'link']));
    });

    it('rejects an unknown channel', async () => {
      const res = await request(app).post(`/api/clients/statement/${contractA._id}/send?companyId=${a.companyId}`)
        .set('Authorization', `Bearer ${a.token}`).send({ channel: 'sms' });
      expect(res.statusCode).toBe(400);
    });

    it('another company cannot send, share or read the history of this contract', async () => {
      const send = await request(app).post(`/api/clients/statement/${contractA._id}/send?companyId=${b.companyId}`)
        .set('Authorization', `Bearer ${b.token}`).send({ channel: 'email' });
      expect(send.statusCode).toBe(404);
      const link = await request(app).post(`/api/clients/statement/${contractA._id}/link?companyId=${b.companyId}`)
        .set('Authorization', `Bearer ${b.token}`);
      expect(link.statusCode).toBe(404);
      expect(link.body.data).toBeUndefined();
      const history = await request(app).get(`/api/clients/${clientA._id}/statement-deliveries?companyId=${b.companyId}`)
        .set('Authorization', `Bearer ${b.token}`);
      expect(history.statusCode).toBe(404);
      // and cannot point its own token at company A
      const cross = await request(app).post(`/api/clients/statement/${contractA._id}/send?companyId=${a.companyId}`)
        .set('Authorization', `Bearer ${b.token}`).send({ channel: 'email' });
      expect([403, 404]).toContain(cross.statusCode);
    });
  });

  describe('portal', () => {
    let portalToken;
    let otherPortalToken;

    beforeAll(async () => {
      const account = await UserAccount.create({ email: `portal.${stamp}@stmt.test`, passwordHash: password, fullName: 'Ana Compradora', status: 'active' });
      portalToken = generateAccessToken({
        accountId: account._id, userId: new mongoose.Types.ObjectId(), tenantId: a.tenantId, role: 'cliente', clientId: clientA._id, companies: [],
      });
      const other = await UserAccount.create({ email: `portal.b.${stamp}@stmt.test`, passwordHash: password, fullName: 'Otro Cliente', status: 'active' });
      otherPortalToken = generateAccessToken({
        accountId: other._id, userId: new mongoose.Types.ObjectId(), tenantId: b.tenantId, role: 'cliente', clientId: clientB._id, companies: [],
      });
    });

    it('Inicio shows overdue quotas and days overdue from the summary', async () => {
      const res = await request(app).get('/api/portal/summary').set('Authorization', `Bearer ${portalToken}`);
      expect(res.statusCode).toBe(200);
      const [contract] = res.body.data.contracts;
      expect(contract.statement).toMatchObject({ balance: 260000, overdueCount: 2, daysOverdue: 40 });
      expect(contract.hasEmail).toBe(true);
    });

    it('the contract page uses the same days overdue and quota states', async () => {
      const res = await request(app).get(`/api/portal/contract/${contractA._id}`).set('Authorization', `Bearer ${portalToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({ totalPagado: 240000, saldo: 260000, diasMora: 40, cuotasEnMora: 2 });
      expect(res.body.data.planPagos.map((q) => q.status)).toEqual(['PAGADA', 'VENCIDA', 'VENCIDA', 'PENDIENTE']);
    });

    it('downloads the Excel of an own contract only', async () => {
      const own = await request(app).get(`/api/portal/statement/${contractA._id}/excel`).set('Authorization', `Bearer ${portalToken}`);
      expect(own.statusCode).toBe(200);
      const foreign = await request(app).get(`/api/portal/statement/${contractA._id}/excel`).set('Authorization', `Bearer ${otherPortalToken}`);
      expect(foreign.statusCode).toBe(404);
    });

    it('«Envíame mi estado de cuenta» goes to the registered email', async () => {
      const res = await request(app).post(`/api/portal/statement/${contractA._id}/send-email`).set('Authorization', `Bearer ${portalToken}`);
      expect(res.statusCode).toBe(200);
      const last = await StatementDelivery.findOne({ contractId: contractA._id, source: 'portal', channel: 'email' }).sort({ createdAt: -1 });
      expect(last.destination).toBe(clientA.email);
    });
  });

  describe('public page: cédula, code and statement', () => {
    it('before the code is verified nothing about the account is returned', async () => {
      const info = await request(app).get(`/api/public/${a.slug}/client/${clientA.idNumber}`);
      expect(info.statusCode).toBe(200);
      expect(JSON.stringify(info.body)).not.toContain('Ana');
      expect(info.body.data.client.email).not.toBe(clientA.email);

      const sent = await request(app).post(`/api/public/${a.slug}/verification/send-code`)
        .send({ idNumber: clientA.idNumber, type: 'email', purpose: 'statement' });
      expect(sent.statusCode).toBe(200);
      expect(Object.keys(sent.body.data)).toEqual(['token']);

      const early = await request(app).post(`/api/public/${a.slug}/statement`).send({ token: sent.body.data.token });
      expect(early.statusCode).toBe(401);
      expect(early.body.data).toBeUndefined();
      expect(JSON.stringify(early.body)).not.toContain('260000');

      const noToken = await request(app).post(`/api/public/${a.slug}/statement`).send({});
      expect(noToken.statusCode).toBe(401);
    });

    it('after the code the buyer sees the summary with signed downloads, only in its company', async () => {
      const sent = await request(app).post(`/api/public/${a.slug}/verification/send-code`)
        .send({ idNumber: clientA.idNumber, type: 'phone', purpose: 'statement' });
      expect(sent.statusCode).toBe(200);
      const { token } = sent.body.data;
      const stored = await VerificationToken.findOne({ token });
      expect(stored.purpose).toBe('statement');

      const verified = await request(app).post(`/api/public/${a.slug}/verification/verify-code`).send({ token, code: stored.code });
      expect(verified.statusCode).toBe(200);

      const res = await request(app).post(`/api/public/${a.slug}/statement`).send({ token });
      expect(res.statusCode).toBe(200);
      const [summary] = res.body.data.contracts;
      expect(summary).toMatchObject({ balance: 260000, overdueCount: 2 });
      expect(summary.statementUrl).toContain('?s=');
      expect(summary.excelUrl).toContain('?s=');

      // The same token does not open another company's page
      const other = await request(app).post(`/api/public/${b.slug}/statement`).send({ token });
      expect(other.statusCode).toBe(401);

      // «Envíame mi estado de cuenta» from the public page, capped per client
      const send = await request(app).post(`/api/public/${a.slug}/statement/send-email`).send({ token, contractId: contractA._id });
      expect(send.statusCode).toBe(200);
      const statuses = [];
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        statuses.push((await request(app).post(`/api/public/${a.slug}/statement/send-email`).send({ token, contractId: contractA._id })).statusCode);
      }
      expect(statuses).toContain(429);

      const view = await StatementDelivery.findOne({ contractId: contractA._id, source: 'public', channel: 'view' });
      expect(view).not.toBeNull();
    });
  });
});
