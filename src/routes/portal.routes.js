import express from 'express';
import multer from 'multer';
import { 
  getPortalHome,
  getPortalSummary, 
  getMyLots, 
  getMyPayments,
  getPortalBankAccounts,
  reportPortalPayment,
  getPortalReceiptPDF,
  getPortalContractDetail,
  getPortalStatementPDF
} from '../controllers/portal.controller.js';
import { protect, restrictTo } from '../middleware/auth.js';
import { tenantMiddleware } from '../middleware/tenant.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDF files are allowed'), false);
    }
  },
});

// All portal routes require authentication
router.use(protect);

// Ensure only clients can access these specific portal routes
router.use(restrictTo('cliente'));

// Apply tenant context if needed (usually tenantId is in the user object)
router.use(tenantMiddleware);

router.get('/home', getPortalHome);
router.get('/summary', getPortalSummary);
router.get('/lots', getMyLots);
router.get('/payments', getMyPayments);
router.get('/bank-accounts', getPortalBankAccounts);
router.post('/report-payment', upload.single('comprobante'), reportPortalPayment);
router.get('/receipt/:paymentId', getPortalReceiptPDF);
router.get('/contract/:id', getPortalContractDetail);
router.get('/statement/:contractId', getPortalStatementPDF);

export default router;
