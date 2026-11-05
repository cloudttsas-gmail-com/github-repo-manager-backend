import Company, { WHATSAPP_CONNECTION_FIELDS } from '../models/Company.js';
import Tenant from '../models/Tenant.js';
import AppError from '../utils/AppError.js';

/**
 * Get all companies for the current tenant.
 * If superadmin, return all tenants (enterprises) instead.
 */
export const getCompanies = async (req, res, next) => {
  try {
    // Check if superadmin (we use req.user.role from the JWT)
    if (req.user.role === 'superadmin') {
      const tenants = await Tenant.find({}).sort({ createdAt: -1 });
      
      // Map tenants to company-like objects for frontend compatibility
      const mappedAsCompanies = tenants.map((t) => ({
        _id: t._id,
        name: t.name,
        status: t.status === 'suspended' ? 'inactive' : 'active',
        // use plan as a secondary info
        rfc: `Plan: ${t.plan}`,
        propertyType: 'lotes', // default for superadmin view
      }));

      return res.json({
        success: true,
        data: { companies: mappedAsCompanies },
      });
    }

    const { tenantId } = req.user;
    const companies = await Company.find({ tenantId }).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: { companies },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get a single company by ID.
 */
export const getCompany = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const companyId = req.params.id;

    let company = await Company.findOne({ _id: companyId, tenantId });

    // Fallback for superadmin: if they selected a tenant instead of a company
    if (!company && req.user.role === 'superadmin') {
      company = await Company.findOne({ tenantId }).sort({ createdAt: 1 });
    }

    if (!company) {
      return next(new AppError('Company not found', 404));
    }

    if (!company.slug) {
      // Basic slugification
      const baseSlug = company.name
        .toLowerCase()
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      
      // Attempt to save (if unique constraint fails, it will throw, which is fine for now)
      company.slug = baseSlug || company._id.toString();
      await company.save();
    }

    res.json({
      success: true,
      data: { company },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a new company within the tenant.
 */
export const createCompany = async (req, res, next) => {
  try {
    const { name, rfc, nit, address, phone, email, propertyType } = req.body;
    const { tenantId } = req.user;

    if (!name) {
      return next(new AppError('Company name is required', 400));
    }

    // Basic slugification
    const baseSlug = name
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const company = await Company.create({
      tenantId,
      name,
      slug: `${baseSlug}-${Date.now().toString().slice(-4)}`,
      rfc,
      nit,
      address,
      phone,
      email,
      ...(propertyType && { propertyType }),
    });

    res.status(201).json({
      success: true,
      data: { company },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update a company.
 */
export const updateCompany = async (req, res, next) => {
  try {
    const { name, rfc, status, nit, address, phone, email, bankInfo, integrations, bankAccounts, logo, projectLogo, propertyType } = req.body;
    const { tenantId } = req.user;
    const companyId = req.params.id;

    const company = await Company.findOne({ _id: companyId, tenantId });

    if (!company) {
      return next(new AppError('Company not found', 404));
    }

    if (name) company.name = name;
    if (rfc !== undefined) company.rfc = rfc;
    if (status) company.status = status;
    if (nit !== undefined) company.nit = nit;
    if (address !== undefined) company.address = address;
    if (phone !== undefined) company.phone = phone;
    if (email !== undefined) company.email = email;
    if (bankInfo !== undefined) company.bankInfo = bankInfo;
    if (integrations !== undefined) {
      // The WhatsApp connection is managed by the Meta flow: keep it as stored
      const current = company.integrations?.toObject ? company.integrations.toObject() : (company.integrations || {});
      const next = { ...current, ...integrations };
      WHATSAPP_CONNECTION_FIELDS.forEach((field) => { next[field] = current[field]; });
      delete next.whatsappConnected;
      company.integrations = next;
    }
    if (bankAccounts !== undefined) company.bankAccounts = bankAccounts;
    if (logo !== undefined) company.logo = logo;
    if (projectLogo !== undefined) company.projectLogo = projectLogo;
    if (propertyType !== undefined) company.propertyType = propertyType;

    await company.save();

    res.json({
      success: true,
      data: { company },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete (deactivate) a company.
 */
export const deleteCompany = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const companyId = req.params.id;

    const company = await Company.findOne({ _id: companyId, tenantId });

    if (!company) {
      return next(new AppError('Company not found', 404));
    }

    company.status = 'inactive';
    await company.save();

    res.json({
      success: true,
      message: 'Company deactivated successfully',
    });
  } catch (error) {
    next(error);
  }
};

export const getCompanyPublic = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id).select('name status propertyType');
    if (!company) {
      return res.status(404).json({ success: false, message: 'Inmobiliaria no encontrada' });
    }
    res.json({ success: true, data: company });
  } catch (error) {
    next(error);
  }
};
