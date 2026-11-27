import UserAccount from '../models/UserAccount.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import Company from '../models/Company.js';
import UserCompany from '../models/UserCompany.js';
import AppError from '../utils/AppError.js';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { visibleEmail, MIN_PORTAL_PASSWORD } from '../utils/portalAccount.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  generateTenantSelectionToken,
  verifyTenantSelectionToken,
  setTokenCookies,
  clearTokenCookies,
} from '../utils/jwt.js';

/**
 * Build JWT payload for a given membership.
 */
const buildTokenPayload = async (account, membership) => {
  // Handle populated vs non-populated tenantId
  const tenantId = membership.tenantId?._id
    ? membership.tenantId._id.toString()
    : membership.tenantId.toString();

  // Load companies the user has access to
  let companies = [];

  if (membership.role === 'tenant_admin') {
    // Tenant admins can see all companies in the tenant
    const allCompanies = await Company.find({
      tenantId,
      status: 'active',
    }).select('_id');
    companies = allCompanies.map((c) => ({ id: c._id.toString(), role: 'tenant_admin' }));
  } else {
    const userCompanies = await UserCompany.find({
      userId: membership._id,
      tenantId,
    }).populate('companyId', '_id');
    companies = userCompanies.map((uc) => ({
      id: uc.companyId._id.toString(),
      role: uc.role,
    }));
  }

  const payload = {
    accountId: account._id.toString(),
    userId: membership._id.toString(),
    tenantId,
    role: membership.role,
    companies,
  };

  if (membership.clientId) {
    payload.clientId = membership.clientId.toString();
  }

  return payload;
};

/**
 * Build a clean user response object for the frontend.
 */
const buildUserResponse = (account, membership) => {
  const tenantObj = membership.tenantId; // may be populated object or ObjectId
  return {
    id: account._id.toString(),
    email: visibleEmail(account.email),
    fullName: account.fullName,
    ...(membership.role === 'cliente' ? { cedula: account.documentoIdentidad || '' } : {}),
    profileImage: account.profileImage,
    role: membership.role,
    tenantId: tenantObj?._id ? tenantObj._id.toString() : tenantObj.toString(),
    tenantName: tenantObj?.name || '',
    plan: tenantObj?.plan || 'basic',
    activeModules: tenantObj?.activeModules || ['cobranzas'],
    subscriptionStart: tenantObj?.subscriptionStart,
    subscriptionEnd: tenantObj?.subscriptionEnd,
  };
};

/**
 * POST /auth/register
 * Atomic: creates Tenant + UserAccount + User (tenant_admin) + a default Company.
 */
