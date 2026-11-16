/**
 * Escapes text typed in a search box so it matches literally inside a MongoDB $regex.
 * Without it, «(» or «+» makes the pattern invalid (500) and «.» matches any character.
 */
export const escapeRegex = (text = '') => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
