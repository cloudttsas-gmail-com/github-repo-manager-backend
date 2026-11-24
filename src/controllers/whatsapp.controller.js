import mongoose from 'mongoose';
import { whatsappService } from '../services/whatsapp.service.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import {
  companyWhatsAppAccount, ensureDefaultTemplates, buildCompanyTemplate, buildTemplateEdit, templateFieldsFor,
  prepareHeaderSample, DOCUMENT_SOURCES, projectSamples,
} from '../services/whatsappTemplates.service.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Client from '../models/Client.js';
import Company from '../models/Company.js';
import TemplateMedia from '../models/TemplateMedia.js';
import { PERMISSIONS, hasPermission } from '../config/permissions.js';
import { uploadToR2, deleteFromR2 } from '../utils/storage.js';
import AppError from '../utils/AppError.js';
import { GRAPH_API_URL, GRAPH_API_VERSION } from '../config/meta.js';
import crypto from 'crypto';

/**
 * The active project (`?companyId=`, checked by companyMiddleware) owns the WhatsApp number:
 * a tenant with several projects has one number per project.
 */
const activeCompany = (req) => Company.findOne({ _id: req.user.companyId, tenantId: req.user.tenantId });

// Each project sends and keeps its templates in its own WhatsApp account, never in Operix's
const NOT_CONNECTED = 'Conecta el número de WhatsApp del proyecto en Configuración › Integraciones.';
const accountOf = async (req) => companyWhatsAppAccount(await activeCompany(req));

/**
 * Meta Webhook Verification
 * Answers the challenge as plain text when the verify token matches. Never logs the tokens.
 */
export const verifyWebhook = (req, res) => {
  // Read the raw query string: express-mongo-sanitize drops keys with dots, like hub.mode, from req.query.
  const params = new URLSearchParams(req.originalUrl.split('?')[1] || '');
  const mode = params.get('hub.mode') || params.get('hub_mode');
  const token = params.get('hub.verify_token') || params.get('hub_verify_token');
  const challenge = params.get('hub.challenge') || params.get('hub_challenge');

  if (!mode || !token) {
    return res.status(400).send('Verification failed');
  }
  if (mode === 'subscribe' && isSameSecret(token, process.env.WHATSAPP_VERIFY_TOKEN)) {
    console.log('[WHATSAPP WEBHOOK] verified');
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }
  // Lengths only, never the values: tells a missing or mistyped variable apart from a wrong token.
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  console.warn(`[WHATSAPP WEBHOOK] verification failed: WHATSAPP_VERIFY_TOKEN ${expected ? `set (${expected.length} chars)` : 'NOT set'}, received ${String(token).length} chars, mode ${mode}`);
  return res.sendStatus(403);
};

/** Constant-time comparison; false when either value is missing. */
const isSameSecret = (received, expected) => {
  if (!received || !expected) return false;
  const a = Buffer.from(String(received));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * True when X-Hub-Signature-256 is the HMAC-SHA256 of the raw body with the app secret.
 * Exported for tests.
 */
export const hasValidSignature = (req) => {
  const secret = process.env.META_APP_SECRET;
  const header = req.get('x-hub-signature-256') || '';
  if (!secret || !req.rawBody || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return isSameSecret(header, expected);
};

/**
 * Meta Webhook events (messages and statuses).
 * Rejects unsigned calls, answers 200 right away and processes the event afterwards.
 */
export const handleWebhook = async (req, res) => {
  if (!hasValidSignature(req)) {
    console.warn('[WHATSAPP WEBHOOK] rejected: missing or invalid signature');
    return res.sendStatus(401);
  }
  if (!req.body?.object) {
    return res.sendStatus(404);
  }

  res.status(200).send('EVENT_RECEIVED');
  processWebhookEvent(req.body).catch((error) => {
    console.error('[WHATSAPP WEBHOOK] processing error:', error.message);
  });
};

// Meta may group several events in one call: every entry and change is processed
const processWebhookEvent = async (body) => {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change?.value) await processWebhookChange(change.value);
    }
  }
};

