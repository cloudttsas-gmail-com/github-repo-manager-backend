import PDFDocument from 'pdfkit';
import { GRAPH_API_URL } from '../config/meta.js';
import { whatsappService } from './whatsapp.service.js';

/**
 * WhatsApp notices of each company to its buyers.
 * Every company sends from its own number and its own WhatsApp Business account (WABA),
 * with templates that live in that account. Without a connected number nothing goes out by
 * WhatsApp (the email of each notice still does). Texts approved by Sebastián on 11 Nov 2026
 * (planes/2026-11-11-plantillas-meta-textos.md).
 */

const LANGUAGE = 'es';
const FOOTER_MAX = 60;

/**
 * The account a company sends from: its own connection, or (development only) the server
 * account for the project slugs listed in WHATSAPP_SERVER_ACCOUNT_SLUGS.
 */
export const companyWhatsAppAccount = (company) => {
  const integrations = company?.integrations || {};
  if (integrations.whatsappConnectedAt && integrations.whatsappAccessToken && integrations.whatsappPhoneId) {
    return {
      accessToken: integrations.whatsappAccessToken,
      phoneNumberId: integrations.whatsappPhoneId,
      wabaId: integrations.whatsappWabaId,
      own: true,
    };
  }
  const allowed = (process.env.WHATSAPP_SERVER_ACCOUNT_SLUGS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (company?.slug && allowed.includes(company.slug) && process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    return {
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      wabaId: process.env.WHATSAPP_WABA_ID,
      own: false,
    };
  }
  return null;
};

const frontendUrl = () => (process.env.FRONTEND_URL || 'http://localhost:3002').replace(/\/$/, '');
const apiUrl = () => (process.env.API_URL || '').replace(/\/$/, '');
const publicApiBase = () => `${apiUrl()}/api/public/`;
const publicPageBase = () => `${frontendUrl()}/p/`;

const body = (text, example) => ({ type: 'BODY', text, example: { body_text: [example] } });
const footer = (companyName) => ({ type: 'FOOTER', text: String(companyName || 'Operix').slice(0, FOOTER_MAX) });
const documentHeader = (handle) => ({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [handle] } });
const urlButton = (text, base, exampleSuffix) => ({ type: 'URL', text, url: `${base}{{1}}`, example: [`${base}${exampleSuffix}`] });

/** +57… for the call button; Colombian mobiles (10 digits) and landlines (60X + 7 digits) get the country code. */
export const internationalPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (/^57\d{10}$/.test(digits)) return `+${digits}`;
  if (/^3\d{9}$/.test(digits) || /^60\d{8}$/.test(digits)) return `+57${digits}`;
  return null;
};

const EXAMPLE = {
  client: 'Laura Gómez',
  company: 'Inmobiliaria Horizonte',
  property: 'el lote 12 de la manzana B',
  money: '$1.250.000',
  date: '15/03/2027',
};

/**
 * Templates Operix creates in each company's account. `documentHeader` ones carry a PDF.
 * Variables are positional; the send side (NOTICES) fills them in the same order.
 */
