import UserAccount from '../models/UserAccount.js';
import User from '../models/User.js';
import UserCompany from '../models/UserCompany.js';
import Company from '../models/Company.js';
import mongoose from 'mongoose';
import { uploadToR2, deleteFromR2 } from '../utils/storage.js';
import AuditLog from '../models/AuditLog.js';
import { sendEmail } from '../utils/notifications.js';
import AppError from '../utils/AppError.js';
import { canAssignRole, canManageMember } from '../config/permissions.js';

/**
 * Get all users (memberships) within the current tenant.
 * Only tenant_admin can access.
 */
export const getAllUsers = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const { page = 1, limit = 10, search } = req.query;
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Filter by tenant
    const query = { tenantId };

    // Find memberships and populate account
    let memberships = await User.find(query)
      .populate({
        path: 'accountId',
        select: 'email fullName status lastLogin',
        match: search ? {
          $or: [
            { email: { $regex: search, $options: 'i' } },
            { fullName: { $regex: search, $options: 'i' } },
          ],
        } : {},
      })
      .sort({ createdAt: -1 });

    // Filter out memberships where account wasn't found (due to search mismatch)
    memberships = memberships.filter((m) => m.accountId !== null);

    const total = memberships.length;
    const paginatedMemberships = memberships.slice(skip, skip + limitNum);

    const users = paginatedMemberships.map((m) => ({
      id: m._id,
      accountId: m.accountId._id,
      email: m.accountId.email,
      fullName: m.accountId.fullName,
      role: m.role,
      status: m.status,
      accountStatus: m.accountId.status,
      lastLogin: m.accountId.lastLogin,
      createdAt: m.createdAt,
    }));

    res.json({
      success: true,
      data: { 
        users,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all users with 'vendedor' role within the current tenant.
 */
export const getSellers = async (req, res, next) => {
  try {
    const { tenantId, isTenantAdmin } = req.user;
    const { companyId } = req.query; // If provided, filter by company

    let query = { 
      tenantId, 
      role: { $in: ['vendedor', 'ejecutivo_comercial'] },
      status: 'active',
    };

    let memberships;
    // If companyId is provided AND user is not a tenant/super admin, filter by company
    // If they ARE tenant/super admin, they should see all sellers of the tenant anyway
    if (companyId && !isTenantAdmin) {
      // Find memberships linked to this company
      const companyMemberships = await UserCompany.find({ companyId, tenantId })
        .populate({
          path: 'userId',
          match: { role: { $in: ['vendedor', 'ejecutivo_comercial'] }, status: 'active' },
          populate: { path: 'accountId', select: 'fullName email' },
        });
      
      memberships = companyMemberships
        .filter((cm) => cm.userId !== null)
        .map((cm) => cm.userId);
    } else {
      memberships = await User.find(query)
        .populate({
          path: 'accountId',
          select: 'email fullName',
        });
    }

    const sellers = memberships
      .filter((m) => m.accountId !== null)
      .map((m) => ({
        id: m._id,
        fullName: m.accountId.fullName,
        email: m.accountId.email,
      }));

    res.json({
      success: true,
      data: sellers,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Whether every company in `companyIds` may be given to a member by the requester:
 * it must belong to the requester's tenant and, unless the requester owns the
 * tenant, be one of the requester's own companies.
 */
const canAssignCompanies = async (reqUser, companyIds) => {
  const ids = [...new Set(companyIds.map(String))];
  if (ids.length === 0) return true;
  if (!ids.every((id) => mongoose.isValidObjectId(id))) return false;

  const found = await Company.countDocuments({ _id: { $in: ids }, tenantId: reqUser.tenantId });
  if (found !== ids.length) return false;

  if (['superadmin', 'tenant_admin'].includes(reqUser.role)) return true;
  const own = (reqUser.companies || []).map((c) => String(c.id));
  return ids.every((id) => own.includes(id));
};

/**
 * Invite / create a new user within the current tenant.
 * If email already has a UserAccount → only create the membership.
 * If not → create UserAccount + User.
 */
export const createUser = async (req, res, next) => {
  try {
    const { fullName, email, password, role } = req.body;
    let { companyIds, companyId } = req.body;
    const { tenantId } = req.user;

    // Support both companyIds (array) and companyId (singular string)
    if (!companyIds && companyId) {
      companyIds = [companyId];
    } else if (!companyIds) {
      companyIds = [];
    }

    if (!canAssignRole(req.user.role, role)) {
      return next(new AppError('No puedes asignar ese rol', 403));
    }

    if (!Array.isArray(companyIds) || !(await canAssignCompanies(req.user, companyIds))) {
      return next(new AppError('No puedes asignar esa empresa', 403));
    }

    // Check if a membership already exists in this tenant for this email
    let account = await UserAccount.findOne({ email });

    if (account) {
      // Check if membership already exists
      const existingMembership = await User.findOne({
        accountId: account._id,
        tenantId,
      });

      if (existingMembership) {
        return next(new AppError('This email already has a membership in this team', 400));
      }
    } else {
      // Create new UserAccount
      if (!password || password.length < 8) {
        return next(new AppError('Password is required and must be at least 8 characters', 400));
      }

      account = await UserAccount.create({
        email,
        passwordHash: password,
        fullName,
      });
    }

    // Create membership
    const membership = await User.create({
      accountId: account._id,
      tenantId,
      role,
    });

    // Assign companies if provided
    if (companyIds && companyIds.length > 0 && role !== 'tenant_admin') {
      const companyRole = role; // company_admin or agent
      const assignments = companyIds.map((companyId) => ({
        userId: membership._id,
        companyId,
        tenantId,
        role: companyRole,
      }));

      await UserCompany.insertMany(assignments);
    }

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: membership._id,
          accountId: account._id,
          email: account.email,
          fullName: account.fullName,
          role: membership.role,
          status: membership.status,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update a user's membership (role, status).
 */
export const updateUser = async (req, res, next) => {
  try {
    const { role, status, fullName } = req.body;
    const membershipId = req.params.id;
    const { tenantId } = req.user;

    const membership = await User.findOne({
      _id: membershipId,
      tenantId,
    }).populate('accountId');

    if (!membership) {
      return next(new AppError('User not found in this team', 404));
    }

    // Members may edit their own name, never their own role or status
    const isSelf = membership._id.toString() === req.user.userId?.toString();
    if (isSelf && ((role && role !== membership.role) || (status && status !== membership.status))) {
      return next(new AppError('No puedes cambiar tu propio rol ni tu estado', 403));
    }

    if (!isSelf && !canManageMember(req.user.role, membership.role)) {
      return next(new AppError('No puedes modificar a este usuario', 403));
    }

    if (role && role !== membership.role && !canAssignRole(req.user.role, role)) {
      return next(new AppError('No puedes asignar ese rol', 403));
    }

    let { companyIds, companyId } = req.body;
    if (!companyIds && companyId) companyIds = [companyId];
    if (companyIds && (!Array.isArray(companyIds) || !(await canAssignCompanies(req.user, companyIds)))) {
      return next(new AppError('No puedes asignar esa empresa', 403));
    }

    if (role) membership.role = role;
    if (status) membership.status = status;
    await membership.save();

    // Handle company assignments if provided
    
    if (companyIds && companyIds.length > 0 && membership.role !== 'tenant_admin') {
      // For each companyId, check if assignment already exists
      // If not, create it
      for (const targetCompanyId of companyIds) {
        const existingAssignment = await UserCompany.findOne({
          userId: membership._id,
          companyId: targetCompanyId,
          tenantId,
        });

        if (!existingAssignment) {
          await UserCompany.create({
            userId: membership._id,
            companyId: targetCompanyId,
            tenantId,
            role: membership.role,
          });
        }
      }
    }

    // Update fullName on the account if provided
    if (fullName && membership.accountId) {
      membership.accountId.fullName = fullName;
      await membership.accountId.save({ validateBeforeSave: false });
    }

    res.json({
      success: true,
      data: {
        user: {
          id: membership._id,
          email: membership.accountId.email,
          fullName: membership.accountId.fullName,
          role: membership.role,
          status: membership.status,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Change a user's password (by tenant_admin).
 */
export const changeUserPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    const membershipId = req.params.id;
    const { tenantId } = req.user;

    if (!password || password.length < 8) {
      return next(new AppError('Password must be at least 8 characters', 400));
    }

    const membership = await User.findOne({
      _id: membershipId,
      tenantId,
    });

    if (!membership) {
      return next(new AppError('User not found in this team', 404));
    }

    if (membership._id.toString() === req.user.userId?.toString()) {
      return next(new AppError('Para cambiar tu propia contraseña usa tu perfil', 400));
    }

    if (!canManageMember(req.user.role, membership.role)) {
      return next(new AppError('No puedes cambiar la contraseña de este usuario', 403));
    }

    const account = await UserAccount.findById(membership.accountId);
    if (!account) {
      return next(new AppError('User account not found', 404));
    }

    account.passwordHash = password;
    await account.save();

    res.json({
      success: true,
      message: 'Password updated successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Remove a user's membership from this tenant.
 */
export const deleteUser = async (req, res, next) => {
  try {
    const membershipId = req.params.id;
    const { tenantId } = req.user;

    // Prevent deleting yourself
    if (membershipId === req.user.userId.toString()) {
      return next(new AppError('You cannot remove your own membership', 400));
    }

    const membership = await User.findOne({
      _id: membershipId,
      tenantId,
    });

    if (!membership) {
      return next(new AppError('User not found in this team', 404));
    }

    if (!canManageMember(req.user.role, membership.role)) {
      return next(new AppError('No puedes eliminar a este usuario', 403));
    }

    // Remove company assignments
    await UserCompany.deleteMany({ userId: membership._id, tenantId });

    // Remove membership
    await User.findByIdAndDelete(membership._id);

    res.json({
      success: true,
      message: 'User removed from team successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Superadmin: Get system audit logs
 */
export const getSystemLogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, search, action, module, tenantId } = req.query;
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    
    if (tenantId) query.tenantId = tenantId;
    if (action) query.action = action;
    if (module) query.module = module;
    
    if (search) {
      query.$or = [
        { userFullName: { $regex: search, $options: 'i' } },
        { userEmail: { $regex: search, $options: 'i' } },
        { targetId: { $regex: search, $options: 'i' } },
      ];
    }

    const total = await AuditLog.countDocuments(query);
    const logs = await AuditLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      success: true,
      data: {
        logs,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update current user's profile info (fullName).
 */
export const updateProfile = async (req, res, next) => {
  try {
    const { fullName } = req.body;
    const { accountId } = req.user;

    if (!fullName) {
      return next(new AppError('Full name is required', 400));
    }

    const account = await UserAccount.findById(accountId);
    if (!account) {
      return next(new AppError('Account not found', 404));
    }

    account.fullName = fullName;
    await account.save();

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: { fullName: account.fullName }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Change current user's password.
 */
export const changeMyPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    const { accountId } = req.user;

    if (!password || password.length < 8) {
      return next(new AppError('Password must be at least 8 characters', 400));
    }

    const account = await UserAccount.findById(accountId);
    if (!account) {
      return next(new AppError('Account not found', 404));
    }

    account.passwordHash = password;
    await account.save();

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Upload profile photo for current user.
 */
export const uploadProfileImage = async (req, res, next) => {
  try {
    const { accountId } = req.user;
    const file = req.file;

    if (!file) {
      return next(new AppError('Please provide an image', 400));
    }

    const account = await UserAccount.findById(accountId);
    if (!account) {
      return next(new AppError('Account not found', 404));
    }

    // Delete old image if exists
    if (account.profileImage) {
      try {
        await deleteFromR2(account.profileImage);
      } catch (err) {
        console.error('Error deleting old profile image:', err);
      }
    }

    // Upload new image
    const imageUrl = await uploadToR2(file, `profiles/${accountId}`);
    account.profileImage = imageUrl;
    await account.save();

    res.json({
      success: true,
      message: 'Profile photo uploaded successfully',
      data: { profileImage: imageUrl }
    });
  } catch (error) {
    next(error);
  }
};