const processWebhookChange = async (value) => {
  // Meta may group several messages of one buyer in a change («hola» and then «BAJA»): each one counts
  for (const messageData of value.messages || []) {
    await processInboundMessage(value, messageData);
  }

  // Status updates (sent, delivered, read, failed)
  for (const status of value.statuses || []) {
    await Message.findOneAndUpdate({ waId: status.id }, { status: status.status });
    await recordCampaignStatus(status);
    console.log(`[WHATSAPP WEBHOOK] status ${status.status}`);
  }
};

const processInboundMessage = async (value, messageData) => {
  {
    const waId = messageData.from; // Phone number with country code, e.g. "573001234567"
    const phoneId = value.metadata?.phone_number_id;
    // Without a full number the pattern below would match every buyer of the project
    if (String(waId || '').replace(/\D/g, '').length < 10) {
      console.warn('[WHATSAPP WEBHOOK] message without a valid sender number');
      return;
    }

    // Find company by phone ID
    const company = await Company.findOne({ 'integrations.whatsappPhoneId': phoneId });
    if (!company) {
      console.warn('[WHATSAPP WEBHOOK] message for an unknown phone number ID');
      return;
    }
    const tenantId = company.tenantId;

    // Handle different message types
    let text = '';
    if (messageData.type === 'text') {
      text = messageData.text.body;
    } else if (messageData.type === 'button') {
      text = messageData.button.text;
    } else if (messageData.type === 'interactive') {
      const type = messageData.interactive.type;
      text = type === 'button_reply'
        ? messageData.interactive.button_reply.title
        : messageData.interactive.list_reply.title;
    } else {
      text = `[Mensaje tipo ${messageData.type}]`;
    }

    // Match the client by the last 10 digits, whatever separators the stored number has
    const phonePattern = phoneDigitsPattern(waId);
    const client = await Client.findOne({
      tenantId,
      companyId: company._id,
      phone: { $regex: phonePattern },
    });
    // A number that is not a buyer only has a chat if the team wrote to it first: its replies go there
    let conv = client
      ? await Conversation.findOne({ clientId: client._id })
      : await Conversation.findOne({ tenantId: String(tenantId), companyId: company._id, waId: whatsappService.formatPhoneNumber(waId) });
    if (!client && !conv) {
      console.warn('[WHATSAPP WEBHOOK] message from a number with no client and no chat');
      return;
    }
    if (!conv) {
      conv = await Conversation.create({
        tenantId: client.tenantId,
        companyId: company._id,
        clientId: client._id,
        waId: waId,
        lastMessage: text,
      });
    } else {
      conv.lastMessage = text;
      conv.unreadCount += 1;
      conv.updatedAt = new Date();
      await conv.save();
    }

    await Message.create({
      conversationId: conv._id,
      tenantId: String(tenantId),
      waId: messageData.id,
      direction: 'inbound',
      type: messageData.type === 'text' ? 'text' : 'button',
      body: text,
      status: 'received',
    });
    console.log(`[WHATSAPP WEBHOOK] inbound ${messageData.type} message stored`);
    if (client) await recordCampaignReply({ tenantId, companyId: company._id, phonePattern }, text);
  }
};

/** Regex for the last 10 digits of a number, allowing spaces, dashes or dots between them as stored. */
export const phoneDigitsPattern = (number) => String(number || '').replace(/\D/g, '').slice(-10).split('').join('\\D*');

const REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// A short reply asking to stop opts the buyer out: «BAJA», «Baja por favor», «darme de baja», «STOP»…
const OPT_OUT_KEYWORDS = new Set(['baja', 'stop', 'parar']);
// Words that may come with the keyword: «Baja por favor», «quiero la baja», «darme de baja ya»
const OPT_OUT_COURTESY = new Set(['por', 'favor', 'porfa', 'porfavor', 'gracias', 'quiero', 'solicito', 'pido', 'la', 'de', 'me', 'dar', 'darme', 'deme', 'dame', 'denme', 'dan', 'den', 'ya', 'una', 'el', 'a', 'y', 'ok', 'buenas', 'hola']);
// «Deme de baja», «me dan de baja», «no me envíen más mensajes», «no quiero que me escriban», «no enviar más mensajes»
const OPT_OUT_PHRASE = /((dar|de|da|den)me de baja|me (dan|den|da|dar) de baja|cancelar suscripci[oó]n|no (quiero|deseo) (recibir )?(m[aá]s )?mensajes|no (quiero|deseo) que me (escriban|env[ií]en)|no me (escriban|env[ií]en)|no (enviar|env[ií]en|manden|mandar) m[aá]s|no m[aá]s mensajes)/i;
export const isOptOut = (text) => {
  const clean = String(text || '').normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 60) return false;
  if (OPT_OUT_PHRASE.test(clean)) return true;
  const words = clean.toLowerCase().split(' ');
  return words.some((w) => OPT_OUT_KEYWORDS.has(w)) && words.every((w) => OPT_OUT_KEYWORDS.has(w) || OPT_OUT_COURTESY.has(w));
};

/**
 * A buyer answered: the send that reached them in the last week gets the reply, and an opt-out
 * applies to every buyer of the project with that number (a couple may share one).
 */
const recordCampaignReply = async ({ tenantId, companyId, phonePattern }, text) => {
  const optOut = isOptOut(text);
  const now = new Date();
  const clients = await Client.find({ tenantId, companyId, phone: { $regex: phonePattern } }).select('_id contactConsent').lean();
  if (!clients.length) return;
  const ids = clients.map((c) => c._id);
  const latest = await CampaignRecipient.findOne({ clientId: { $in: ids }, sentAt: { $gte: new Date(now.getTime() - REPLY_WINDOW_MS) } }).sort({ sentAt: -1 });
  if (latest) {
    if (!latest.repliedAt) latest.repliedAt = now;
    if (optOut && !latest.optedOutAt) latest.optedOutAt = now;
    await latest.save();
  }
  if (optOut) {
    const { modifiedCount } = await Client.updateMany(
      { _id: { $in: ids }, 'contactConsent.status': { $ne: 'baja' } },
      { contactConsent: { status: 'baja', updatedAt: now, source: 'whatsapp' } },
    );
    if (modifiedCount) console.log('[WHATSAPP WEBHOOK] buyers opted out of messages:', modifiedCount);
  }
};

// Later states never step back (a late «delivered» after «read»)
const STATUS_ORDER = { sent: 1, delivered: 2, read: 3 };

/** Meta's delivery report for a message of a send. */
const recordCampaignStatus = async (status) => {
  const at = status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date();
  if (status.status === 'failed') {
    const error = status.errors?.[0];
    // A failure report never undoes a read one (they can arrive out of order)
    await CampaignRecipient.updateOne({ waMessageId: status.id, status: { $ne: 'read' } }, {
      status: 'failed',
      error: error ? `${error.title || error.message || 'Error'}${error.code ? ` (${error.code})` : ''}` : 'Meta no entregó el mensaje',
    });
    return;
  }
  const rank = STATUS_ORDER[status.status];
  if (!rank || rank < 2) return;
  const earlier = Object.keys(STATUS_ORDER).filter((s) => STATUS_ORDER[s] < rank);
  const update = { status: status.status, [`${status.status}At`]: at };
  await CampaignRecipient.updateOne({ waMessageId: status.id, status: { $in: earlier } }, update);
  if (status.status === 'read') await CampaignRecipient.updateOne({ waMessageId: status.id, deliveredAt: null }, { deliveredAt: at });
};

/**
 * Send manual message to client
 */
