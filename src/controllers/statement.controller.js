import mongoose from 'mongoose';
import Company from '../models/Company.js';
import Client from '../models/Client.js';
import Contract from '../models/Contract.js';
import Quota from '../models/Quota.js';
import StatementDelivery from '../models/StatementDelivery.js';
import VerificationToken from '../models/VerificationToken.js';
import AppError from '../utils/AppError.js';
import { isValidPublicLink } from '../utils/publicLinks.js';
import { sendEmail } from '../utils/notifications.js';
import { sendCompanyNotice, money, shortDate, propertyName } from '../services/whatsappTemplates.service.js';
import { logAudit } from '../utils/auditLogger.js';
import { sendStatementWorkbook } from '../utils/statementExcel.js';
import { statementEmail } from '../utils/statementMessages.js';
import { loadStatement, buildStatementSummary, getCompanyOverdueStats } from '../services/statementSummary.service.js';

const SELLER_ROLES = ['vendedor', 'ejecutivo_comercial', 'agent'];
const SEND_WINDOW_MS = 10 * 60 * 1000;
const MAX_SELF_SENDS_PER_WINDOW = 3;

const apiUrlOf = (req) => process.env.API_URL || `${req.protocol}://${req.get('host')}`;

const snapshotOf = (summary) => ({
  balance: summary.balance,
  overdueCount: summary.overdueCount,
  overdueAmount: summary.overdueAmount,
  daysOverdue: summary.daysOverdue,
});

const recordDelivery = async ({ loaded, channel, source, status = 'done', destination, error, req }) => {
  try {
    return await StatementDelivery.create({
      tenantId: loaded.contract.tenantId,
      companyId: loaded.contract.companyId,
      clientId: loaded.client?._id || loaded.contract.client,
      contractId: loaded.contract._id,
      channel,
      source,
      status,
      destination,
      error,
      sentBy: req?.user ? { userId: req.user.userId || req.user.accountId, name: req.user.fullName } : undefined,
      snapshot: snapshotOf(loaded.summary),
    });
  } catch (err) {
    console.error('[STATEMENT_DELIVERY] Could not record:', err.message);
    return null;
  }
};

/**
 * Sends the statement to the client's registered phone or email (never one
 * typed at send time) and records the attempt.
 */
const deliverStatement = async ({ loaded, channel, source, req }) => {
  const { client, company, summary } = loaded;
  const companyName = company?.name || 'tu inmobiliaria';

  let destination;
  let result;
  if (channel === 'whatsapp') {
    destination = client?.phone;
    if (!destination) throw new AppError('El cliente no tiene un celular registrado', 400);
    // From the company's number, with the statement PDF attached
    result = await sendCompanyNotice({
      company,
      to: destination,
      notice: 'estado_cuenta',
      values: {
        clientName: client.name,
        property: propertyName(loaded.contract.lot, company?.propertyType),
        companyName,
        date: shortDate(new Date()),
        paid: money(summary.totalPaid),
        balance: money(summary.balance),
        nextDue: summary.nextQuota?.dueDate ? shortDate(summary.nextQuota.dueDate) : '(sin cuotas pendientes)',
        statementUrl: summary.statementUrl,
      },
    });
  } else if (channel === 'email') {
    destination = client?.email;
    if (!destination) throw new AppError('El cliente no tiene un correo registrado', 400);
    const { subject, html } = statementEmail({ client, companyName, summary });
    result = await sendEmail(destination, subject, html);
  } else {
    throw new AppError('Canal no válido. Usa whatsapp o email.', 400);
  }

  let status = 'sent';
  if (result?.success === false) status = 'failed';
  else if (result?.provider === 'disabled') status = 'disabled';

  const delivery = await recordDelivery({ loaded, channel, source, status, destination, error: result?.error, req });
  return { status, delivery };
};

const deliveryMessage = (channel, status) => {
  const where = channel === 'whatsapp' ? 'WhatsApp' : 'correo';
  if (status === 'disabled') return `Los avisos están apagados en este ambiente: el estado de cuenta no salió por ${where}, pero quedó registrado.`;
  if (status === 'failed') return `No pudimos enviar el estado de cuenta por ${where}. Intenta de nuevo.`;
  return `Estado de cuenta enviado por ${where}.`;
};

