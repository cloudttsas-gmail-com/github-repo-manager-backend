import AppError from '../utils/AppError.js';
import { verifyAccessToken } from '../utils/jwt.js';
import UserAccount from '../models/UserAccount.js';
import User from '../models/User.js';

import { PERMISSIONS, hasPermission } from '../config/permissions.js';

/**
 * Protect middleware — verifies JWT and injects req.user.
 * req.user = { accountId, userId, tenantId, role, companies }
 */
export const protect = async (req, res, next) => {
  try {
    let token;

    // Check cookie first, then Authorization header
    if (req.cookies.accessToken) {
      token = req.cookies.accessToken;
    } else if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new AppError('Not authorized, please log in', 401));
    }

    // Verify token — payload has { accountId, userId, tenantId, role, companies }
    const decoded = verifyAccessToken(token);

    // Verify the account still exists and is active
    const account = await UserAccount.findById(decoded.accountId);
    if (!account) {
      return next(new AppError('User account no longer exists', 401));
    }
    if (account.status !== 'active') {
      return next(new AppError('User account is deactivated', 401));
    }

    // A deactivated access to the inmobiliaria ends the open session too, not when the token expires
    const membership = await User.exists({ _id: decoded.userId, tenantId: decoded.tenantId, status: 'active' });
    if (!membership) {
      return next(new AppError('Tu acceso a esta inmobiliaria está desactivado', 401));
    }

    // Attach decoded token data to request
    req.user = {
      accountId: decoded.accountId,
      userId: decoded.userId,
      tenantId: decoded.tenantId,
      role: decoded.role,
      companies: decoded.companies || [],
      clientId: decoded.clientId,
      fullName: account.fullName,
      email: account.email,
    };

    next();
  } catch (error) {
    return next(new AppError('Not authorized, invalid token', 401));
  }
};

/**
 * Restrict to specific roles within the tenant.
 * @deprecated Use checkPermission instead for more granular control.
 */
export const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action', 403)
      );
    }
    next();
  };
};

/**
 * Check if the user has a specific permission.
 */
export const checkPermission = (permission) => {
  return (req, res, next) => {
    const hasPerm = hasPermission(req.user.role, permission);
    if (!hasPerm) {
      return next(
        new AppError(`No tienes permiso para realizar esta acción (${permission})`, 403)
      );
    }
    next();
  };
};