export const sendMessage = async (req, res, next) => {
  try {
    // Same switch as the automatic notifications: environments with notifications off never send.
    if (process.env.ENABLE_NOTIFICATIONS !== 'true') {
      return next(new AppError('Los envíos de WhatsApp están apagados en este ambiente.', 503));
    }

    const { clientId, phone: directPhone, text, templateName, components, language } = req.body;
    const { tenantId, companyId, userId: senderId } = req.user;

    let client = null;
    let phone = directPhone;

    if (clientId) {
      client = await Client.findOne({ _id: clientId, tenantId, companyId });
      if (!client) return next(new AppError('Cliente no encontrado', 404));
      phone = client.whatsapp || client.phone;
    }

    if (!phone) return next(new AppError('Se requiere un número de teléfono o ID de cliente', 400));

    // If no client provided but we have phone, try to find one (by its last 10 digits, as stored)
    if (!client && String(phone).replace(/\D/g, '').length >= 10) {
      client = await Client.findOne({ tenantId, companyId, phone: { $regex: phoneDigitsPattern(phone) } });
    }

    // A buyer who asked not to be written to gets no templates; answering inside their own chat stays possible
    if (templateName && client?.contactConsent?.status === 'baja') {
      return next(new AppError('Este comprador pidió no recibir mensajes. Solo puedes responderle si te escribe.', 403));
    }

    const waConfig = await accountOf(req);
    if (!waConfig) return next(new AppError(NOT_CONNECTED, 400));

    let result;
    if (templateName) {
      // Templates exist per language; Spanish unless the caller names another one (e.g. hello_world is en_US).
      result = await whatsappService.sendTemplateMessage(waConfig, phone, templateName, language || 'es', components);
    } else {
      result = await whatsappService.sendTextMessage(waConfig, phone, text);
    }

    const waId = whatsappService.formatPhoneNumber(phone);

    // Update conversation and store message
    // The chat of this project's number: the same number may have another chat in another project
    let conv = await Conversation.findOne({ waId, tenantId, ...projectScope(companyId) });
    if (!conv) {
      conv = await Conversation.create({
        tenantId,
        companyId,
        clientId: client?._id,
        waId: waId,
        lastMessage: text || `Plantilla: ${templateName}`
      });
    } else {
      // Link client if not linked yet
      if (!conv.clientId && client?._id) {
        conv.clientId = client._id;
      }
      if (!conv.companyId) conv.companyId = companyId;
      conv.lastMessage = text || `Plantilla: ${templateName}`;
      await conv.save();
    }

    const message = await Message.create({
      conversationId: conv._id,
      tenantId,
      waId: result.messages?.[0]?.id,
      direction: 'outbound',
      type: templateName ? 'template' : 'text',
      body: text || `Enviado plantilla: ${templateName}`,
      senderId,
      status: 'sent'
    });

    res.status(200).json({ success: true, data: message });
  } catch (error) {
    next(error);
  }
};

/**
 * Get chat history
 */
// Conversations saved before they carried a project belong to every project, as in the list
const projectScope = (companyId) => ({ $or: [{ companyId }, { companyId: { $exists: false } }, { companyId: null }] });

/**
 * Messages of a chat, by buyer (`/history/:clientId`) or by conversation
 * (`/history/conversation/:conversationId`, for numbers that are not a buyer). Opening it marks it read.
 */
export const getChatHistory = async (req, res, next) => {
  try {
    const { clientId, conversationId } = req.params;
    const { tenantId, companyId } = req.user;
    const byId = conversationId || clientId;
    if (!mongoose.isValidObjectId(byId)) return res.status(200).json({ success: true, data: [] });

    const conv = await Conversation.findOne({
      tenantId,
      ...(conversationId ? { _id: conversationId } : { clientId }),
      ...projectScope(companyId),
    }).sort({ updatedAt: -1 });
    if (!conv) {
      return res.status(200).json({ success: true, data: [] });
    }

    if (conv.unreadCount) {
      conv.unreadCount = 0;
      await conv.save();
    }

    // The latest 100, oldest first
    const messages = await Message.find({ conversationId: conv._id, tenantId })
      .sort({ createdAt: -1 })
      .limit(100);

    res.status(200).json({ success: true, data: messages.reverse() });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all active conversations for the tenant
 */
export const getConversations = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;

    // Conversations saved before they carried a project show in every project, as before
    const conversations = await Conversation.find({ tenantId, ...projectScope(companyId) })
      .populate('clientId', 'name fullName email phone whatsapp')
      .sort({ updatedAt: -1 });

    res.status(200).json({ success: true, data: conversations });
  } catch (error) {
    next(error);
  }
};

