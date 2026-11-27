import { Router } from 'express';
import multer from 'multer';
import {
  getCommissions,
  radicarComision,
  aprobarComision,
  rechazarComision,
  pagarComision,
  deshacerAprobacionComision,
  uploadCommissionSupport,
  uploadCommissionPaymentReceipt,
} from '../controllers/commission.controller.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';
import AppError from '../utils/AppError.js';

const uploadSupport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

// Payment receipt: a PDF or an image
const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new AppError('El comprobante debe ser un PDF o una imagen', 400), false);
    }
  },
});

const router = Router();

router.use(protect);
router.use(tenantMiddleware);
router.use(companyMiddleware);

router.get('/', checkPermission(PERMISSIONS.COMISIONES_VIEW), getCommissions);
router.post('/upload-support', checkPermission(PERMISSIONS.COMISIONES_RADICAR), uploadSupport.single('file'), uploadCommissionSupport);
router.post('/:id/radicar', checkPermission(PERMISSIONS.COMISIONES_RADICAR), radicarComision);
router.post('/:id/aprobar', checkPermission(PERMISSIONS.COMISIONES_APPROVE), aprobarComision);
router.post('/:id/rechazar', checkPermission(PERMISSIONS.COMISIONES_REJECT), rechazarComision);
router.post('/upload-payment-receipt', checkPermission(PERMISSIONS.COMISIONES_PAY), uploadReceipt.single('file'), uploadCommissionPaymentReceipt);
router.post('/:id/deshacer-aprobacion', checkPermission(PERMISSIONS.COMISIONES_APPROVE), deshacerAprobacionComision);
router.post('/:id/pagar', checkPermission(PERMISSIONS.COMISIONES_PAY), pagarComision);

export default router;
