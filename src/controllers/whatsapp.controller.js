import { whatsappService } from '../services/whatsapp.service.js';
import {
  companyWhatsAppAccount, ensureDefaultTemplates, buildCompanyTemplate, templateFieldsFor,
  prepareHeaderSample, DOCUMENT_SOURCES, projectSamples,
} from '../services/whatsappTemplates.service.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Client from '../models/Client.js';
import Company from '../models/Company.js';
import TemplateMedia from '../models/TemplateMedia.js';
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

const processWebhookEvent = async (body) => {
  const value = body.entry?.[0]?.changes?.[0]?.value;
  if (!value) return;

  const messageData = value.messages?.[0];
  if (messageData) {
    const waId = messageData.from; // Phone number with country code, e.g. "573001234567"
    const phoneId = value.metadata?.phone_number_id;

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

    // Match the client by the last 10 digits of the phone number
    const last10Digits = waId.slice(-10);
    const client = await Client.findOne({
      tenantId,
      companyId: company._id,
      phone: { $regex: last10Digits },
    });
    if (!client) {
      console.warn('[WHATSAPP WEBHOOK] message from a number with no client');
      return;
    }

    let conv = await Conversation.findOne({ clientId: client._id });
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
      tenantId: client.tenantId,
      waId: messageData.id,
      direction: 'inbound',
      type: messageData.type === 'text' ? 'text' : 'button',
      body: text,
      status: 'received',
    });
    console.log(`[WHATSAPP WEBHOOK] inbound ${messageData.type} message stored`);
    return;
  }

  // Status updates (sent, delivered, read)
  const status = value.statuses?.[0];
  if (status) {
    await Message.findOneAndUpdate({ waId: status.id }, { status: status.status });
    console.log(`[WHATSAPP WEBHOOK] status ${status.status}`);
  }
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

    // If no client provided but we have phone, try to find one
    if (!client) {
      const last10Digits = phone.toString().slice(-10);
      client = await Client.findOne({ tenantId, companyId, phone: { $regex: last10Digits } });
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
    let conv = await Conversation.findOne({ waId, tenantId });
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
export const getChatHistory = async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const { tenantId } = req.user;

    const conv = await Conversation.findOne({ clientId, tenantId });
    if (!conv) {
      return res.status(200).json({ success: true, data: [] });
    }

    // Reset unread count when opening chat
    conv.unreadCount = 0;
    await conv.save();

    const messages = await Message.find({ conversationId: conv._id, tenantId })
      .sort({ createdAt: 1 })
      .limit(100);

    res.status(200).json({ success: true, data: messages });
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
    const conversations = await Conversation.find({
      tenantId,
      $or: [{ companyId }, { companyId: { $exists: false } }, { companyId: null }],
    })
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
    const waConfig = await accountOf(req);
    if (!waConfig) return next(new AppError(NOT_CONNECTED, 400));
    const templates = await whatsappService.getTemplates(waConfig);
    // Senders get the approved ones; the templates page asks for all with their status
    const data = req.query.all === 'true' ? templates : templates.filter((t) => t.status === 'APPROVED');
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
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
    // Meta keeps only the sample of a media header: Operix keeps what to attach when sending
    const media = req.body.headerMedia;
    if (template.components[0]?.format && template.components[0].format !== 'TEXT' && media?.source) {
      await TemplateMedia.findOneAndUpdate(
        { companyId: company._id, name: template.name, language: template.language },
        {
          tenantId: company.tenantId, format: template.components[0].format,
          source: media.source,
          // Only a file Operix stored itself (header-sample), never an outside link
          fileUrl: media.source === 'file' && String(media.fileUrl || '').startsWith(`${process.env.R2_PUBLIC_URL}/whatsapp-templates/`) ? media.fileUrl : undefined,
          fileName: String(media.fileName || '').slice(0, 120),
        },
        { upsert: true, runValidators: true },
      );
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
