import Bank from '../models/Bank.js';
import XLSX from 'xlsx';

/**
 * Get all banks (Global list)
 */
export const getBanks = async (req, res, next) => {
  try {
    let { page = 1, limit = 100, search, sortBy = 'socialDenomination', sortOrder = 'asc', companyId: queryCompanyId, companySlug, adminView } = req.query;
    
    let tenantId;
    let companyId = queryCompanyId;
    
    // Parse token optionally since GET / is public but also called by admin dashboard
    let token;
    if (req.cookies && req.cookies.accessToken) {
      token = req.cookies.accessToken;
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
      try {
        const { verifyAccessToken } = await import('../utils/jwt.js');
        const decoded = verifyAccessToken(token);
        tenantId = decoded.tenantId;
        if (!companyId && decoded.companies && decoded.companies.length > 0) {
          const first = decoded.companies[0];
          companyId = first?.companyId || first?._id || first;
        }
        req.user = decoded;
      } catch (err) {
        // Ignore token errors for public fallback
      }
    }

    // Support public requests or requests without full middleware context. The public
    // payment page names its company by slug: it wins over a panel session open in the
    // same browser, which used to make this list fail
    if (companySlug || (!tenantId && queryCompanyId)) {
      const { default: Company } = await import('../models/Company.js');
      let company;
      
      if (companySlug) {
        company = await Company.findOne({ slug: companySlug }).select('tenantId _id');
      } else {
        company = await Company.findById(queryCompanyId).select('tenantId _id');
      }

      if (company) {
        tenantId = company.tenantId;
        companyId = company._id;
      }
    }

    let query = { 
      $or: [
        { tenantId: null }, // Global banks
        { tenantId: tenantId || null, companyId: companyId || null }, // Company specific banks
      ],
    };

    // If it's a public client payment report or filterActive is requested, only show active banks
    const isPublic = !req.user;
    const shouldFilterActive = isPublic || adminView !== 'true';

    if (shouldFilterActive) {
      query.isActive = true;
      if (companyId) {
        query.disabledByCompanies = { $ne: companyId };
      }
    }

    if (search) {
      const searchFilter = {
        $or: [
          { socialDenomination: { $regex: search, $options: 'i' } },
          { acronym: { $regex: search, $options: 'i' } },
          { code: { $regex: search, $options: 'i' } },
        ],
      };
      
      // Combine query with search
      query = { $and: [query, searchFilter] };
    }

    const sort = {};
    if (sortBy) {
      sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.socialDenomination = 1;
    }

    const total = await Bank.countDocuments(query);
    const banks = await Bank.find(query)
      .sort(sort)
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit));

    // Decorate for admin dashboard so they see the status for their active company
    const decoratedBanks = banks.map(bank => {
      const bankObj = bank.toObject();
      const isDisabled = companyId && bank.disabledByCompanies && bank.disabledByCompanies.some(
        id => id.toString() === companyId.toString()
      );
      bankObj.isActiveForCompany = bank.isActive && !isDisabled;
      return bankObj;
    });

    res.status(200).json({
      success: true,
      data: {
        banks: decoratedBanks,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a single bank (Super Admin only)
 */
export const createBank = async (req, res, next) => {
  try {
    const { tenantId, companyId } = req.user || {};
    
    const bankData = {
      ...req.body,
      tenantId: tenantId || undefined,
      companyId: companyId || undefined,
    };

    const bank = await Bank.create(bankData);

    res.status(201).json({
      success: true,
      data: bank,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Bulk create banks (Super Admin only)
 */
export const bulkCreateBanks = async (req, res, next) => {
  try {
    const { banks } = req.body;
    const { tenantId, companyId, role } = req.user || {};

    if (!Array.isArray(banks)) {
      return res.status(400).json({
        success: false,
        message: 'Data must be an array of banks',
      });
    }

    // Banks always belong to the requester's company; only a superadmin may load
    // banks for another scope (or global ones, with no tenant).
    const scopedBanks = banks.map((bank) => (role === 'superadmin'
      ? bank
      : { ...bank, tenantId, companyId, disabledByCompanies: [] }));

    const result = await Bank.insertMany(scopedBanks, { ordered: false });

    res.status(201).json({
      success: true,
      data: result,
      count: result.length,
    });
  } catch (error) {
    if (error.name === 'BulkWriteError' || error.result) {
      return res.status(201).json({
        success: true,
        data: error.result.result.insertedIds,
        count: error.result.result.nInserted,
        message: 'Some records were inserted, but some failed (likely duplicates)',
        errors: error.writeErrors?.length || 0,
      });
    }
    next(error);
  }
};

export const updateBank = async (req, res, next) => {
  try {
    const { tenantId, companyId: userCompanyId, role } = req.user || {};
    const companyId = req.query.companyId || userCompanyId;
    const bankId = req.params.id;

    const bank = await Bank.findById(bankId);
    if (!bank) {
      return res.status(404).json({ success: false, message: 'Banco no encontrado' });
    }

    // Safety check: Non-superadmins cannot modify other company's custom banks
    if (role !== 'superadmin' && bank.tenantId && (bank.tenantId.toString() !== tenantId?.toString() || bank.companyId?.toString() !== companyId?.toString())) {
      return res.status(403).json({ success: false, message: 'No tienes permiso para gestionar este banco' });
    }

    // If it's a global bank and user is not superadmin, allow toggling company active status
    if (!bank.tenantId && role !== 'superadmin') {
      const { isActive } = req.body;
      if (isActive !== undefined && companyId) {
        if (!bank.disabledByCompanies) {
          bank.disabledByCompanies = [];
        }
        if (isActive === false) {
          if (!bank.disabledByCompanies.some(id => id.toString() === companyId.toString())) {
            bank.disabledByCompanies.push(companyId);
          }
        } else {
          bank.disabledByCompanies = bank.disabledByCompanies.filter(
            id => id.toString() !== companyId.toString()
          );
        }
        await bank.save();
        
        // Return a decorated bank object
        const bankObj = bank.toObject();
        bankObj.isActiveForCompany = isActive;
        return res.status(200).json({ success: true, data: bankObj });
      }
      return res.status(403).json({ success: false, message: 'No puedes gestionar bancos del sistema' });
    }

    // Otherwise, normal update of company specific bank; its scope cannot be moved
    const changes = { ...req.body };
    delete changes.tenantId;
    delete changes.companyId;
    delete changes.disabledByCompanies;
    const updatedBank = await Bank.findByIdAndUpdate(bankId, role === 'superadmin' ? req.body : changes, {
      new: true,
      runValidators: true,
    });

    res.status(200).json({
      success: true,
      data: updatedBank,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete bank
 */
export const deleteBank = async (req, res, next) => {
  try {
    const { tenantId, companyId: userCompanyId, role } = req.user || {};
    const companyId = req.query.companyId || userCompanyId;
    const bankId = req.params.id;

    const bank = await Bank.findById(bankId);
    if (!bank) {
      return res.status(404).json({ success: false, message: 'Banco no encontrado' });
    }

    // Protection: Seed banks (tenantId null) cannot be deleted permanently
    const isSeedBank = !bank.tenantId;

    if (isSeedBank && role !== 'superadmin') {
      if (companyId) {
        if (!bank.disabledByCompanies) {
          bank.disabledByCompanies = [];
        }
        if (!bank.disabledByCompanies.some(id => id.toString() === companyId.toString())) {
          bank.disabledByCompanies.push(companyId);
          await bank.save();
        }
        return res.status(200).json({
          success: true,
          message: 'Banco desactivado para este proyecto',
        });
      }
      return res.status(403).json({ success: false, message: 'No puedes gestionar bancos del sistema' });
    }

    // Non-superadmins can only manage their own company banks
    if (role !== 'superadmin' && (bank.tenantId?.toString() !== tenantId?.toString() || bank.companyId?.toString() !== companyId?.toString())) {
      return res.status(403).json({ success: false, message: 'No tienes permiso para gestionar este banco' });
    }

    // Check if used in payments
    const { default: Payment } = await import('../models/Payment.js');
    const isUsed = await Payment.exists({ 
      banco: bank.acronym, 
      tenantId: bank.tenantId || tenantId,
    });

    if (isUsed || isSeedBank || role === 'superadmin') {
      bank.isActive = false;
      await bank.save();
      return res.status(200).json({
        success: true,
        message: isUsed 
          ? 'El banco tiene pagos asociados y ha sido desactivado' 
          : 'Banco desactivado correctamente',
      });
    }

    // If not used and not seed bank, and not superadmin
    await Bank.findByIdAndDelete(bankId);

    res.status(200).json({
      success: true,
      message: 'Banco eliminado correctamente',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Parses an Excel file and imports banks (Global)
 */
export const importBanksExcel = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No se subió ningún archivo' });
    }

    // Read workbook from buffer
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    // Convert to JSON
    const data = XLSX.utils.sheet_to_json(sheet);

    if (data.length === 0) {
      return res.status(400).json({ success: false, message: 'El archivo está vacío' });
    }

    const summary = {
      total: data.length,
      created: 0,
      skipped: 0,
      errors: [],
    };

    // Mapping helper
    const getVal = (row, ...aliases) => {
      for (const alias of aliases) {
        if (row[alias] !== undefined) return row[alias];
        // Case-insensitive lookup
        const key = Object.keys(row).find((k) => k.toLowerCase().trim() === alias.toLowerCase().trim());
        if (key) return row[key];
      }
      return undefined;
    };

    const { tenantId, companyId, role } = req.user || {};
    const banksToInsert = [];

    for (const row of data) {
      const type = getVal(row, 'TIPO', 'type');
      const code = getVal(row, 'CÓDIGO', 'CODIGO', 'code')?.toString().trim();
      const competentDelegation = getVal(row, 'DELEGATURA COMPETENTE', 'competentDelegation');
      const socialDenomination = getVal(row, 'DENOMINACIÓN SOCIAL', 'DENOMINACION SOCIAL', 'socialDenomination');
      const acronym = getVal(row, 'SIGLA', 'acronym', 'sigla');

      if (!acronym || !socialDenomination || !code) {
        summary.skipped++;
        continue;
      }

      banksToInsert.push({
        type: type || 'N/A',
        code,
        competentDelegation,
        socialDenomination,
        acronym,
        tenantId: role === 'superadmin' ? undefined : tenantId,
        companyId: role === 'superadmin' ? undefined : companyId,
      });
    }

    // Insert with ordered false to avoid stopping on duplicates
    try {
      if (banksToInsert.length > 0) {
        const result = await Bank.insertMany(banksToInsert, { ordered: false });
        summary.created = result.length;
      }
    } catch (err) {
      if (err.name === 'BulkWriteError' || err.result) {
        summary.created = err.result.nInserted;
        summary.skipped += (banksToInsert.length - err.result.nInserted);
      } else {
        throw err;
      }
    }

    res.status(200).json({
      success: true,
      message: 'Procesamiento de bancos completado',
      summary,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Enable or disable all banks for a specific company
 */
export const toggleAllBanks = async (req, res, next) => {
  try {
    const { tenantId, companyId: userCompanyId, role } = req.user || {};
    const companyId = req.query.companyId || userCompanyId;
    const { action } = req.body; // 'enable' or 'disable'

    if (!companyId) {
      return res.status(400).json({ success: false, message: 'ID de compañía es requerido' });
    }

    if (action === 'disable') {
      // 1. Disable all global banks for this company by adding companyId to disabledByCompanies
      await Bank.updateMany(
        { tenantId: null },
        { $addToSet: { disabledByCompanies: companyId } }
      );

      // 2. Disable all company-specific banks
      await Bank.updateMany(
        { tenantId: tenantId || null, companyId },
        { isActive: false }
      );

      return res.status(200).json({
        success: true,
        message: 'Todos los bancos han sido ocultados para este proyecto',
      });
    } else if (action === 'enable') {
      // 1. Enable all global banks for this company by pulling companyId from disabledByCompanies
      await Bank.updateMany(
        { tenantId: null },
        { $pull: { disabledByCompanies: companyId } }
      );

      // 2. Enable all company-specific banks
      await Bank.updateMany(
        { tenantId: tenantId || null, companyId },
        { isActive: true }
      );

      return res.status(200).json({
        success: true,
        message: 'Todos los bancos han sido habilitados para este proyecto',
      });
    } else {
      return res.status(400).json({ success: false, message: 'Acción no válida' });
    }
  } catch (error) {
    next(error);
  }
};
