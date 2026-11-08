import express from 'express';
import {
  updateLegalStatus,
  createInitialExtension,
  createOtrosi,
} from '../controllers/contract.controller.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';
import { uploadDocument } from '../middleware/upload.js';

const router = express.Router();

router.use(protect);
router.use(tenantMiddleware);

// Legal state and plan changes registered on a contract (approved outside Operix)
router.put('/:id/legal-status',
  uploadDocument.single('document'),
  companyMiddleware,
  checkPermission(PERMISSIONS.CONTRATOS_LEGAL),
  updateLegalStatus,
);
router.post('/:id/initial-extension',
  companyMiddleware,
  checkPermission(PERMISSIONS.CONTRATOS_LEGAL),
  createInitialExtension,
);
router.post('/:id/otrosi',
  uploadDocument.single('document'),
  companyMiddleware,
  checkPermission(PERMISSIONS.CONTRATOS_LEGAL),
  createOtrosi,
);

export default router;
