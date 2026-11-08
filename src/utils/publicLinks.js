import crypto from 'crypto';

/**
 * Public receipt and statement links carry an HMAC of the resource id (`?s=`),
 * so knowing or guessing an id is not enough to download someone's documents.
 */
const PATHS = {
  receipt: 'receipt',
  'receipt-attempt': 'receipt/attempt',
  statement: 'statement',
  'statement-excel': 'statement/excel',
};

const sign = (kind, id) => crypto
  .createHmac('sha256', process.env.JWT_SECRET)
  .update(`${kind}:${id}`)
  .digest('base64url')
  .slice(0, 32);

export const isValidPublicLink = (kind, id, signature) => {
  if (typeof signature !== 'string' || !id) return false;
  const expected = Buffer.from(sign(kind, String(id)));
  const received = Buffer.from(signature);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
};

/**
 * Links sent before signing existed have no `s`. They keep working until the
 * date in PUBLIC_LINKS_UNSIGNED_UNTIL (YYYY-MM-DD); a wrong signature never does.
 */
export const allowsUnsignedLink = (signature, now = new Date()) => {
  if (signature !== undefined && signature !== '') return false;
  const until = process.env.PUBLIC_LINKS_UNSIGNED_UNTIL;
  if (!until) return false;
  const limit = new Date(`${until}T23:59:59-05:00`);
  return !Number.isNaN(limit.getTime()) && now <= limit;
};

export const publicLinkUrl = (kind, id, apiUrl = process.env.API_URL || '') =>
  `${apiUrl}/api/public/${PATHS[kind]}/${id}?s=${sign(kind, String(id))}`;

/**
 * Signs a stored receipt URL (older ones were saved unsigned), keeping its host.
 */
export const signReceiptUrl = (url) => {
  if (!url) return url;
  const match = url.match(/^(.*)\/api\/public\/receipt\/(attempt\/)?([a-fA-F0-9]{24})/);
  if (!match) return url;
  const [, apiUrl, attempt, id] = match;
  return publicLinkUrl(attempt ? 'receipt-attempt' : 'receipt', id, apiUrl);
};
