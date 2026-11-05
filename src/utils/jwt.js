import jwt from 'jsonwebtoken';

/**
 * Generate access token with multi-tenant payload.
 * @param {Object} payload - { accountId, userId, tenantId, role, companies }
 */
export const generateAccessToken = (payload) => {
  return jwt.sign(
    payload,
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '8h' }
  );
};

export const generateRefreshToken = (accountId) => {
  return jwt.sign(
    { accountId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d' }
  );
};

export const verifyAccessToken = (token) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  // Short-lived purpose tokens (e.g. tenant selection) are signed with the same
  // secret but never grant a session.
  if (decoded.purpose || !decoded.userId) {
    throw new jwt.JsonWebTokenError('Not an access token');
  }
  return decoded;
};

const TENANT_SELECTION_PURPOSE = 'tenant_selection';

/**
 * Short-lived token issued after a valid password check when the account
 * belongs to several teams. It is the only proof /auth/select-tenant accepts.
 */
export const generateTenantSelectionToken = (accountId) => {
  return jwt.sign(
    { accountId: accountId.toString(), purpose: TENANT_SELECTION_PURPOSE },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
};

export const verifyTenantSelectionToken = (token) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.purpose !== TENANT_SELECTION_PURPOSE || !decoded.accountId) {
    throw new jwt.JsonWebTokenError('Not a tenant selection token');
  }
  return decoded;
};

export const verifyRefreshToken = (token) => {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
};

export const setTokenCookies = (res, accessToken, refreshToken) => {
  const isProduction = process.env.NODE_ENV === 'production';
  // If COOKIE_SECURE is explicitly false, respect it (useful for local testing with HTTPS if needed)
  const cookieSecure = process.env.COOKIE_SECURE !== 'false' && isProduction;

  const cookieOptions = {
    httpOnly: true, // Prevents JS access (XSS protection)
    secure: cookieSecure, // Only sends over HTTPS
    sameSite: isProduction ? 'strict' : 'lax', // CSRF protection
  };

  res.cookie('accessToken', accessToken, {
    ...cookieOptions,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });

  res.cookie('refreshToken', refreshToken, {
    ...cookieOptions,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/api/auth/refresh',
  });
};

export const clearTokenCookies = (res) => {
  res.cookie('accessToken', '', {
    httpOnly: true,
    expires: new Date(0),
  });

  res.cookie('refreshToken', '', {
    httpOnly: true,
    expires: new Date(0),
    path: '/api/auth/refresh',
  });
};
