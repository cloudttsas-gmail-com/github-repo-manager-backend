import express from 'express';
import {
  createLot, 
  getLots, 
  getLot, 
  updateLot, 
  deleteLot,
  restoreLot,
  uploadLotImages,
  getLotsPublic,
  sellLot,
  previewLotSale,
  getLotSaleDetail,
  reserveLot,
  releaseLot,
  assignLotSeller,
} from '../controllers/lot.controller.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';
import upload from '../middleware/upload.js';
import validate from '../middleware/validate.js';
import { 
  reserveLotValidation, 
  sellLotValidation, 
  releaseLotValidation,
  createLotValidation,
  updateLotValidation
} from '../validators/lot.validators.js';

const router = express.Router();

// Public route for catalog
router.get('/catalog/:companyId', getLotsPublic);

// Protected routes
router.use(protect);
router.use(tenantMiddleware);

// All lot operations require company context
router.route('/')
  .get(companyMiddleware, checkPermission(PERMISSIONS.LOTES_VIEW), getLots)
  .post(companyMiddleware, checkPermission(PERMISSIONS.LOTES_CREATE), validate(createLotValidation), createLot);

// Sale operations
router.post('/:id/sell', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.LOTES_SALE), 
  validate(sellLotValidation), 
  sellLot
);
router.post('/:id/sale-preview',
  companyMiddleware,
  checkPermission(PERMISSIONS.LOTES_SALE),
  validate(sellLotValidation),
  previewLotSale,
);
router.post('/:id/reserve', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.LOTES_SALE), 
  validate(reserveLotValidation), 
  reserveLot
);
router.post('/:id/release', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.LOTES_RELEASE), 
  validate(releaseLotValidation), 
  releaseLot
);

// Carga histórica: vincular asesor a contratos/lotes ya vendidos
router.post('/:id/assign-seller', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.LOTES_SALE), 
  assignLotSeller
);

router.get('/:id/sale-detail', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.LOTES_VIEW), 
  getLotSaleDetail
);

router.route('/:id')
  .get(checkPermission(PERMISSIONS.LOTES_VIEW), getLot)
  .put(checkPermission(PERMISSIONS.LOTES_EDIT), validate(updateLotValidation), updateLot)
  .delete(checkPermission(PERMISSIONS.LOTES_DELETE), deleteLot);

router.post('/:id/restore',
  checkPermission(PERMISSIONS.LOTES_DELETE),
  restoreLot
);

// Image upload
router.post('/:id/images', 
  checkPermission(PERMISSIONS.LOTES_PHOTOS), 
  upload.array('images', 5), 
  uploadLotImages
);

export default router;
