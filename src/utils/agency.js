import Tenant from '../models/Tenant.js';

/**
 * The inmobiliaria and the project are not the same: buyers buy a property FROM the inmobiliaria
 * (Tenant), IN one of its projects (Company). Texts that say who sells, collects or confirms use
 * the inmobiliaria; texts that say where the property is use the project.
 */

/** Name of the inmobiliaria a project belongs to; the project's when the inmobiliaria is unknown. */
export const agencyName = async (company, fallback = 'su inmobiliaria') => {
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