/** Too many self-service sends would let anyone with a session flood the inbox. */
const assertSelfSendAllowed = async (clientId, channel) => {
  const recent = await StatementDelivery.countDocuments({
    clientId,
    channel,
    source: { $in: ['portal', 'public'] },
    createdAt: { $gt: new Date(Date.now() - SEND_WINDOW_MS) },
  });
  if (recent >= MAX_SELF_SENDS_PER_WINDOW) {
    throw new AppError('Ya te enviamos el estado de cuenta varias veces. Espera unos minutos antes de pedirlo otra vez.', 429);
  }
};

// ---------------------------------------------------------------- panel

/** Contract of the active company; sellers only reach the contracts they sold. */
const loadPanelStatement = async (req) => {
  const { tenantId, companyId, role, userId } = req.user;
  const { contractId } = req.params;
  if (!mongoose.isValidObjectId(contractId)) return null;
  const filter = { _id: contractId, tenantId, companyId };
  if (SELLER_ROLES.includes(role)) filter.sellerId = userId;
  return loadStatement(filter, { apiUrl: apiUrlOf(req) });
};

/**
 * POST /api/clients/statement/:contractId/send  { channel: 'whatsapp' | 'email' }
 */
export const sendClientStatement = async (req, res, next) => {
  try {
    const loaded = await loadPanelStatement(req);
    if (!loaded) return next(new AppError('Contrato no encontrado', 404));

    const channel = req.body?.channel;
    const { status, delivery } = await deliverStatement({ loaded, channel, source: 'panel', req });

    await logAudit(req, {
      action: 'SEND_STATEMENT',
      module: 'CLIENTS',
      targetId: loaded.contract._id,
      details: { clientId: loaded.client?._id, channel, status },
    });

    res.status(status === 'failed' ? 502 : 200).json({
      success: status !== 'failed',
      message: deliveryMessage(channel, status),
      data: { status, delivery },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/clients/statement/:contractId/link — the signed links, recorded as shared.
 */
export const shareClientStatementLink = async (req, res, next) => {
  try {
    const loaded = await loadPanelStatement(req);
    if (!loaded) return next(new AppError('Contrato no encontrado', 404));

    await recordDelivery({ loaded, channel: 'link', source: 'panel', req });

    res.json({
      success: true,
      data: { statementUrl: loaded.summary.statementUrl, excelUrl: loaded.summary.excelUrl },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/clients/:id/statement-deliveries — what was sent to the client and when.
 */
export const getClientStatementDeliveries = async (req, res, next) => {
  try {
    const { tenantId, companyId, role, userId } = req.user;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return next(new AppError('Cliente no encontrado', 404));

    const client = await Client.exists({ _id: id, tenantId, companyId });
    if (!client) return next(new AppError('Cliente no encontrado', 404));

    const filter = { tenantId, companyId, clientId: id };
    if (SELLER_ROLES.includes(role)) {
      const own = await Contract.find({ client: id, tenantId, companyId, sellerId: userId }).distinct('_id');
      filter.contractId = { $in: own };
    }

    const deliveries = await StatementDelivery.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, data: deliveries });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/payments/overdue-stats — company-wide overdue quotas with the summary rule.
 */
export const getOverdueStats = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user;
    res.json({ success: true, data: await getCompanyOverdueStats(tenantId, companyId) });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- public signed link

/**
 * GET /api/public/statement/excel/:contractId?s= — same signature rule as the PDF,
 * without the grace period for unsigned links (Excel links were always signed).
 */
export const getPublicStatementExcel = async (req, res, next) => {
  try {
    const { contractId } = req.params;
    if (!isValidPublicLink('statement-excel', contractId, req.query.s)) {
      return next(new AppError('Enlace no válido. Pide a tu inmobiliaria que te reenvíe el estado de cuenta.', 403));
    }
    if (!mongoose.isValidObjectId(contractId)) return next(new AppError('Contrato no encontrado', 404));

    const loaded = await loadStatement({ _id: contractId }, { apiUrl: apiUrlOf(req) });
    if (!loaded) return next(new AppError('Contrato no encontrado', 404));

    sendStatementWorkbook(res, loaded);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- portal

const loadPortalStatement = async (req) => {
  const { clientId, tenantId } = req.user;
  const { contractId } = req.params;
  if (!clientId || !mongoose.isValidObjectId(contractId)) return null;
  return loadStatement({ _id: contractId, client: clientId, tenantId }, { apiUrl: apiUrlOf(req) });
};

/** GET /api/portal/statement/:contractId/excel */
export const getPortalStatementExcel = async (req, res, next) => {
  try {
    const loaded = await loadPortalStatement(req);
    if (!loaded) return next(new AppError('Contrato no encontrado o no pertenece a este cliente', 404));
    await recordDelivery({ loaded, channel: 'excel', source: 'portal', req });
    sendStatementWorkbook(res, loaded);
  } catch (error) {
    next(error);
  }
};

/** POST /api/portal/statement/:contractId/send-email — to the registered email only. */
export const sendPortalStatementEmail = async (req, res, next) => {
  try {
    const loaded = await loadPortalStatement(req);
    if (!loaded) return next(new AppError('Contrato no encontrado o no pertenece a este cliente', 404));
    await assertSelfSendAllowed(loaded.client._id, 'email');

    const { status } = await deliverStatement({ loaded, channel: 'email', source: 'portal', req });
    res.status(status === 'failed' ? 502 : 200).json({
      success: status !== 'failed',
      message: status === 'failed' ? deliveryMessage('email', status) : 'Te enviamos el estado de cuenta a tu correo registrado.',
      data: { status },
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- public page (cédula + code)

/**
 * The verified code of the public page. Only a code that was checked
 * (verifiedAt), is still valid and belongs to this company opens the statement.
 */
const findVerifiedSession = async (companySlug, token) => {
  if (!token) throw new AppError('Verificación de identidad requerida', 401);
  const company = await Company.findOne({ slug: companySlug });
  if (!company) throw new AppError('Empresa no encontrada', 404);

  const session = await VerificationToken.findOne({
    token: String(token),
    companyId: company._id,
    isUsed: false,
    verifiedAt: { $ne: null },
    expiresAt: { $gt: new Date() },
  });
  if (!session) throw new AppError('Tu código venció o no es válido. Pide uno nuevo.', 401);

  const client = await Client.findOne({ _id: session.clientId, companyId: company._id });
  if (!client) throw new AppError('Cliente no encontrado', 404);
  return { company, client, session };
};

/**
 * POST /api/public/:companySlug/statement  { token }
 */
export const getPublicStatement = async (req, res, next) => {
  try {
    const { company, client } = await findVerifiedSession(req.params.companySlug, req.body?.token);
    const apiUrl = apiUrlOf(req);

    const contracts = await Contract.find({ client: client._id, companyId: company._id, tenantId: company.tenantId }).populate('lot');
    const quotas = await Quota.find({ contract: { $in: contracts.map((c) => c._id) }, companyId: company._id });

    const summaries = contracts.map((contract) => buildStatementSummary(
      contract,
      quotas.filter((q) => String(q.contract) === String(contract._id)),
      { apiUrl },
    ));

    await Promise.all(contracts.map((contract, i) => recordDelivery({
      loaded: { contract, client, summary: summaries[i] },
      channel: 'view',
      source: 'public',
    })));

    res.json({
      success: true,
      data: {
        client: { name: client.name, hasEmail: !!client.email },
        companyName: company.name,
        contracts: summaries,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/public/:companySlug/statement/send-email  { token, contractId }
 */
export const sendPublicStatementEmail = async (req, res, next) => {
  try {
    const { company, client } = await findVerifiedSession(req.params.companySlug, req.body?.token);
    const { contractId } = req.body || {};
    if (!mongoose.isValidObjectId(contractId)) return next(new AppError('Contrato no encontrado', 404));

    const loaded = await loadStatement(
      { _id: contractId, client: client._id, companyId: company._id, tenantId: company.tenantId },
      { apiUrl: apiUrlOf(req) },
    );
    if (!loaded) return next(new AppError('Contrato no encontrado', 404));
    await assertSelfSendAllowed(client._id, 'email');

    const { status } = await deliverStatement({ loaded, channel: 'email', source: 'public' });
    res.status(status === 'failed' ? 502 : 200).json({
      success: status !== 'failed',
      message: status === 'failed' ? deliveryMessage('email', status) : 'Te enviamos el estado de cuenta a tu correo registrado.',
      data: { status },
    });
  } catch (error) {
    next(error);
  }
};

export { recordDelivery };
