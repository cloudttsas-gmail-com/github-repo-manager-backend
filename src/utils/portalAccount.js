import UserAccount from '../models/UserAccount.js';
import User from '../models/User.js';

// A buyer without an email gets `<document>@portal.com` because the account needs one;
// it is internal and never shown as the buyer's email
const PLACEHOLDER_EMAIL = /@portal\.com$/i;

export const isPlaceholderEmail = (email) => PLACEHOLDER_EMAIL.test(String(email || ''));

export const visibleEmail = (email) => (isPlaceholderEmail(email) ? '' : email || '');

export const MIN_PORTAL_PASSWORD = 8;

/**
 * After the team edits a buyer (or the buyer confirms their data), the account the buyer signs
 * in with follows the new document and email. The account is left alone where that would take
 * a sign-in from someone else: an email or document that another account already uses, or the
 * email of an account that also belongs to a team (team members sign in with it).
 * Returns the fields it could not change, so the caller can say so.
 */
export const syncPortalAccount = async (client, { previousEmail } = {}) => {
  const membership = await User.findOne({ clientId: client._id, role: 'cliente' });
  if (!membership) return { skipped: [] };
  const account = await UserAccount.findById(membership.accountId);
  if (!account) return { skipped: [] };

  const skipped = [];
  let changed = false;

  const idNumber = String(client.idNumber || '').trim();
  if (idNumber && account.documentoIdentidad !== idNumber) {
    const taken = await UserAccount.exists({ documentoIdentidad: idNumber, _id: { $ne: account._id } });
    if (taken) skipped.push('idNumber');
    else {
      account.documentoIdentidad = idNumber;
      changed = true;
    }
  }

  const email = String(client.email || '').trim().toLowerCase();
  const before = String(previousEmail || '').trim().toLowerCase();
  if (email && /^\S+@\S+\.\S+$/.test(email) && account.email !== email) {
    // Only an email that was the buyer's: the placeholder or the one the client had before
    const ownedByBuyer = isPlaceholderEmail(account.email) || (before && account.email === before);
    const onTeam = await User.exists({ accountId: account._id, role: { $ne: 'cliente' } });
    const taken = await UserAccount.exists({ email, _id: { $ne: account._id } });
    if (!ownedByBuyer || onTeam || taken) skipped.push('email');
    else {
      account.email = email;
      changed = true;
    }
  }

  if (changed) await account.save({ validateBeforeSave: false });
  return { skipped };
};