export const DEFAULT_TEMPLATES = {
  operix_codigo: {
    category: 'AUTHENTICATION',
    components: () => [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 15 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copiar código' }] },
    ],
  },
  operix_bienvenida: {
    category: 'UTILITY',
    // Tied to the purchase, without a welcome header or thanks: Meta took that version for marketing
    components: ({ companyName }) => [
      body(
        'Hola {{1}}, {{2}} registró la compra de {{3}} a su nombre.\n\nPor este WhatsApp recibirá su plan de pagos, los recibos de cada pago y los avisos de sus cuotas. Puede consultar su estado de cuenta con su número de documento y un código que le llegará aquí.',
        [EXAMPLE.client, EXAMPLE.company, EXAMPLE.property],
      ),
      footer(companyName),
      { type: 'BUTTONS', buttons: [urlButton('Consultar mi estado de cuenta', publicPageBase(), 'inmobiliaria-horizonte/statement')] },
    ],
  },
  operix_validar_datos: {
    category: 'UTILITY',
    components: ({ companyName }) => [
      body(
        'Hola {{1}}, {{2}} le pide confirmar sus datos de contacto para enviarle recibos y avisos de {{3}}.\n\nSolo toma un minuto.',
        [EXAMPLE.client, EXAMPLE.company, EXAMPLE.property],
      ),
      footer(companyName),
      { type: 'BUTTONS', buttons: [urlButton('Confirmar mis datos', publicPageBase(), 'inmobiliaria-horizonte/validate-client?token=ejemplo')] },
    ],
  },
  operix_plan_pagos: {
    category: 'UTILITY',
    documentHeader: true,
    components: ({ companyName, handle }) => [
      documentHeader(handle),
      body(
        'Hola {{1}}, le compartimos el plan de pagos de {{2}} con {{3}}: {{4}} cuotas, la primera el {{5}}.\n\nGuarde este documento para consultar las fechas y los valores de cada cuota.',
        [EXAMPLE.client, EXAMPLE.property, EXAMPLE.company, '24', EXAMPLE.date],
      ),
      footer(companyName),
      { type: 'BUTTONS', buttons: [urlButton('Ver mi estado de cuenta', publicApiBase(), 'statement/ejemplo')] },
    ],
  },
  operix_plan_actualizado: {
    category: 'UTILITY',
    documentHeader: true,
    components: ({ companyName, handle }) => [
      documentHeader(handle),
      body(
        'Hola {{1}}, {{2}} actualizó el plan de pagos de {{3}}. Motivo: {{4}}.\n\nDesde la cuota {{5}} rigen las fechas y los valores del documento adjunto.',
        [EXAMPLE.client, EXAMPLE.company, EXAMPLE.property, 'cambio del día de pago', '3'],
      ),
      footer(companyName),
    ],
  },
  operix_cuota_por_vencer: {
    category: 'UTILITY',
    components: ({ companyName }) => [
      body(
        'Hola {{1}}, le recordamos que la cuota {{2}} de {{3}} por {{4}} vence el {{5}}.\n\nSi ya pagó, no tiene que hacer nada; recibirá su recibo cuando {{6}} confirme el pago.',
        [EXAMPLE.client, '5', EXAMPLE.property, EXAMPLE.money, EXAMPLE.date, EXAMPLE.company],
      ),
      footer(companyName),
      {
        type: 'BUTTONS',
        buttons: [
          urlButton('Pagar o reportar un pago', publicPageBase(), 'inmobiliaria-horizonte/payments'),
          { type: 'QUICK_REPLY', text: 'Ya pagué' },
        ],
      },
    ],
  },
  operix_cuota_vencida: {
    category: 'UTILITY',
    components: ({ companyName, companyPhone }) => [
      body(
        'Hola {{1}}, la cuota {{2}} de {{3}} venció el {{4}} y tiene un saldo pendiente de {{5}}.\n\nSi ya realizó el pago, por favor repórtelo para registrarlo. Si necesita un acuerdo, puede comunicarse con {{6}} por este mismo chat.',
        [EXAMPLE.client, '5', EXAMPLE.property, EXAMPLE.date, EXAMPLE.money, EXAMPLE.company],
      ),
      footer(companyName),
      {
        type: 'BUTTONS',
        buttons: [
          urlButton('Pagar o reportar un pago', publicPageBase(), 'inmobiliaria-horizonte/payments'),
          // The call button needs a fixed number: only when the project has one
          ...(internationalPhone(companyPhone) ? [{ type: 'PHONE_NUMBER', text: 'Llamar a cartera', phone_number: internationalPhone(companyPhone) }] : []),
        ],
      },
    ],
  },
  operix_pago_recibido: {
    category: 'UTILITY',
    documentHeader: true,
    components: ({ companyName, handle }) => [
      documentHeader(handle),
      body(
        'Hola {{1}}, {{2}} confirmó su pago de {{3}} del {{4}} para {{5}}.\n\nAdjuntamos el recibo n.º {{6}}. Gracias por su pago.',
        [EXAMPLE.client, EXAMPLE.company, EXAMPLE.money, EXAMPLE.date, EXAMPLE.property, '1024'],
      ),
      footer(companyName),
      { type: 'BUTTONS', buttons: [urlButton('Ver mi estado de cuenta', publicApiBase(), 'statement/ejemplo')] },
    ],
  },
  operix_pago_rechazado: {
    category: 'UTILITY',
    components: ({ companyName }) => [
      body(
        'Hola {{1}}, {{2}} no pudo aprobar el pago de {{3}} que reportó el {{4}}. Motivo: {{5}}.\n\nPuede reportarlo de nuevo con el comprobante correcto.',
        [EXAMPLE.client, EXAMPLE.company, EXAMPLE.money, EXAMPLE.date, 'el comprobante no es legible'],
      ),
      footer(companyName),
      { type: 'BUTTONS', buttons: [urlButton('Reportar el pago de nuevo', publicPageBase(), 'inmobiliaria-horizonte/payments')] },
    ],
  },
  operix_estado_cuenta: {
    category: 'UTILITY',
    documentHeader: true,
    components: ({ companyName, handle }) => [
      documentHeader(handle),
      body(
        'Hola {{1}}, este es su estado de cuenta de {{2}} con {{3}} al {{4}}: ha pagado {{5}} y su saldo es {{6}}.\n\nSu próxima cuota vence el {{7}}. En el documento adjunto está el detalle de cada cuota y de cada pago.',
        [EXAMPLE.client, EXAMPLE.property, EXAMPLE.company, EXAMPLE.date, '$9.000.000', '$21.000.000', EXAMPLE.date],
      ),
      footer(companyName),
      { type: 'BUTTONS', buttons: [urlButton('Ver detalle', publicApiBase(), 'statement/ejemplo')] },
    ],
  },
};

