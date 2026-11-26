import Tenant from '../models/Tenant.js';

/**
 * The inmobiliaria and the project are not the same: buyers buy a property FROM the inmobiliaria
 * (Tenant), IN one of its projects (Company). Texts that say who sells, collects or confirms use
 * the inmobiliaria; texts that say where the property is use the project.
 */

/** Name of the inmobiliaria a project belongs to; the project's when the inmobiliaria is unknown. */
export const agencyName = async (company, fallback = 'tu inmobiliaria') => {
  const id = company?.tenantId?._id || company?.tenantId;
  const tenant = id ? await Tenant.findById(id).select('name').lean() : null;
  return tenant?.name || company?.name || fallback;
};

/** «en el proyecto Marbella»; empty when the project has no name of its own. */
export const inProject = (company, agency) => {
  const name = company?.name?.trim();
  if (!name || name === agency) return '';
  return /^proyecto\b/i.test(name) ? `en ${name}` : `en el proyecto ${name}`;
};

/**
 * Who issues the buyer's documents (statement, receipt): always the inmobiliaria, with its own
 * NIT, address and phone; the project's only when the inmobiliaria has none (older data).
 * `logo` is the inmobiliaria logo (Company.logo); `projectLogo` the project's.
 */
export const issuerOf = async (company) => {
  const id = company?.tenantId?._id || company?.tenantId;
  const tenant = id ? await Tenant.findById(id).select('name nit address phone email').lean() : null;
  return {
    name: tenant?.name || company?.name || '',
    nit: tenant?.nit || company?.nit || '',
    address: tenant?.address || company?.address || '',
    phone: tenant?.phone || company?.phone || '',
    email: tenant?.email || company?.email || '',
    logo: company?.logo || '',
    projectLogo: company?.projectLogo || '',
  };
};

/**
 * Issuer and property lines of a receipt: the inmobiliaria issues it, with its logo; the property
 * is named like in the account statement (`lotLabel`) and the project separately.
 */
export const receiptParties = async (company, lot, lotLabel) => {
  const issuer = await issuerOf(company);
  return {
    companyName: issuer.name,
    companyNit: issuer.nit,
    companyAddress: issuer.address,
    companyPhone: issuer.phone,
    companyLogo: issuer.logo,
    lotInfo: lot ? lotLabel(lot) : 'N/A',
    projectName: company?.name || '',
    propertyType: lot?.propertyType || company?.propertyType || 'lotes',
  };
};
