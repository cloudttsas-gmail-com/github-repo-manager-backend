import UserAccount from '../models/UserAccount.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import Company from '../models/Company.js';
import UserCompany from '../models/UserCompany.js';
import AppError from '../utils/AppError.js';
import crypto from 'crypto';
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
    email: account.email,
    fullName: account.fullName,
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
      return next(new AppError('Email already registered', 400));
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

/**
 * POST /auth/login
 * Step 1: Verify credentials.
 * If user has ONE active membership → return JWT directly.
 * If user has MULTIPLE memberships → return list for selection.
 */
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

    if (!account || !(await account.comparePassword(password))) {
      return next(new AppError('Usuario o contraseña incorrectos', 401));
    }

    if (account.status !== 'active') {
      return next(new AppError('Account is deactivated', 401));
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
      return next(new AppError('No active team memberships found', 401));
    }

    // Update last login
    account.lastLogin = new Date();
    await account.save({ validateBeforeSave: false });

    // Check if the user is a client (requires OTP validation)
    const clientMembership = activeMemberships.find((m) => m.role === 'cliente');
    if (clientMembership) {
      const Client = (await import('../models/Client.js')).default;
      const client = await Client.findById(clientMembership.clientId);
      if (!client || !client.phone) {
        return next(new AppError('No se encontró un número de celular registrado para enviar el código de verificación.', 400));
      }

      // Generate and send OTP
      const { sendOTPCode } = await import('../utils/otpHelper.js');
      const Company = (await import('../models/Company.js')).default;
      const company = await Company.findById(client.companyId);
      const companyName = company?.name || 'Inmobiliaria';

      const otpToken = await sendOTPCode(
        clientMembership.tenantId._id,
        client.companyId,
        client._id,
        'phone', // Satisfies VerificationToken schema validation enum
        client.phone,
        companyName,
        'login'
      );

      return res.json({
        success: true,
        data: {
          requiresOtp: true,
          phone: client.phone,
          otpToken,
        },
      });
    }

    if (activeMemberships.length === 1) {
      // Single membership — generate JWT directly
      const membership = activeMemberships[0];
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
        memberships: activeMemberships.map((m) => ({
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

    if (typeof otpToken !== 'string' || !otpToken || !otpCode) {
      return next(new AppError('Todos los campos son requeridos para la verificación', 400));
    }

    const VerificationToken = (await import('../models/VerificationToken.js')).default;
    const vToken = await VerificationToken.findOne({
      token: otpToken,
      isUsed: false,
      expiresAt: { $gt: new Date() },
    });

    if (!vToken) {
      return next(new AppError('Código de verificación incorrecto o expirado', 400));
    }

    if (!codesMatch(vToken.code, otpCode)) {
      vToken.attempts = (vToken.attempts || 0) + 1;
      if (vToken.attempts >= MAX_OTP_ATTEMPTS) vToken.isUsed = true;
      await vToken.save();
      return next(new AppError('Código de verificación incorrecto o expirado', 400));
    }

    vToken.isUsed = true;
    await vToken.save();

    const membership = await User.findOne({
      clientId: vToken.clientId,
      tenantId: vToken.tenantId,
      role: 'cliente',
      status: 'active',
    }).populate('tenantId', 'name plan status activeModules subscriptionStart subscriptionEnd');

    if (!membership || membership.tenantId?.status === 'suspended') {
      return next(new AppError('Membresía no encontrada o inactiva', 401));
    }

    const account = await UserAccount.findById(membership.accountId);
    if (!account || account.status !== 'active') {
      return next(new AppError('Cuenta no encontrada o inactiva', 401));
    }

    const payload = await buildTokenPayload(account, membership);
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(account._id);

    setTokenCookies(res, accessToken, refreshToken);

    return res.json({
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
 * POST /auth/select-tenant
 * Step 2 (only if multiple memberships): select which tenant to work with.
 * Requires the selection token that /auth/login returns after checking the password.
 */
export const selectTenant = async (req, res, next) => {
  try {
    const { selectionToken, tenantId } = req.body;

    if (!selectionToken || !tenantId) {
      return next(new AppError('selectionToken and tenantId are required', 400));
    }

    let accountId;
    try {
      ({ accountId } = verifyTenantSelectionToken(selectionToken));
    } catch {
      return next(new AppError('La selección de equipo expiró. Inicia sesión de nuevo.', 401));
    }

    const account = await UserAccount.findById(accountId);
    if (!account || account.status !== 'active') {
      return next(new AppError('Account not found or inactive', 401));
    }

    const membership = await User.findOne({
      accountId: account._id,
      tenantId: tenantId,
      status: 'active',
    }).populate('tenantId', 'name plan status activeModules subscriptionStart subscriptionEnd');

    if (!membership) {
      return next(new AppError('No active membership for this tenant', 401));
    }

    if (membership.tenantId.status === 'suspended') {
      return next(new AppError('This team is suspended', 403));
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
      message: 'Logged out successfully',
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
      return next(new AppError('No refresh token provided', 401));
    }

    const decoded = verifyRefreshToken(token);

    const account = await UserAccount.findById(decoded.accountId);

    if (!account || account.status !== 'active') {
      return next(new AppError('Account not found or inactive', 401));
    }

    // Find the most recent active membership
    const membership = await User.findOne({
      accountId: account._id,
      status: 'active',
    }).sort({ updatedAt: -1 });

    if (!membership) {
      return next(new AppError('No active membership found', 401));
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
    next(new AppError('Invalid refresh token', 401));
  }
};
