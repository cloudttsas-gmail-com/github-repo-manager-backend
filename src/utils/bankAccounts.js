import Company from '../models/Company.js';
import AppError from './AppError.js';

/**
 * Turns the bank a payment was made to into what is stored on the payment.
 * When the payer picked one of the company's authorized accounts, the account
 * must exist and be active, and its bank name is stored with its id so the
 * Siigo export finds the right accounting account. Without an account id the
 * free bank name is kept, as before.
 */
export const resolveBankChoice = async (companyId, { bankAccountId, bank }) => {
  if (!bankAccountId) return { banco: bank, bankAccountId: null };

  const company = await Company.findById(companyId).select('bankAccounts');
  const account = company?.bankAccounts?.find(
    (acc) => acc._id.toString() === String(bankAccountId) && acc.isActive !== false,
  );
  if (!account) {
    throw new AppError('La cuenta bancaria seleccionada no existe o no está activa', 400);
  }
  return { banco: account.banco, bankAccountId: account._id };
};

/**
 * Active accounts as shown to whoever reports a payment.
 */
export const publicBankAccounts = (company) => (company?.bankAccounts || [])
  .filter((acc) => acc.isActive !== false)
  .map((acc) => ({
    _id: acc._id,
    banco: acc.banco,
    tipoCuenta: acc.tipoCuenta,
    numeroCuenta: acc.numeroCuenta,
    titular: acc.titular,
  }));
