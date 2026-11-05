import crypto from 'crypto';

/**
 * Public receipt and statement links carry an HMAC of the resource id (`?s=`),
 * so knowing or guessing an id is not enough to download someone's documents.
 */
const PATHS = {
  receipt: 'receipt',
  'receipt-attempt': 'receipt/attempt',
  statement: 'statement',
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
