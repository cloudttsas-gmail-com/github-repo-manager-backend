import express from 'express';
import multer from 'multer';
import { getPayments, approvePayment, rejectPayment, registerManualPayment, resendReceipt, exportSiigoExcel, editPayment } from '../controllers/payment.controller.js';
import { getOverdueStats } from '../controllers/statement.controller.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';

const router = express.Router();

// All payment routes require auth and tenant context
router.use(protect);
router.use(tenantMiddleware);

// Multer config for manual payment captures (images)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

// Company-scoped routes
router.get('/all', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.PAGOS_VIEW), 
  getPayments
);
router.get('/siigo-export',
  companyMiddleware,
  checkPermission(PERMISSIONS.PAGOS_VIEW),
  exportSiigoExcel
);
router.get('/overdue-stats',
  companyMiddleware,
  checkPermission(PERMISSIONS.PAGOS_VIEW),
  getOverdueStats
);
router.post('/manual', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.PAGOS_CREATE), 
  upload.single('capture'), 
  registerManualPayment
);
router.put('/:id/approve', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.PAGOS_APPROVE), 
  approvePayment
);
router.put('/:id/edit', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.PAGOS_EDIT), 
  editPayment
);
router.post('/:id/resend-receipt', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.PAGOS_RECEIPT), 
  resendReceipt
);

router.put('/:id/reject', 
  companyMiddleware, 
  checkPermission(PERMISSIONS.PAGOS_REJECT), 
  rejectPayment
);

export default router;