export const register = async (req, res, next) => {
  try {
    const { fullName, email, password, tenantName, companyName, propertyType } = req.body;

    // Check if account already exists
    const existingAccount = await UserAccount.findOne({ email });
    if (existingAccount) {
      return next(new AppError('Ese correo ya está registrado', 400));
    }

    // 1. Create Tenant
    const tenant = await Tenant.create({
      name: tenantName || `${fullName}'s Team`,
    });

    // 2. Create UserAccount
    const account = await UserAccount.create({
      email,
      passwordHash: password,
      fullName,
    });

    // 3. Create User membership (tenant_admin)
    const membership = await User.create({
      accountId: account._id,
      tenantId: tenant._id,
      role: 'tenant_admin',
    });

    // 4. Create a default Company
    const resolvedCompanyName = companyName || 'Mi Empresa';
    const baseSlug = resolvedCompanyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    const company = await Company.create({
      tenantId: tenant._id,
      name: resolvedCompanyName,
      slug: `${baseSlug}-${Date.now().toString().slice(-4)}`,
      propertyType: propertyType || 'lotes',
    });

    // Generate tokens
    const payload = await buildTokenPayload(account, membership);
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(account._id);

    setTokenCookies(res, accessToken, refreshToken);

    res.status(201).json({
      success: true,
      data: {
        user: {
          ...account.toJSON(),
          role: membership.role,
          tenantId: tenant._id,
          tenantName: tenant.name,
        },
        tenant: tenant.toJSON(),
        company: company.toJSON(),
        accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

const maskPhone = (phone) => {
  const value = String(phone || '');
  return value.length > 4 ? '*'.repeat(value.length - 4) + value.slice(-4) : value;
};

const MEMBERSHIP_TENANT_FIELDS = 'name plan status activeModules subscriptionStart subscriptionEnd';

/**
 * Send a buyer's code by WhatsApp. A person with properties in several projects has one client
 * (and one membership) per project; the code goes to the first one with a phone, and once inside
 * the buyer can switch project without another code.
 */
const sendBuyerCode = async (clientMemberships, purpose) => {
  const Client = (await import('../models/Client.js')).default;
  const clients = await Client.find({ _id: { $in: clientMemberships.map((m) => m.clientId) } });
  const byId = new Map(clients.map((c) => [c._id.toString(), c]));
  const membership = clientMemberships.find((m) => byId.get(String(m.clientId))?.phone);
  if (!membership) {
    throw new AppError('No tienes un celular registrado para enviarte el código. Pídele a tu inmobiliaria que lo agregue.', 400);
  }
  const client = byId.get(String(membership.clientId));

  const { sendOTPCode } = await import('../utils/otpHelper.js');
  const company = await Company.findById(client.companyId);
  const { agencyName } = await import('../utils/agency.js');
  const agency = await agencyName(company, 'Inmobiliaria');

  const tenantId = membership.tenantId?._id || membership.tenantId;
  const otpToken = await sendOTPCode(tenantId, client.companyId, client._id, 'phone', client.phone, agency, purpose);
  return { phone: maskPhone(client.phone), otpToken };
};

/** The active buyer memberships of an account, with active tenants */
const activeClientMemberships = async (accountId) => {
  const memberships = await User.find({ accountId, role: 'cliente', status: 'active' })
    .populate('tenantId', MEMBERSHIP_TENANT_FIELDS);
  return memberships.filter((m) => m.tenantId && m.tenantId.status !== 'suspended' && m.clientId);
};

/** Verify a buyer's code for one purpose; the token burns after five wrong codes */
const consumeBuyerCode = async (otpToken, otpCode, purpose) => {
  if (typeof otpToken !== 'string' || !otpToken || !otpCode) {
    throw new AppError('Escribe el código de verificación', 400);
  }
  const VerificationToken = (await import('../models/VerificationToken.js')).default;
  const vToken = await VerificationToken.findOne({
    token: otpToken,
    purpose,
    isUsed: false,
    expiresAt: { $gt: new Date() },
  });
  if (!vToken) throw new AppError('Código de verificación incorrecto o expirado', 400);
  if (!codesMatch(vToken.code, otpCode)) {
    vToken.attempts = (vToken.attempts || 0) + 1;
    if (vToken.attempts >= MAX_OTP_ATTEMPTS) vToken.isUsed = true;
    await vToken.save();
    throw new AppError('Código de verificación incorrecto o expirado', 400);
  }
  vToken.isUsed = true;
  await vToken.save();
  return vToken;
};

/** Open the buyer session of one membership */
const openBuyerSession = async (res, account, membership) => {
  const payload = await buildTokenPayload(account, membership);
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(account._id);
  setTokenCookies(res, accessToken, refreshToken);
  return res.json({
    success: true,
    data: { user: buildUserResponse(account, membership), accessToken },
  });
};

/** The membership and account the code was sent to */
const buyerOfCode = async (vToken) => {
  const membership = await User.findOne({
    clientId: vToken.clientId,
    tenantId: vToken.tenantId,
    role: 'cliente',
    status: 'active',
  }).populate('tenantId', MEMBERSHIP_TENANT_FIELDS);
  if (!membership || membership.tenantId?.status === 'suspended') {
    throw new AppError('Tu acceso al portal no está activo. Pídele ayuda a tu inmobiliaria.', 401);
  }
  const account = await UserAccount.findById(membership.accountId);
  if (!account || account.status !== 'active') {
    throw new AppError('Tu acceso al portal no está activo. Pídele ayuda a tu inmobiliaria.', 401);
  }
  return { membership, account };
};

/**
 * POST /auth/login
 * Step 1: Verify credentials.
 * If user has ONE active membership → return JWT directly.
 * If user has MULTIPLE memberships → return list for selection.
 */
// A hash with the same cost as real passwords, compared when the user does not exist
const DUMMY_HASH = bcrypt.hashSync('operix-no-account', 12);

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Find account with password (supporting email or document number)
    const query = email.includes('@')
      ? { email: email.toLowerCase() }
      : { documentoIdentidad: email.trim() };

    let account = await UserAccount.findOne(query).select('+passwordHash');

    // On-the-fly auto-onboarding for clients loaded via Excel/massive upload
    if (!account && !email.includes('@')) {
      const Client = (await import('../models/Client.js')).default;
      const client = await Client.findOne({ idNumber: email.trim() });
      
      if (client) {
        const defaultPassword = client.idNumber;
        const emailValue = client.email || `${client.idNumber}@portal.com`;

        account = await UserAccount.create({
          email: emailValue,
          passwordHash: defaultPassword,
          fullName: client.name,
          documentoIdentidad: client.idNumber,
        });

        const UserModel = (await import('../models/User.js')).default;
        await UserModel.create({
          accountId: account._id,
          tenantId: client.tenantId,
          role: 'cliente',
          clientId: client._id,
        });

        console.log(`[AUTH_LOGIN] On-the-fly UserAccount & User created for client: ${client.name} (${client.idNumber})`);
        
        // Re-query account to include passwordHash
        account = await UserAccount.findById(account._id).select('+passwordHash');
      }
    }

    // An unknown user costs the same hash check as a wrong password, so neither the message
    // nor the time tells whether the document or email has an account
    const passwordOk = account
      ? await account.comparePassword(password)
      : (await bcrypt.compare(String(password), DUMMY_HASH), false);
    if (!passwordOk) {
      return next(new AppError('Usuario o contraseña incorrectos', 401));
    }

    if (account.status !== 'active') {
      return next(new AppError('Esta cuenta está desactivada. Pídele ayuda a tu inmobiliaria.', 401));
    }

    // Find all active memberships
    const memberships = await User.find({
      accountId: account._id,
      status: 'active',
    }).populate('tenantId', 'name plan status activeModules subscriptionStart subscriptionEnd');

    // Filter memberships with active tenants
    const activeMemberships = memberships.filter(
      (m) => m.tenantId && m.tenantId.status !== 'suspended'
    );

    if (activeMemberships.length === 0) {
      return next(new AppError('Tu acceso no está activo. Pídele ayuda a tu inmobiliaria.', 401));
    }

    // Update last login
    account.lastLogin = new Date();
    await account.save({ validateBeforeSave: false });

    // A buyer signs in with a code sent to their phone. Another company can register a buyer with
    // the email of someone's team account, so a team membership wins in the panel login and the
    // buyer flow runs only without one, or when the client portal asks for it
    const clientMemberships = activeMemberships.filter((m) => m.role === 'cliente');
    const teamMemberships = activeMemberships.filter((m) => m.role !== 'cliente');
    if (clientMemberships.length > 0 && teamMemberships.length === 0 && req.body.portal !== 'cliente') {
      // A buyer in the company sign-in: say where to go before a code is spent
      return res.status(403).json({
        success: false,
        code: 'BUYER_ACCOUNT',
        message: 'Esta cuenta es de comprador. Entra por el portal cliente.',
      });
    }
    if (clientMemberships.length > 0 && req.body.portal === 'cliente') {
      const sent = await sendBuyerCode(clientMemberships, 'login');
      return res.json({ success: true, data: { requiresOtp: true, ...sent } });
    }

    if (teamMemberships.length === 1) {
      // Single membership — generate JWT directly
      const membership = teamMemberships[0];
      const payload = await buildTokenPayload(account, membership);
      const accessToken = generateAccessToken(payload);
      const refreshToken = generateRefreshToken(account._id);

      setTokenCookies(res, accessToken, refreshToken);

      return res.json({
        success: true,
        data: {
          requiresTenantSelection: false,
          user: buildUserResponse(account, membership),
          accessToken,
        },
      });
    }

    // Multiple memberships — return list for selection
    return res.json({
      success: true,
      data: {
        requiresTenantSelection: true,
        selectionToken: generateTenantSelectionToken(account._id),
        memberships: teamMemberships.map((m) => ({
          userId: m._id,
          tenantId: m.tenantId._id,
          tenantName: m.tenantId.name,
          role: m.role,
          plan: m.tenantId.plan,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

const MAX_OTP_ATTEMPTS = 5;

const codesMatch = (expected, received) => {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(received));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * POST /auth/verify-client-otp
 * The session is issued for the client the code was sent to, never for ids sent in the body.
 */
export const verifyClientOtp = async (req, res, next) => {
  try {
    const { otpCode, otpToken } = req.body;
    // Only a sign-in code opens the portal (not one asked for a payment or a statement)
    const vToken = await consumeBuyerCode(otpToken, otpCode, 'login');
    const { membership, account } = await buyerOfCode(vToken);
    return openBuyerSession(res, account, membership);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/client-password/request { document }
 * A buyer who forgot the password asks for a code to the phone the company has on file.
 * The answer is the same whether or not the document has access, so it never tells who is a
 * buyer: an unknown document, one without a phone or one that already asked for several codes
 * gets a token that matches no code.
 */
export const RESET_REQUEST_MESSAGE = 'Si ese documento tiene acceso al portal, te enviamos un código por WhatsApp al celular registrado.';

export const requestClientPasswordReset = async (req, res, next) => {
  try {
    const document = String(req.body?.document || '').trim();
    if (!document) return next(new AppError('Escribe tu número de documento', 400));
    let otpToken = crypto.randomBytes(32).toString('hex');
    const account = await UserAccount.findOne({ documentoIdentidad: document });
    const memberships = account && account.status === 'active' ? await activeClientMemberships(account._id) : [];
    if (memberships.length > 0) {
      try {
        ({ otpToken } = await sendBuyerCode(memberships, 'password_reset'));
      } catch (error) {
        // No phone on file (400) or too many codes (429): answer as if nothing happened.
        // A failed WhatsApp send (502) is not about the document, so the buyer hears about it
        if (![400, 429].includes(error.statusCode)) throw error;
      }
    }
    res.json({ success: true, message: RESET_REQUEST_MESSAGE, data: { otpToken } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/client-password/reset { otpToken, otpCode, password }
 * Sets the new password and opens the portal.
 */
export const resetClientPassword = async (req, res, next) => {
  try {
    const { otpToken, otpCode, password } = req.body || {};
    if (typeof password !== 'string' || password.length < MIN_PORTAL_PASSWORD) {
      return next(new AppError(`La contraseña debe tener al menos ${MIN_PORTAL_PASSWORD} caracteres`, 400));
    }
    const vToken = await consumeBuyerCode(otpToken, otpCode, 'password_reset');
    const { membership, account } = await buyerOfCode(vToken);
    const withPassword = await UserAccount.findById(account._id).select('+passwordHash');
    withPassword.passwordHash = password;
    await withPassword.save({ validateBeforeSave: false });
    return openBuyerSession(res, account, membership);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /auth/client-projects
 * The projects where the signed-in buyer has properties, to switch between them.
 */
export const getClientProjects = async (req, res, next) => {
  try {
    if (req.user.role !== 'cliente') return next(new AppError('Solo para compradores', 403));
    const memberships = await activeClientMemberships(req.user.accountId);
    const Client = (await import('../models/Client.js')).default;
    const clients = await Client.find({ _id: { $in: memberships.map((m) => m.clientId) } })
      .select('companyId').populate('companyId', 'name');
    const projects = clients.map((c) => {
      const membership = memberships.find((m) => String(m.clientId) === c._id.toString());
      return {
        clientId: c._id.toString(),
        projectName: c.companyId?.name || '',
        tenantName: membership?.tenantId?.name || '',
        current: c._id.toString() === String(req.user.clientId),
      };
    });
    res.json({ success: true, data: { projects } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/switch-client { clientId }
 * Opens another project of the same buyer account (already verified by its code).
 */
export const switchClient = async (req, res, next) => {
  try {
    if (req.user.role !== 'cliente') return next(new AppError('Solo para compradores', 403));
    const memberships = await activeClientMemberships(req.user.accountId);
    const membership = memberships.find((m) => String(m.clientId) === String(req.body?.clientId));
    if (!membership) return next(new AppError('No tienes inmuebles en ese proyecto', 404));
    const account = await UserAccount.findById(req.user.accountId);
    if (!account || account.status !== 'active') {
      return next(new AppError('Tu acceso al portal no está activo. Pídele ayuda a tu inmobiliaria.', 401));
    }
    return openBuyerSession(res, account, membership);
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /auth/client-password { currentPassword, password }
 * The buyer changes the password from Mi perfil.
 */
export const changeClientPassword = async (req, res, next) => {
  try {
    if (req.user.role !== 'cliente') return next(new AppError('Solo para compradores', 403));
    const { currentPassword, password } = req.body || {};
    if (typeof password !== 'string' || password.length < MIN_PORTAL_PASSWORD) {
      return next(new AppError(`La contraseña nueva debe tener al menos ${MIN_PORTAL_PASSWORD} caracteres`, 400));
    }
    const account = await UserAccount.findById(req.user.accountId).select('+passwordHash');
    if (!account || !(await account.comparePassword(String(currentPassword || '')))) {
      return next(new AppError('La contraseña actual no es correcta', 400));
    }
    account.passwordHash = password;
    await account.save({ validateBeforeSave: false });
    res.json({ success: true, message: 'Contraseña actualizada' });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/select-tenant
 * Step 2 (only if multiple memberships): select which tenant to work with.
 * Requires the selection token that /auth/login returns after checking the password.
 */
export const selectTenant = async (req, res, next) => {
  try {
    const { selectionToken, tenantId } = req.body;

    if (!selectionToken || !tenantId) {
      return next(new AppError('Elige con qué inmobiliaria quieres entrar', 400));
    }

    let accountId;
    try {
      ({ accountId } = verifyTenantSelectionToken(selectionToken));
    } catch {
      return next(new AppError('La selección de equipo expiró. Inicia sesión de nuevo.', 401));
    }

    const account = await UserAccount.findById(accountId);
    if (!account || account.status !== 'active') {
      return next(new AppError('Tu cuenta no está activa. Inicia sesión de nuevo.', 401));
    }

    // A buyer membership never opens without its phone code
    const membership = await User.findOne({
      accountId: account._id,
      tenantId: tenantId,
      status: 'active',
      role: { $ne: 'cliente' },
    }).populate('tenantId', 'name plan status activeModules subscriptionStart subscriptionEnd');

    if (!membership) {
      return next(new AppError('No tienes acceso activo a esa inmobiliaria', 401));
    }

    if (membership.tenantId.status === 'suspended') {
      return next(new AppError('Esta inmobiliaria está suspendida', 403));
    }

    const payload = await buildTokenPayload(account, membership);
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(account._id);

    setTokenCookies(res, accessToken, refreshToken);

    res.json({
      success: true,
      data: {
        user: buildUserResponse(account, membership),
        accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/logout
 */
export const logout = async (req, res, next) => {
  try {
    clearTokenCookies(res);

    res.json({
      success: true,
      message: 'Sesión cerrada',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /auth/me
 */
export const getMe = async (req, res, next) => {
  try {
    const account = await UserAccount.findById(req.user.accountId);

    // Load current tenant info
    const tenant = await Tenant.findById(req.user.tenantId);

    // Load companies
    let companies = [];
    if (req.user.role === 'tenant_admin') {
      companies = await Company.find({
        tenantId: req.user.tenantId,
        status: 'active',
      });
    } else {
      const userCompanies = await UserCompany.find({
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      }).populate('companyId');
      companies = userCompanies.map((uc) => uc.companyId);
    }

    res.json({
      success: true,
      data: {
        user: {
          ...account.toJSON(),
          email: visibleEmail(account.email),
          role: req.user.role,
          tenantId: req.user.tenantId,
          tenantName: tenant?.name,
        },
        tenant: tenant?.toJSON(),
        companies: companies.map((c) => c.toJSON()),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/refresh
 */
export const refreshTokenHandler = async (req, res, next) => {
  try {
    const token = req.cookies.refreshToken;

    if (!token) {
      return next(new AppError('Tu sesión venció. Inicia sesión de nuevo.', 401));
    }

    const decoded = verifyRefreshToken(token);

    const account = await UserAccount.findById(decoded.accountId);

    if (!account || account.status !== 'active') {
      return next(new AppError('Tu cuenta no está activa. Inicia sesión de nuevo.', 401));
    }

    // Find the most recent active membership
    const membership = await User.findOne({
      accountId: account._id,
      status: 'active',
    }).sort({ updatedAt: -1 });

    if (!membership) {
      return next(new AppError('No tienes un acceso activo', 401));
    }

    const payload = await buildTokenPayload(account, membership);
    const accessToken = generateAccessToken(payload);
    const newRefreshToken = generateRefreshToken(account._id);

    setTokenCookies(res, accessToken, newRefreshToken);

    res.json({
      success: true,
      data: { accessToken },
    });
  } catch (error) {
    clearTokenCookies(res);
    next(new AppError('Tu sesión venció. Inicia sesión de nuevo.', 401));
  }
};
