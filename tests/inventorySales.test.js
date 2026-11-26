import 'dotenv/config';
import request from 'supertest';
import mongoose from 'mongoose';
import XLSX from 'xlsx';
import app from '../src/app.js';
import { generateAccessToken } from '../src/utils/jwt.js';
import { checkLotExpirations } from '../src/utils/lotExpiration.js';
import UserAccount from '../src/models/UserAccount.js';
import User from '../src/models/User.js';
import UserCompany from '../src/models/UserCompany.js';
import Tenant from '../src/models/Tenant.js';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import Lot from '../src/models/Lot.js';

// Inventory, reservations and the seller list (no transactions: any local mongod works)
const stamp = Date.now();
const password = 'Password123!';

describe('Inventory: reservations, sellers, filters and the lots import', () => {
  let org;
  let seller;
  let accountant;
  const q = () => `companyId=${org.companyId}`;
  const auth = (req, token = org.token) => req.set('Authorization', `Bearer ${token}`);

  const member = async (role, tag) => {
    const account = await UserAccount.create({ email: `${tag}.${stamp}@inventory.test`, passwordHash: password, fullName: `Miembro ${tag}`, status: 'active' });
    const user = await User.create({ accountId: account._id, tenantId: org.tenantId, role, status: 'active' });
    await UserCompany.create({ userId: user._id, companyId: org.companyId, tenantId: org.tenantId, role });
    return { userId: String(user._id), token: generateAccessToken({ accountId: account._id, userId: user._id, tenantId: org.tenantId, role, companies: [org.companyId] }) };
  };
  const newLot = (n, extra = {}) => Lot.create({
    tenantId: org.tenantId, companyId: org.companyId, stage: 'Etapa 1', manzana: 'R', lotNumber: `I-${n}-${stamp}`, area: 100, price: 30000000, status: 'disponible', ...extra,
  });
  const reserve = (lot, body, token) => auth(request(app).post(`/api/lots/${lot._id}/reserve?${q()}`), token)
    .send({ clientData: { name: `Comprador ${lot.lotNumber}`, idNumber: lot.lotNumber, phone: '3000000000' }, ...body });

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Owner', fullName: 'Owner', email: `owner.${stamp}@inventory.test`, password, confirmPassword: password,
      tenantName: `Tenant inventory ${stamp}`, companyName: `Company inventory ${stamp}`,
    });
    const company = res.body.data.company;
    org = { token: res.body.data.accessToken, companyId: String(company._id), tenantId: String(company.tenantId) };
    seller = await member('vendedor', 'seller');
    accountant = await member('contador', 'accountant');
  });

  afterAll(async () => {
    const tenantIds = [org?.tenantId].filter(Boolean);
    await Quota.deleteMany({ tenantId: { $in: tenantIds } });
    await Contract.deleteMany({ tenantId: { $in: tenantIds } });
    await Client.deleteMany({ tenantId: { $in: tenantIds } });
    await Lot.deleteMany({ tenantId: { $in: tenantIds } });
    await UserCompany.deleteMany({ tenantId: { $in: tenantIds } });
    await User.deleteMany({ tenantId: { $in: tenantIds } });
    await Company.deleteMany({ tenantId: { $in: tenantIds } });
    await Tenant.deleteMany({ _id: { $in: tenantIds } });
    await UserAccount.deleteMany({ email: /inventory\.test$/ });
  });

  it('a separation keeps the amount paid and the seller the form names, not whoever registers it', async () => {
    const lot = await newLot(1);
    const res = await reserve(lot, { type: 'separado', amount: 1200000, sellerId: seller.userId });
    expect(res.statusCode).toBe(200);
    const saved = await Lot.findById(lot._id);
    expect(saved.reservationAmount).toBe(1200000);
    expect(String(saved.sellerId)).toBe(seller.userId);
  });

  it('a reservation without a seller stays without one', async () => {
    const lot = await newLot(2);
    const res = await reserve(lot, { type: 'apartado' });
    expect(res.statusCode).toBe(200);
    const saved = await Lot.findById(lot._id);
    expect(saved.sellerId).toBeUndefined();
    expect(saved.reservationAmount).toBeUndefined();
  });

  it('a reservation refuses a seller who is not on the team', async () => {
    const lot = await newLot(3);
    const res = await reserve(lot, { type: 'apartado', sellerId: new mongoose.Types.ObjectId().toString() });
    expect(res.statusCode).toBe(400);
    expect((await Lot.findById(lot._id)).status).toBe('disponible');
  });

  it('releasing or expiring a reservation clears its seller and amount', async () => {
    const released = await newLot(4);
    await reserve(released, { type: 'separado', amount: 600000, sellerId: seller.userId });
    const res = await auth(request(app).post(`/api/lots/${released._id}/release?${q()}`)).send({ reason: 'cancelacion_cliente' });
    expect(res.statusCode).toBe(200);
    const afterRelease = await Lot.findById(released._id);
    expect(afterRelease.sellerId).toBeUndefined();
    expect(afterRelease.reservationAmount).toBeUndefined();

    const expired = await newLot(5);
    await reserve(expired, { type: 'separado', amount: 700000, sellerId: seller.userId });
    await Lot.updateOne({ _id: expired._id }, { $set: { expiresAt: new Date(Date.now() - 60000) } });
    await checkLotExpirations(org.tenantId, org.companyId);
    const afterExpiry = await Lot.findById(expired._id);
    expect(afterExpiry.status).toBe('disponible');
    expect(afterExpiry.sellerId).toBeUndefined();
    expect(afterExpiry.reservationAmount).toBeUndefined();
  });

  it('whoever sells gets the seller list (an accountant), and a seller does not', async () => {
    const asAccountant = await auth(request(app).get(`/api/admin-users/sellers?${q()}`), accountant.token);
    expect(asAccountant.statusCode).toBe(200);
    expect(asAccountant.body.data.map((s) => String(s.id))).toContain(seller.userId);
    const asSeller = await auth(request(app).get(`/api/admin-users/sellers?${q()}`), seller.token);
    expect(asSeller.statusCode).toBe(403);
  });

  it('the list filters by tower and floor, and the search finds a tower', async () => {
    await Company.updateOne({ _id: org.companyId }, { $set: { propertyType: 'apartamentos' } });
    const base = { propertyType: 'apartamentos', manzana: undefined };
    await newLot(10, { ...base, tower: 'Norte', floor: '1', lotNumber: `101-${stamp}` });
    await newLot(11, { ...base, tower: 'Norte', floor: '10', lotNumber: `1001-${stamp}` });
    await newLot(12, { ...base, tower: 'Sur', floor: '1', lotNumber: `102-${stamp}` });
    const list = (params) => auth(request(app).get(`/api/lots?${q()}&limit=50&${params}`));

    const north = await list('tower=norte');
    expect(north.body.data.lots.map((l) => l.tower)).toEqual(expect.arrayContaining(['Norte', 'Norte']));
    expect(north.body.data.lots.every((l) => l.tower === 'Norte')).toBe(true);

    const firstFloor = await list('floor=1');
    expect(firstFloor.body.data.lots).toHaveLength(2);
    expect(firstFloor.body.data.lots.every((l) => l.floor === '1')).toBe(true);

    const searched = await list('search=Sur');
    expect(searched.body.data.lots.map((l) => l.tower)).toEqual(['Sur']);
    await Company.updateOne({ _id: org.companyId }, { $set: { propertyType: 'lotes' } });
  });

  it('resending the payment plan to a buyer without email says so instead of «enviado»', async () => {
    const client = await Client.create({ tenantId: org.tenantId, companyId: org.companyId, name: 'Sin correo', idNumber: `NC${stamp}`, phone: '3000000001' });
    const contract = await Contract.create({ tenantId: org.tenantId, companyId: org.companyId, client: client._id, lot: new mongoose.Types.ObjectId(), totalValue: 1000000 });
    await Quota.create({ tenantId: org.tenantId, companyId: org.companyId, contract: contract._id, number: 1, type: 'normal', value: 1000000, dueDate: new Date(), status: 'pendiente' });
    const res = await auth(request(app).post(`/api/clients/resend-plan/${contract._id}?${q()}`)).send();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/no tiene correo/);
  });

  it('the lots import takes «Mz A» and «Lote 5» without repeating the label, and names missing columns as the template does', async () => {
    const template = await auth(request(app).get('/api/import/template-lots?propertyType=lotes')).buffer(true)
      .parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    const rows = XLSX.utils.sheet_to_json(XLSX.read(template.body, { type: 'buffer' }).Sheets['Plantilla Inventario']);
    expect(rows[0].Manzana).toBe('A');
    expect(String(rows[0].Lote)).toBe('5');

    const sheet = XLSX.utils.aoa_to_sheet([
      ['Etapa', 'Manzana', 'Lote', 'Area', 'Valor Metro Cuadrado'],
      ['Etapa Import', 'Mz A', 'Lote 5', 120, 375000],
      ['Etapa Import', '', '6', 120, 375000],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Hoja');
    const file = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const res = await auth(request(app).post(`/api/import/excel-lots?${q()}`)).attach('file', file, 'lotes.xlsx');
    expect(res.statusCode).toBe(200);
    expect(res.body.summary.lotsCreated).toBe(1);
    const created = await Lot.findOne({ companyId: org.companyId, stage: 'Etapa Import' });
    expect(created.nomenclature).toBe('Etapa Import - Mz A - Lote 5');
    expect(created.manzana).toBe('A');
    expect(created.lotNumber).toBe('5');
    expect(res.body.errors[0]).toMatch(/Fila 3: faltan columnas obligatorias \(Manzana\)/);
  });
});