/** A one-page sample PDF: Meta asks for an example document to review templates with a document header. */
const samplePdf = () => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
  doc.fontSize(18).text('Documento de ejemplo', { align: 'center' });
  doc.moveDown().fontSize(12).text('Ejemplo de recibo, plan de pagos o estado de cuenta que la inmobiliaria envía a su comprador.');
  doc.end();
});

/**
 * Uploads the sample PDF with Meta's Resumable Upload API and returns its handle.
 */
const uploadSampleDocument = async (accessToken) => {
  const appId = process.env.META_APP_ID;
  if (!appId) throw new Error('META_APP_ID es requerido para crear plantillas con documento');
  const file = await samplePdf();
  const sessionRes = await fetch(`${GRAPH_API_URL}/${appId}/uploads?${new URLSearchParams({
    file_name: 'ejemplo.pdf', file_length: String(file.length), file_type: 'application/pdf', access_token: accessToken,
  }).toString()}`, { method: 'POST' });
  const session = await sessionRes.json();
  if (!sessionRes.ok || !session.id) throw new Error(session.error?.message || 'Meta no abrió la carga del documento de ejemplo');
  const uploadRes = await fetch(`${GRAPH_API_URL}/${session.id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${accessToken}`, file_offset: '0' },
    body: file,
  });
  const uploaded = await uploadRes.json();
  if (!uploadRes.ok || !uploaded.h) throw new Error(uploaded.error?.message || 'Meta no recibió el documento de ejemplo');
  return uploaded.h;
};

/**
 * Creates in the company's account the default templates it does not have yet.
 * Returns one row per template: created, existing (with its Meta status) or the error.
 */
export const ensureDefaultTemplates = async (company) => {
  const account = companyWhatsAppAccount(company);
  if (!account) throw new Error('El proyecto no tiene un número de WhatsApp conectado');

  const existing = await whatsappService.getTemplates(account);
  const byName = new Map(existing.filter((t) => t.language === LANGUAGE).map((t) => [t.name, t]));
  const missing = Object.keys(DEFAULT_TEMPLATES).filter((name) => !byName.has(name));

  let handle = null;
  const rejected = Object.keys(DEFAULT_TEMPLATES).filter((name) => byName.get(name)?.status === 'REJECTED');
  if ([...missing, ...rejected].some((name) => DEFAULT_TEMPLATES[name].documentHeader)) {
    handle = await uploadSampleDocument(account.accessToken);
  }

  const context = { companyName: company.name, companyPhone: company.phone, handle };
  const results = [];
  for (const name of Object.keys(DEFAULT_TEMPLATES)) {
    const definition = DEFAULT_TEMPLATES[name];
    const current = byName.get(name);
    if (current?.status === 'REJECTED' && current.id) {
      // A rejected default gets the current text and goes back to review
      try {
        await whatsappService.editTemplate(account, current.id, { category: definition.category, components: definition.components(context) });
        results.push({ name, result: 'resubmitted', status: 'PENDING' });
      } catch (error) {
        results.push({ name, result: 'error', status: 'REJECTED', error: error.message });
      }
      continue;
    }
    if (current) {
      results.push({ name, result: 'existing', status: current.status });
      continue;
    }
    try {
      const created = await whatsappService.createTemplate(account, {
        name, language: LANGUAGE, category: definition.category, components: definition.components(context),
      });
      results.push({ name, result: 'created', status: created.status || 'PENDING' });
    } catch (error) {
      results.push({ name, result: 'error', error: error.message });
    }
  }
  return results;
};