export const getConfig = async (req, res, next) => {
  try {
    // Public values for the Embedded Signup popup; the app secret never leaves the server.
    res.status(200).json({
      success: true,
      data: {
        appId: process.env.META_APP_ID,
        configId: process.env.META_CONFIG_ID,
        graphApiVersion: GRAPH_API_VERSION,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getTemplates = async (req, res, next) => {
  try {
    const company = await activeCompany(req);
    const waConfig = companyWhatsAppAccount(company);
    if (!waConfig) return next(new AppError(NOT_CONNECTED, 400));
    const templates = await whatsappService.getTemplates(waConfig);
    // Senders get the approved ones; the templates page asks for all with their status
    let data = templates.filter((t) => t.status === 'APPROVED');
    if (req.query.all === 'true') {
      // What each media header attaches, so the edit form starts from it
      const media = await TemplateMedia.find({ companyId: company._id }).lean();
      data = templates.map((t) => {
        const own = media.find((m) => m.name === t.name && m.language === t.language);
        return own ? { ...t, headerMedia: { source: own.source, fileUrl: own.fileUrl, fileName: own.fileName } } : t;
      });
    }
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
/** The template's media header, or null when it has none or it is text */
const mediaHeaderOf = ({ components }) => (components || []).find((c) => c.type === 'HEADER' && c.format && c.format !== 'TEXT') || null;

/** Meta keeps only the sample of a media header: Operix keeps what to attach when sending */
const saveTemplateMedia = async (company, template, media) => {
  const header = mediaHeaderOf(template);
  if (!header || !media?.source) return;
  await TemplateMedia.findOneAndUpdate(
    { companyId: company._id, name: template.name, language: template.language },
    {
      tenantId: company.tenantId, format: header.format,
      source: media.source,
      // Only a file Operix stored itself (header-sample), never an outside link
      fileUrl: media.source === 'file' && String(media.fileUrl || '').startsWith(`${process.env.R2_PUBLIC_URL}/whatsapp-templates/`) ? media.fileUrl : undefined,
      fileName: String(media.fileName || '').slice(0, 120),
    },
    { upsert: true, runValidators: true },
  );
};

/**
 * Create a new template
 */
export const createTemplate = async (req, res, next) => {
  try {
    const company = await activeCompany(req);
    const waConfig = companyWhatsAppAccount(company);
    if (!waConfig) return next(new AppError(NOT_CONNECTED, 400));
    // Built here from the form fields, so only Operix data reaches Meta as variables
    const template = buildCompanyTemplate(company, req.body, templateFieldsFor(company, await projectSamples(company)));
    const result = await whatsappService.createTemplate(waConfig, template);
    await saveTemplateMedia(company, template, req.body.headerMedia);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

/**
 * Edit a template of the project's account; Meta reviews it again
 */
export const editTemplate = async (req, res, next) => {
  try {
    const company = await activeCompany(req);
    const waConfig = companyWhatsAppAccount(company);
    if (!waConfig) return next(new AppError(NOT_CONNECTED, 400));
    // Looked up in the project's own account: an id of another one is never edited
    const current = (await whatsappService.getTemplates(waConfig)).find((t) => String(t.id) === req.params.id);
    if (!current) return next(new AppError('Esta plantilla no existe en la cuenta del proyecto.', 404));
    // The automatic notices are configuration, as creating them is
    if (current.name.startsWith('operix_') && !hasPermission(req.user.role, PERMISSIONS.CONFIG_TENANT)) {
      return next(new AppError('Solo la administración puede editar las plantillas de los avisos.', 403));
    }
    const payload = await buildTemplateEdit(company, current, req.body, templateFieldsFor(company, await projectSamples(company)));
    const result = await whatsappService.editTemplate(waConfig, current.id, payload);

    if (!current.name.startsWith('operix_')) {
      const edited = { name: current.name, language: current.language, components: payload.components };
      const key = { companyId: company._id, name: current.name, language: current.language };
      const before = await TemplateMedia.findOne(key);
      if (mediaHeaderOf(edited)) await saveTemplateMedia(company, edited, req.body.headerMedia);
      else await TemplateMedia.deleteOne(key);
      // The previous file goes only when nothing uses it any more
      const after = await TemplateMedia.findOne(key);
      if (before?.fileUrl && before.fileUrl !== after?.fileUrl) await deleteFromR2(before.fileUrl).catch(() => null);
    }
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

/**
 * The data a template can insert, with this project's samples for Meta's review
 */
export const getTemplateFields = async (req, res, next) => {
  try {
    const company = await activeCompany(req);
    const fields = templateFieldsFor(company, await projectSamples(company));
    res.status(200).json({ success: true, data: fields, documentSources: DOCUMENT_SOURCES });
  } catch (error) {
    next(error);
  }
};

/**
 * Uploads the sample of a template's media header to Meta (and the company's file to
 * storage), before the template is created with that sample.
 */
export const prepareTemplateHeader = async (req, res, next) => {
  try {
    const sample = await prepareHeaderSample(
      await activeCompany(req),
      { format: req.body.format, source: req.body.source, file: req.file },
      { saveFile: (file) => uploadToR2(file, 'whatsapp-templates') },
    );
    res.status(200).json({ success: true, data: sample });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a template
 */
export const deleteTemplate = async (req, res, next) => {
  try {
    const { name } = req.params;
    const waConfig = await accountOf(req);
    if (!waConfig) return next(new AppError(NOT_CONNECTED, 400));
    const result = await whatsappService.deleteTemplate(waConfig, name);
    // Meta deletes every language of the name; its header file goes too
    const media = await TemplateMedia.find({ companyId: req.user.companyId, name });
    await Promise.all(media.filter((m) => m.fileUrl).map((m) => deleteFromR2(m.fileUrl).catch(() => null)));
    await TemplateMedia.deleteMany({ companyId: req.user.companyId, name });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

/**
 * Creates in the project's account the default templates it does not have yet
 * (for numbers connected before they existed, or after deleting one).
 */
export const createDefaultTemplates = async (req, res, next) => {
  try {
    const company = await activeCompany(req);
    if (!companyWhatsAppAccount(company)) return next(new AppError(NOT_CONNECTED, 400));
    const results = await ensureDefaultTemplates(company);
    res.status(200).json({ success: true, data: results });
  } catch (error) {
    next(error);
  }
};

export const connect = async (req, res, next) => {
  try {
    const { code, wabaId: passedWabaId, phoneNumberId: passedPhoneNumberId } = req.body;
    // Coexistence (the default) keeps the number in the WhatsApp Business app; cloud connects a new number
    const mode = req.body.mode === 'cloud' ? 'cloud' : 'coexistence';
    
    // The number is connected to the active project
    const company = await activeCompany(req);
    if (!company) return next(new AppError('Empresa no encontrada', 404));

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      return next(new AppError('META_APP_ID y META_APP_SECRET son requeridos en el servidor', 500));
    }

    let accessToken;
    const isAccessToken = code.startsWith('EA');
    if (isAccessToken) {
      accessToken = code;
    } else {
      const tokenRes = await fetch(
        `${GRAPH_API_URL}/oauth/access_token?${new URLSearchParams({
          client_id: appId,
          client_secret: appSecret,
          code,
        }).toString()}`
      );
      const tokenData = await tokenRes.json();
      if (tokenData.error) {
        return next(new AppError(`Error de autenticación: ${tokenData.error.message}`, 400));
      }
      accessToken = tokenData.access_token;
    }

    let wabaId = passedWabaId || '';
    let phoneNumberId = passedPhoneNumberId || '';
    let displayPhoneNumber = '';
    let verifiedName = '';

    // Simplified Fallback logic
    if (!wabaId || !phoneNumberId || wabaId === phoneNumberId) {
      try {
        const debugRes = await fetch(`${GRAPH_API_URL}/debug_token?input_token=${accessToken}&access_token=${appId}|${appSecret}`);
        const debugData = await debugRes.json();
        if (debugData.data?.granular_scopes) {
          for (const scope of debugData.data.granular_scopes) {
            if (scope.scope === 'whatsapp_business_management' && scope.target_ids?.length) {
              wabaId = scope.target_ids[0];
            }
            if (scope.scope === 'whatsapp_business_messaging' && scope.target_ids?.length) {
              phoneNumberId = scope.target_ids[0];
            }
          }
        }
      } catch (err) {}
    }

    if (!wabaId || !phoneNumberId || wabaId === phoneNumberId) {
       try {
         const wabaRes = await fetch(`${GRAPH_API_URL}/me?fields=whatsapp_business_accounts`, { headers: { Authorization: `Bearer ${accessToken}` } });
         const wabaData = await wabaRes.json();
         const accounts = wabaData.whatsapp_business_accounts?.data || wabaData.data;
         if (accounts && accounts.length > 0) {
           if (!wabaId || wabaId === phoneNumberId) wabaId = accounts[0].id;
           const phoneRes = await fetch(`${GRAPH_API_URL}/${wabaId}/phone_numbers?fields=display_phone_number,verified_name,id`, { headers: { Authorization: `Bearer ${accessToken}` } });
           const phoneData = await phoneRes.json();
           if (phoneData.data && phoneData.data.length > 0) {
             phoneNumberId = phoneData.data[0].id;
           }
         }
       } catch (err) {}
    }

    if (phoneNumberId) {
      try {
        const phoneRes = await fetch(`${GRAPH_API_URL}/${phoneNumberId}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${accessToken}` } });
        const phoneData = await phoneRes.json();
        if (phoneData.display_phone_number) {
          displayPhoneNumber = phoneData.display_phone_number;
          verifiedName = phoneData.verified_name || '';
        }
      } catch (err) {}
    }

    if (!wabaId || !phoneNumberId) {
      return next(new AppError('No se pudo identificar tu cuenta o número de WhatsApp.', 400));
    }

    // Subscribe to webhooks
    try {
      await fetch(`${GRAPH_API_URL}/${wabaId}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
    } catch(err) {}

    // A new number has to be registered on the Cloud API, with a two-step verification PIN;
    // a coexistence number is already registered by the WhatsApp Business app
    let pin;
    if (mode === 'cloud') {
      pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const registerRes = await fetch(`${GRAPH_API_URL}/${phoneNumberId}/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
      });
      const registerData = await registerRes.json().catch(() => ({}));
      if (!registerRes.ok || registerData.error) {
        return next(new AppError(`Meta no registró el número: ${registerData.error?.message || 'error desconocido'}`, 502));
      }
    }

    company.integrations = {
      ...(company.integrations || {}),
      whatsappEnabled: true,
      whatsappWabaId: wabaId,
      whatsappPhoneId: phoneNumberId,
      whatsappAccessToken: accessToken,
      whatsappDisplayPhone: displayPhoneNumber,
      whatsappVerifiedName: verifiedName,
      whatsappConnectionMode: mode,
      whatsappPin: pin,
      whatsappConnectedAt: new Date(),
    };
    await company.save();

    // The notices need their templates in the new account; Meta reviews them (up to 24 hours)
    let templates = [];
    try {
      templates = await ensureDefaultTemplates(company);
    } catch (templateError) {
      console.error('[WHATSAPP CONNECT] Default templates not created:', templateError.message);
      templates = [{ result: 'error', error: templateError.message }];
    }

    res.status(200).json({ success: true, data: { wabaId, phoneNumberId, displayPhoneNumber, verifiedName, mode, templates } });
  } catch (error) {
    next(error);
  }
};

export const disconnect = async (req, res, next) => {
  try {
    const company = await activeCompany(req);
    if (!company) return next(new AppError('Empresa no encontrada', 404));

    company.integrations = {
      ...(company.integrations || {}),
      whatsappEnabled: false,
      whatsappWabaId: undefined,
      whatsappPhoneId: undefined,
      whatsappAccessToken: undefined,
      whatsappDisplayPhone: undefined,
      whatsappVerifiedName: undefined,
      whatsappConnectionMode: undefined,
      whatsappPin: undefined,
      whatsappConnectedAt: undefined,
    };
    await company.save();

    res.status(200).json({ success: true, message: 'Desconectado exitosamente' });
  } catch (error) {
    next(error);
  }
};
