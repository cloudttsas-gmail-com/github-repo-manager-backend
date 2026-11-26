import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import Company from '../src/models/Company.js';
import TemplateVersion from '../src/models/TemplateVersion.js';
import TemplateMedia from '../src/models/TemplateMedia.js';
import { buildRestoreEdit } from '../src/services/whatsappTemplates.service.js';
import { actorOf, ensureBaseline, findVersion, listVersions, recordVersion } from '../src/services/templateHistory.service.js';
import connectDB from '../src/config/database.js';

const stamp = Date.now();

describe('Template history: every change is kept and a template can go back to an earlier version', () => {
  let company;
  const meta = (extra = {}) => ({
    id: '900', name: 'recordatorio_demo', language: 'es', status: 'APPROVED', category: 'UTILITY', parameter_format: 'NAMED',
    components: [{ type: 'BODY', text: 'Hola {{nombre_comprador}}, tu cuota vence pronto.', example: { body_text_named_params: [{ param_name: 'nombre_comprador', example: 'Laura' }] } }],
    ...extra,
  });

  beforeAll(async () => {
    await connectDB();
    company = await Company.create({
      tenantId: new mongoose.Types.ObjectId(), name: `Historial ${stamp}`, slug: `historial-${stamp}`,
      integrations: { whatsappConnectedAt: new Date(), whatsappAccessToken: 'token', whatsappPhoneId: 'phone', whatsappWabaId: 'waba' },
    });
  });

  afterAll(async () => {
    await TemplateVersion.deleteMany({ companyId: company._id });
    await TemplateMedia.deleteMany({ companyId: company._id });
    await Company.deleteOne({ _id: company._id });
  });

  it('keeps the version found in Meta once, then each change with who made it and under which role', async () => {
    await ensureBaseline(company, meta());
    await ensureBaseline(company, meta());
    const user = { userId: new mongoose.Types.ObjectId(), fullName: 'Ana Cartera', role: 'jefe_cartera' };
    await recordVersion(company, meta({ components: [{ type: 'BODY', text: 'Hola {{nombre_comprador}}, gracias.' }] }), { action: 'edited', actor: actorOf(user) });

    const versions = await listVersions(company, meta());
    expect(versions.map((v) => v.action)).toEqual(['edited', 'found']);
    expect(versions[0].by).toMatchObject({ name: 'Ana Cartera', role: 'jefe_cartera' });
    expect(versions[1].by?.name).toBeUndefined();
    expect(versions[1].components[0].text).toMatch(/vence pronto/);
  });

  it('a version of another template is not found', async () => {
    const [version] = await listVersions(company, meta());
    expect(await findVersion(company, meta({ name: 'otra' }), version._id)).toBeNull();
  });

  it('going back sends the old parts as they were; an approved template keeps its category', async () => {
    const found = (await listVersions(company, meta())).find((v) => v.action === 'found');
    const edit = await buildRestoreEdit(company, meta({ category: 'MARKETING' }), found);
    expect(edit.category).toBeUndefined();
    expect(edit.parameter_format).toBe('NAMED');
    expect(edit.components[0].text).toBe('Hola {{nombre_comprador}}, tu cuota vence pronto.');
  });

  it('a notice of Operix only takes back its text, and only with its data', async () => {
    const notice = { id: '901', name: 'operix_pago_rechazado', language: 'es', status: 'APPROVED', category: 'UTILITY', components: [] };
    const old = { components: [{ type: 'BODY', text: 'Hola {{1}}, {{2}} no pudo aprobar el pago de {{3}} que reportó el {{4}}. Motivo: {{5}}. Puede reportarlo de nuevo.' }] };
    const edit = await buildRestoreEdit(company, notice, old);
    expect(edit.components.find((c) => c.type === 'BODY').text).toBe(old.components[0].text);
    await expect(buildRestoreEdit(company, notice, { components: [{ type: 'BODY', text: 'Hola {{1}}, pago no aprobado.' }] })).rejects.toThrow(/conservar/);
  });

  it('a media header gets a fresh sample; one in review is not edited', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => (
      String(url).includes('/uploads?')
        ? { ok: true, json: async () => ({ id: 'upload:1' }) }
        : { ok: true, json: async () => ({ h: 'fresh-handle' }) }
    ));
    try {
      const withDocument = { category: 'UTILITY', components: [{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['old'] } }, { type: 'BODY', text: 'Tu estado de cuenta.' }], media: { source: 'estado_cuenta' } };
      const savedAppId = process.env.META_APP_ID;
      process.env.META_APP_ID = 'app-test';
      let edit;
      try { edit = await buildRestoreEdit(company, meta(), withDocument); } finally {
        if (savedAppId === undefined) delete process.env.META_APP_ID; else process.env.META_APP_ID = savedAppId;
      }
      expect(edit.components[0].example).toEqual({ header_handle: ['fresh-handle'] });
      await expect(buildRestoreEdit(company, meta({ status: 'PENDING' }), withDocument)).rejects.toThrow(/revisando/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

});