// ---------------------------------------------------------------- sending

const text = (value) => ({ type: 'text', text: String(value ?? '').trim() || '-' });
const bodyParams = (values) => ({ type: 'body', parameters: values.map(text) });
const urlParam = (suffix, index = 0) => ({ type: 'button', sub_type: 'url', index: String(index), parameters: [text(suffix)] });
const documentParam = (link, filename) => ({ type: 'header', parameters: [{ type: 'document', document: { link, filename } }] });

/** Part of a signed public link after /api/public/, which is what the URL button adds. */
export const publicLinkSuffix = (url) => {
  const marker = '/api/public/';
  const at = String(url || '').indexOf(marker);
  return at >= 0 ? url.slice(at + marker.length) : '';
};

/** Part of a public page link after /p/. */
export const publicPageSuffix = (url) => {
  const marker = '/p/';
  const at = String(url || '').indexOf(marker);
  return at >= 0 ? url.slice(at + marker.length) : '';
};

/** Send parameters of each notice, in the order of its template. */
const NOTICES = {
  codigo: (v) => [bodyParams([v.code]), urlParam(v.code)],
  bienvenida: (v) => [bodyParams([v.clientName, v.companyName, v.property]), urlParam(`${v.slug}/statement`)],
  validar_datos: (v) => [bodyParams([v.clientName, v.companyName, v.property]), urlParam(publicPageSuffix(v.validationUrl))],
  pago_recibido: (v) => [
    documentParam(v.receiptUrl, `Recibo${v.receiptNumber ? ` ${v.receiptNumber}` : ''}.pdf`),
    bodyParams([v.clientName, v.companyName, v.amount, v.date, v.property, v.receiptNumber]),
    urlParam(publicLinkSuffix(v.statementUrl)),
  ],
  estado_cuenta: (v) => [
    documentParam(v.statementUrl, 'Estado de cuenta.pdf'),
    bodyParams([v.clientName, v.property, v.companyName, v.date, v.paid, v.balance, v.nextDue]),
    urlParam(publicLinkSuffix(v.statementUrl)),
  ],
};

/**
 * Sends a notice to a buyer from the company's own number with its approved template.
 * Same result shape as sendWhatsApp: { success, provider, error } and never throws.
 */
export const sendCompanyNotice = async ({ company, to, notice, values }) => {
  if (process.env.ENABLE_NOTIFICATIONS !== 'true') {
    console.log(`[WHATSAPP DISABLED] Would have sent the ${notice} notice of ${company?.name || 'a company'}`);
    return { success: true, provider: 'disabled' };
  }
  const account = companyWhatsAppAccount(company);
  if (!account) {
    return { success: false, provider: 'none', error: 'El proyecto no tiene un número de WhatsApp conectado' };
  }
  try {
    const data = await whatsappService.sendTemplateMessage(account, to, `operix_${notice}`, LANGUAGE, NOTICES[notice](values));
    return { success: true, provider: 'meta', data };
  } catch (error) {
    console.error(`[WHATSAPP NOTICE] ${notice} was not sent:`, error.message);
    return { success: false, provider: 'meta', error: error.message };
  }
};

// ---------------------------------------------------------------- formatting

export const money = (value) => `$${Number(value || 0).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;

export const shortDate = (date) => (date
  ? new Date(date).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' })
  : '-');

const PROPERTY_NOUNS = { lotes: 'el lote', casas: 'la casa', apartamentos: 'el apartamento', locales: 'el local' };

/** «el lote 12 de la manzana B», or «su inmueble» when the lot is unknown. */
export const propertyName = (lot, propertyType) => {
  if (!lot?.lotNumber) return 'su inmueble';
  const noun = PROPERTY_NOUNS[lot.propertyType || propertyType] || 'el inmueble';
  return `${noun} ${lot.lotNumber}${lot.manzana ? ` de la manzana ${lot.manzana}` : ''}`;
};
