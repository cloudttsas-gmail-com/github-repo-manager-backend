import express from 'express';
import { getPolicy, updatePolicy } from '../controllers/contract.controller.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';

const router = express.Router();

router.use(protect);
router.use(tenantMiddleware);
router.use(companyMiddleware);

// Payment plan policy of the active company (project)
router.get('/policy', checkPermission(PERMISSIONS.LOTES_VIEW), getPolicy);
router.put('/policy', checkPermission(PERMISSIONS.CONFIG_TENANT), updatePolicy);

export default router;
