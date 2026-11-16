import PaymentAttempt from '../models/PaymentAttempt.js';
import TemplateMedia from '../models/TemplateMedia.js';
import { whatsappService } from './whatsapp.service.js';
import { companyWhatsAppAccount, money, propertyName, shortDate, TEMPLATE_FIELDS } from './whatsappTemplates.service.js';
import { publicLinkUrl } from '../utils/publicLinks.js';

const FIELD_KEYS = new Set(TEMPLATE_FIELDS.map((f) => f.key));
const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;

const variablesOf = (text) => [...String(text || '').matchAll(VARIABLE)].map((m) => m[1]);

/**
 * Whether a send can use an approved template, and what it needs. Operix fills the named data of
 * «Insertar dato» ({{nombre_comprador}}…), a text header without data and a media header whose
 * file it keeps (TemplateMedia). Returns { usable, reason, variables, media }.
 */
export const analyzeTemplate = (template, mediaByKey = new Map()) => {
  const components = template.components || [];
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');
  const buttons = components.find((c) => c.type === 'BUTTONS')?.buttons || [];
  const variables = [...new Set(variablesOf(body?.text))];
  const result = { usable: false, reason: null, variables, media: null };

  if (template.status !== 'APPROVED') return { ...result, reason: 'Todavía no está aprobada por Meta.' };
  if (template.category === 'AUTHENTICATION') return { ...result, reason: 'Las plantillas de autenticación son solo para códigos.' };
  if (components.some((c) => !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(c.type))) return { ...result, reason: 'Tiene partes que Operix no sabe llenar (carrusel u oferta).' };
  if (header && !['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format)) return { ...result, reason: 'El encabezado es de un tipo que Operix no sabe llenar.' };
  if (String(template.name).startsWith('operix_')) return { ...result, reason: 'Es un aviso automático de Operix.' };
  if (variables.some((v) => /^\d+$/.test(v))) return { ...result, reason: 'Usa datos numerados ({{1}}); Operix solo llena los de «Insertar dato».' };
  const unknown = variables.find((v) => !FIELD_KEYS.has(v));
  if (unknown) return { ...result, reason: `{{${unknown}}} no es un dato de Operix.` };
  if (header?.format === 'TEXT' && variablesOf(header.text).length) return { ...result, reason: 'El encabezado tiene datos variables.' };
  if (header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format)) {
    const media = mediaByKey.get(`${template.name}:${template.language}`);
    if (!media) return { ...result, reason: 'Falta el archivo del encabezado (créala de nuevo desde Plantillas).' };
    result.media = { format: media.format, source: media.source, fileUrl: media.fileUrl, fileName: media.fileName };
  }
  if (buttons.some((b) => b.type === 'URL' && /\{\{/.test(b.url || ''))) return { ...result, reason: 'Tiene un botón con un enlace variable.' };
  if (buttons.some((b) => ['OTP', 'COPY_CODE', 'FLOW', 'CATALOG', 'MPM'].includes(b.type))) return { ...result, reason: 'Tiene un botón que Operix no sabe llenar.' };
  return { ...result, usable: true };
};

/** The project's templates from Meta, each with whether a send can use it. */
export const campaignTemplates = async (company) => {
  const account = companyWhatsAppAccount(company);
  if (!account) return null;
  const [templates, media] = await Promise.all([
    whatsappService.getTemplates(account),
    TemplateMedia.find({ companyId: company._id }).lean(),
  ]);
  const mediaByKey = new Map(media.map((m) => [`${m.name}:${m.language}`, m]));
  return templates.map((template) => {
    const components = template.components || [];
    return {
      name: template.name,
      language: template.language,
      category: template.category,
      status: template.status,
      header: components.find((c) => c.type === 'HEADER') || null,
      body: components.find((c) => c.type === 'BODY')?.text || '',
      footer: components.find((c) => c.type === 'FOOTER')?.text || '',
      buttons: components.find((c) => c.type === 'BUTTONS')?.buttons || [],
      ...analyzeTemplate(template, mediaByKey),
    };
  });
};

/** Last approved payment of each client: Map clientId → { amount, receiptUrl } */
export const lastPayments = async ({ tenantId, companyId, clientIds }) => {
  if (!clientIds.length) return new Map();
  const rows = await PaymentAttempt.aggregate([
    { $match: { tenantId, companyId, status: 'APROBADO', clientId: { $in: clientIds } } },
    { $sort: { fechaPago: -1, createdAt: -1 } },
    { $group: { _id: '$clientId', amount: { $first: '$amount' }, id: { $first: '$_id' }, receiptNumber: { $first: '$receiptNumber' } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row]));
};

// Meta rejects empty parameters
const filled = (value) => (value === undefined || value === null || String(value).trim() === '' ? '-' : String(value));

/** The value of each Operix datum for one buyer and their main contract. */
export const recipientValues = ({ company, client, contract, summary, lastPayment }) => {
  const next = summary?.nextQuota;
  return {
    nombre_comprador: filled(client?.name),
    inmueble: filled(propertyName(contract?.lot, company?.propertyType)),
    valor_cuota: filled(next ? money(next.pending) : null),
    fecha_vencimiento: filled(next?.dueDate ? shortDate(next.dueDate) : null),
    numero_cuota: filled(next?.number),
    dias_mora: filled(summary?.daysOverdue ?? 0),
    saldo_pendiente: filled(money(summary?.balance || 0)),
    valor_ultimo_pago: filled(lastPayment ? money(lastPayment.amount) : null),
    nombre_proyecto: filled(company?.name),
    telefono_proyecto: filled(company?.phone),
  };
};

const MEDIA_TYPE = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' };

/** Link of the file a media header attaches for this buyer, or null when there is none. */
const mediaLink = (media, { contract, lastPayment, apiUrl }) => {
  if (media.source === 'file') return media.fileUrl || null;
  if (media.source === 'estado_cuenta' || media.source === 'plan_pagos') return contract ? publicLinkUrl('statement', contract._id, apiUrl) : null;
  if (media.source === 'recibo') return lastPayment ? publicLinkUrl('receipt-attempt', lastPayment.id, apiUrl) : null;
  return null;
};

/**
 * Meta's send components for a template: the media header and the named body data.
 * Throws when the buyer lacks the document the header attaches (no payment for a receipt).
 */
export const sendComponents = (template, values, ctx = {}) => {
  const components = [];
  if (template.media) {
    const link = mediaLink(template.media, ctx);
    if (!link) throw new Error('El comprador no tiene el documento que adjunta la plantilla.');
    const type = MEDIA_TYPE[template.media.format];
    const asset = { link };
    if (type === 'document') asset.filename = template.media.fileName || 'Documento.pdf';
    components.push({ type: 'header', parameters: [{ type, [type]: asset }] });
  }
  if (template.variables?.length) {
    components.push({
      type: 'body',
      parameters: template.variables.map((key) => ({ type: 'text', parameter_name: key, text: values[key] })),
    });
  }
  return components;
};

/** The body with the buyer's data in place, for the preview. */
export const renderBody = (body, values) => String(body || '').replace(VARIABLE, (match, key) => values[key] ?? match);
