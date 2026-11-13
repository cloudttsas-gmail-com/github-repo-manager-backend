import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import VerificationToken from '../src/models/VerificationToken.js';
import Lot from '../src/models/Lot.js';
import Contract from '../src/models/Contract.js';
import Quota from '../src/models/Quota.js';
import { whatsappService } from '../src/services/whatsapp.service.js';
import {
  DEFAULT_TEMPLATES, companyWhatsAppAccount, ensureDefaultTemplates, sendCompanyNotice, publicLinkSuffix, propertyName, internationalPhone,
  buildCompanyTemplate, templateFieldsFor, prepareHeaderSample, projectSamples,
} from '../src/services/whatsappTemplates.service.js';
import { sendOTPCode } from '../src/utils/otpHelper.js';
import connectDB from '../src/config/database.js';

const stamp = Date.now();
const connected = {
  name: 'Inmobiliaria Horizonte', slug: `horizonte-${stamp}`, phone: '6015551234',
  integrations: { whatsappConnectedAt: new Date(), whatsappAccessToken: 'company-token', whatsappPhoneId: 'company-phone', whatsappWabaId: 'company-waba' },
};
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    Object.entries(saved).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
};

describe('Each company sends its notices with templates of its own WhatsApp account', () => {
  beforeAll(async () => { await connectDB(); });

  it('a company uses its own account; without one there is none, unless development lists its slug', async () => {
    expect(companyWhatsAppAccount(connected)).toMatchObject({ accessToken: 'company-token', phoneNumberId: 'company-phone', own: true });
    const loose = { name: 'Sin número', slug: `sin-numero-${stamp}`, integrations: {} };
    await withEnv({ WHATSAPP_ACCESS_TOKEN: 'server-token', WHATSAPP_PHONE_NUMBER_ID: 'server-phone', WHATSAPP_SERVER_ACCOUNT_SLUGS: '' }, async () => {
      expect(companyWhatsAppAccount(loose)).toBeNull();
    });
    await withEnv({ WHATSAPP_ACCESS_TOKEN: 'server-token', WHATSAPP_PHONE_NUMBER_ID: 'server-phone', WHATSAPP_SERVER_ACCOUNT_SLUGS: `otro, ${loose.slug}` }, async () => {
      expect(companyWhatsAppAccount(loose)).toMatchObject({ accessToken: 'server-token', own: false });
    });
  });

  it('the approved texts follow the Meta rules: no variable at the start or end, and one example per variable', () => {
    for (const [name, definition] of Object.entries(DEFAULT_TEMPLATES)) {
      const components = definition.components({ companyName: connected.name, companyPhone: connected.phone, handle: 'h' });
      const bodyPart = components.find((c) => c.type === 'BODY');
      if (definition.category === 'AUTHENTICATION') continue;
      expect(bodyPart.text.trim().startsWith('{{')).toBe(false);
      // A closing period does not count: Meta still sees the variable at the end
      expect(bodyPart.text.trim().replace(/[.!?]+$/, '').endsWith('}}')).toBe(false);
      const variables = bodyPart.text.match(/\{\{\d+\}\}/g) || [];
      expect(bodyPart.example.body_text[0]).toHaveLength(new Set(variables).size);
      expect(components.find((c) => c.type === 'FOOTER').text).toBe(connected.name);
      expect(name.startsWith('operix_')).toBe(true);
    }
  });

  it('creates in the company account only the templates it lacks, with the sample document for PDF headers', async () => {
    const calls = [];
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET' });
      if (String(url).includes('/uploads?')) return { ok: true, json: async () => ({ id: 'upload:session' }) };
      return { ok: true, json: async () => ({ h: 'sample-handle' }) };
    });
    const listSpy = jest.spyOn(whatsappService, 'getTemplates').mockResolvedValue([{ name: 'operix_codigo', language: 'es', status: 'APPROVED' }]);
    const createSpy = jest.spyOn(whatsappService, 'createTemplate').mockResolvedValue({ status: 'PENDING' });
    try {
      const results = await withEnv({ META_APP_ID: 'app-test', API_URL: 'https://api.test' }, () => ensureDefaultTemplates(connected));
      expect(listSpy.mock.calls[0][0]).toMatchObject({ wabaId: 'company-waba' });
      expect(results.find((r) => r.name === 'operix_codigo')).toMatchObject({ result: 'existing', status: 'APPROVED' });
      const created = createSpy.mock.calls.map((c) => c[1]);
      expect(created.map((t) => t.name)).not.toContain('operix_codigo');
      expect(created).toHaveLength(Object.keys(DEFAULT_TEMPLATES).length - 1);
      createSpy.mock.calls.forEach((c) => expect(c[0]).toMatchObject({ wabaId: 'company-waba' }));
      const receipt = created.find((t) => t.name === 'operix_pago_recibido');
      expect(receipt.components[0]).toMatchObject({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['sample-handle'] } });
      expect(receipt.components.at(-1).buttons[0].url).toBe('https://api.test/api/public/{{1}}');
      expect(calls.some((c) => c.url.includes('/app-test/uploads?'))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      listSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it('sends a receipt from the company number with the PDF attached and the signed statement link', async () => {
    const spy = jest.spyOn(whatsappService, 'sendTemplateMessage').mockResolvedValue({ messages: [{ id: 'wamid.ok' }] });
    try {
      const result = await withEnv({ ENABLE_NOTIFICATIONS: 'true' }, () => sendCompanyNotice({
        company: connected,
        to: '3001234567',
        notice: 'pago_recibido',
        values: {
          clientName: 'Laura', companyName: connected.name, amount: '$1.000', date: '01/03/2027', property: 'el lote 12',
          receiptNumber: 57, receiptUrl: 'https://api.test/api/public/receipt/attempt/abc?s=sig1', statementUrl: 'https://api.test/api/public/statement/xyz?s=sig2',
        },
      }));
      expect(result.success).toBe(true);
      const [account, to, name, language, components] = spy.mock.calls[0];
      expect(account).toMatchObject({ phoneNumberId: 'company-phone' });
      expect([to, name, language]).toEqual(['3001234567', 'operix_pago_recibido', 'es']);
      expect(components[0].parameters[0].document).toEqual({ link: 'https://api.test/api/public/receipt/attempt/abc?s=sig1', filename: 'Recibo 57.pdf' });
      expect(components[1].parameters).toHaveLength(6);
      expect(components[2].parameters[0].text).toBe('statement/xyz?s=sig2');
    } finally {
      spy.mockRestore();
    }
  });

  it('a company without a number sends nothing by WhatsApp; with notices off nothing goes out at all', async () => {
    const spy = jest.spyOn(whatsappService, 'sendTemplateMessage');
    try {
      const loose = { name: 'Sin número', slug: `sin-${stamp}`, integrations: {} };
      const off = await withEnv({ ENABLE_NOTIFICATIONS: 'false' }, () => sendCompanyNotice({ company: connected, to: '3001234567', notice: 'codigo', values: { code: '123456' } }));
      expect(off).toMatchObject({ success: true, provider: 'disabled' });
      const none = await withEnv({ ENABLE_NOTIFICATIONS: 'true', WHATSAPP_SERVER_ACCOUNT_SLUGS: '' }, () => sendCompanyNotice({ company: loose, to: '3001234567', notice: 'codigo', values: { code: '123456' } }));
      expect(none.success).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a code asked by WhatsApp in a project without a number tells the buyer to pick another channel', async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const company = await Company.create({ tenantId, name: `Sin número ${stamp}`, slug: `sin-codigo-${stamp}` });
    const client = await Client.create({ tenantId, companyId: company._id, name: 'Comprador', idNumber: `W${stamp}`, phone: '3001234567' });
    try {
      await withEnv({ ENABLE_NOTIFICATIONS: 'true', WHATSAPP_SERVER_ACCOUNT_SLUGS: '' }, async () => {
        await expect(sendOTPCode(tenantId, company._id, client._id, 'phone', '3001234567', company.name, 'login'))
          .rejects.toMatchObject({ statusCode: 502 });
      });
    } finally {
      await VerificationToken.deleteMany({ clientId: client._id });
      await Client.deleteOne({ _id: client._id });
      await Company.deleteOne({ _id: company._id });
    }
  });

  it('a rejected default template gets the current text and goes back to review', async () => {
    const listSpy = jest.spyOn(whatsappService, 'getTemplates').mockResolvedValue(
      Object.keys(DEFAULT_TEMPLATES).map((name) => ({ id: `id-${name}`, name, language: 'es', status: name === 'operix_bienvenida' ? 'REJECTED' : 'APPROVED' })),
    );
    const editSpy = jest.spyOn(whatsappService, 'editTemplate').mockResolvedValue({ success: true });
    const createSpy = jest.spyOn(whatsappService, 'createTemplate');
    try {
      const results = await ensureDefaultTemplates(connected);
      expect(results.find((r) => r.name === 'operix_bienvenida')).toMatchObject({ result: 'resubmitted', status: 'PENDING' });
      expect(editSpy).toHaveBeenCalledTimes(1);
      expect(editSpy.mock.calls[0][1]).toBe('id-operix_bienvenida');
      expect(editSpy.mock.calls[0][2].components.find((c) => c.type === 'BODY').text).not.toMatch(/gracias|bienvenid/i);
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      editSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it('the call button gets the number in international format, or is left out', () => {
    expect(internationalPhone('3001234567')).toBe('+573001234567');
    expect(internationalPhone('601 555 1234')).toBe('+576015551234');
    expect(internationalPhone('+57 300 123 4567')).toBe('+573001234567');
    expect(internationalPhone('12345')).toBeNull();
    const buttons = DEFAULT_TEMPLATES.operix_cuota_vencida.components({ companyName: 'X', companyPhone: '12345' }).at(-1).buttons;
    expect(buttons.map((b) => b.type)).toEqual(['URL']);
  });

  it('names the property and cuts the signed link after /api/public/', () => {
    expect(propertyName({ lotNumber: '12', manzana: 'B' }, 'lotes')).toBe('el lote 12 de la manzana B');
    expect(propertyName({ lotNumber: '301', propertyType: 'apartamentos' })).toBe('el apartamento 301');
    expect(propertyName(null)).toBe('su inmueble');
    expect(publicLinkSuffix('https://api.test/api/public/statement/xyz?s=sig')).toBe('statement/xyz?s=sig');
  });
});

describe('A company template only carries Operix data as named variables', () => {
  const company = { name: 'Inmobiliaria Horizonte', phone: '6015551234' };

  it('turns the inserted data into named variables with a sample for each one', () => {
    const t = buildCompanyTemplate(company, {
      name: 'recordatorio_demo', category: 'UTILITY', footer: 'Proyecto Demo',
      body: 'Hola {{nombre_comprador}}, su cuota de {{inmueble}} vence el {{fecha_vencimiento}}. Gracias por su pago, {{nombre_comprador}}, y que tenga buen día.',
      examples: { fecha_vencimiento: '05/12/2026' },
    });
    expect(t.parameter_format).toBe('NAMED');
    const bodyPart = t.components.find((c) => c.type === 'BODY');
    expect(bodyPart.example.body_text_named_params).toEqual([
      { param_name: 'nombre_comprador', example: 'Laura Gómez' },
      { param_name: 'inmueble', example: 'el lote 12 de la manzana B' },
      { param_name: 'fecha_vencimiento', example: '05/12/2026' },
    ]);
    expect(t.components.at(-1)).toEqual({ type: 'FOOTER', text: 'Proyecto Demo' });
    expect(templateFieldsFor(company).find((f) => f.key === 'nombre_proyecto').example).toBe('Inmobiliaria Horizonte');
  });

  it('a text without data is sent without parameter format or samples', () => {
    const t = buildCompanyTemplate(company, { name: 'aviso_simple', body: 'Recuerde revisar su estado de cuenta en el portal.' });
    expect(t.parameter_format).toBeUndefined();
    expect(t.components).toEqual([{ type: 'BODY', text: 'Recuerde revisar su estado de cuenta en el portal.' }]);
  });

  it.each([
    [{ name: 'x', body: 'Hola {{1}}, su cuota vence pronto.' }, /no es un dato de Operix/],
    [{ name: 'x', body: '{{nombre_comprador}}, su cuota vence pronto.' }, /empiece/],
    [{ name: 'x', body: 'Su cuota vence el {{fecha_vencimiento}}.' }, /termine/],
    [{ name: 'x', header: 'Hola {{nombre_comprador}}', body: 'Su cuota vence pronto.' }, /encabezado/],
    [{ name: 'operix_mio', body: 'Su cuota vence pronto.' }, /operix_/],
    [{ name: 'Con Espacios', body: 'Su cuota vence pronto.' }, /minúsculas/],
  ])('rejects what Meta would reject: %j', (input, message) => {
    expect(() => buildCompanyTemplate(company, input)).toThrow(message);
  });
});

describe('A company template can carry an image, a video or a document in its header', () => {
  const company = { name: 'Inmobiliaria Horizonte' };

  it('uses the sample handle Meta gave for the media header', () => {
    const t = buildCompanyTemplate(company, {
      name: 'estado_mensual', body: 'Le compartimos su estado de cuenta del mes. Gracias por estar al día.',
      headerFormat: 'DOCUMENT', headerHandle: 'h-sample', header: 'ignored text',
    });
    expect(t.components[0]).toEqual({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['h-sample'] } });
  });

  it('a media header without its sample is rejected', () => {
    expect(() => buildCompanyTemplate(company, { name: 'foto', body: 'Así va la obra de su proyecto este mes.', headerFormat: 'IMAGE' }))
      .toThrow(/archivo de ejemplo/);
  });

  it('a document Operix makes per buyer gets a sample PDF; a file must match the chosen format', async () => {
    const withAccount = { ...connected };
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => (
      String(url).includes('/uploads?')
        ? { ok: true, json: async () => ({ id: 'upload:s' }) }
        : { ok: true, json: async () => ({ h: 'h-pdf' }) }
    ));
    const saveFile = jest.fn(async () => 'https://files.test/whatsapp-templates/x.png');
    try {
      await withEnv({ META_APP_ID: 'app-test' }, async () => {
        await expect(prepareHeaderSample(withAccount, { format: 'DOCUMENT', source: 'estado_cuenta' }, { saveFile }))
          .resolves.toMatchObject({ handle: 'h-pdf', source: 'estado_cuenta', fileName: 'Estado de cuenta.pdf' });
        expect(saveFile).not.toHaveBeenCalled();
        const png = { mimetype: 'image/png', size: 1000, buffer: Buffer.from('x'), originalname: 'obra.png' };
        await expect(prepareHeaderSample(withAccount, { format: 'VIDEO', file: png }, { saveFile })).rejects.toThrow(/no corresponde/);
        await expect(prepareHeaderSample(withAccount, { format: 'IMAGE', file: png }, { saveFile }))
          .resolves.toMatchObject({ handle: 'h-pdf', source: 'file', fileUrl: 'https://files.test/whatsapp-templates/x.png' });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('The samples for Meta look like the project, never like a buyer', () => {
  beforeAll(async () => { await connectDB(); });

  it('takes a property, a typical quota and balance, and the next allowed payment day of the project', async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const companyId = new mongoose.Types.ObjectId();
    const company = { _id: companyId, tenantId, name: 'Torres del Parque', propertyType: 'apartamentos', paymentPlanPolicy: { allowedPaymentDays: [10] } };
    const contractId = new mongoose.Types.ObjectId();
    await Lot.collection.insertOne({ tenantId, companyId, lotNumber: '301', propertyType: 'apartamentos', isDeleted: false, createdAt: new Date() });
    await Contract.collection.insertOne({ _id: contractId, tenantId, companyId, totalValue: 200000000, createdAt: new Date() });
    await Quota.collection.insertMany([1, 2, 3].map((n) => ({ tenantId, companyId, contract: contractId, type: 'normal', number: n, value: 1999600, createdAt: new Date() })));
    try {
      const samples = await projectSamples(company);
      expect(samples.property).toBe('el apartamento 301');
      expect(samples.quota).toBe('$2.000.000');
      expect(samples.balance).toBe('$120.000.000');
      expect(samples.dueDate).toMatch(/^10\/\d{2}\/\d{4}$/);
      const fields = templateFieldsFor(company, samples);
      expect(fields.find((f) => f.key === 'nombre_comprador').example).toBe('Laura Gómez');
      expect(fields.find((f) => f.key === 'inmueble').example).toBe('el apartamento 301');
    } finally {
      await Promise.all([Lot, Contract, Quota].map((M) => M.collection.deleteMany({ companyId })));
    }
  });

  it('a project without data keeps the generic samples', async () => {
    const samples = await projectSamples({ _id: new mongoose.Types.ObjectId(), tenantId: new mongoose.Types.ObjectId() });
    expect(templateFieldsFor({ name: 'X' }, samples).find((f) => f.key === 'inmueble').example).toBe('el lote 12 de la manzana B');
    expect(samples.dueDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });
});
