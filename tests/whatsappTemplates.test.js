import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import Company from '../src/models/Company.js';
import Client from '../src/models/Client.js';
import VerificationToken from '../src/models/VerificationToken.js';
import { whatsappService } from '../src/services/whatsapp.service.js';
import {
  DEFAULT_TEMPLATES, companyWhatsAppAccount, ensureDefaultTemplates, sendCompanyNotice, publicLinkSuffix, propertyName,
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
      expect(bodyPart.text.trim().endsWith('}}')).toBe(false);
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

  it('names the property and cuts the signed link after /api/public/', () => {
    expect(propertyName({ lotNumber: '12', manzana: 'B' }, 'lotes')).toBe('el lote 12 de la manzana B');
    expect(propertyName({ lotNumber: '301', propertyType: 'apartamentos' })).toBe('el apartamento 301');
    expect(propertyName(null)).toBe('su inmueble');
    expect(publicLinkSuffix('https://api.test/api/public/statement/xyz?s=sig')).toBe('statement/xyz?s=sig');
  });
});
