import express from 'express';
import {
  getCompanies,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
  getCompanyPublic,
} from '../controllers/company.controller.js';
import { protect, restrictTo, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';

const router = express.Router();

// Public routes
router.get('/public/:id', getCompanyPublic);

// All company routes require auth + tenant context
router.use(protect);
router.use(tenantMiddleware);

// Only tenant_admin creates and deletes projects; whoever configures the tenant edits its own projects
router.get('/', getCompanies);
router.get('/:id', getCompany);
router.post('/', restrictTo('tenant_admin'), createCompany);
router.put('/:id', checkPermission(PERMISSIONS.CONFIG_TENANT), updateCompany);
router.delete('/:id', restrictTo('tenant_admin'), deleteCompany);

export default router;
