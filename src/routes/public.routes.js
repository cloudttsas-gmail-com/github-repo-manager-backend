import express from 'express';
import multer from 'multer';
import { getClientInfo, reportPayment, getReceiptPDF, getCompanyAccountsPublic, getStatementPDF } from '../controllers/public.controller.js';
import { getPublicStatementExcel, getPublicStatement, sendPublicStatementEmail } from '../controllers/statement.controller.js';

const router = express.Router();

// Multer config for manual payment captures (images)
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

router.get('/accounts/:companySlug', getCompanyAccountsPublic);
router.get('/:companySlug/client/:idNumber', getClientInfo);
router.post('/report-payment', upload.single('capture'), reportPayment);

// Dynamic dynamic receipt generation
router.get('/receipt/attempt/:attemptId', getReceiptPDF);
router.get('/receipt/:quotaId', getReceiptPDF);
router.get('/statement/excel/:contractId', getPublicStatementExcel);
router.get('/statement/:contractId', getStatementPDF);

// Account statement after a verified code (cédula → code → summary)
router.post('/:companySlug/statement', getPublicStatement);
router.post('/:companySlug/statement/send-email', sendPublicStatementEmail);

// Public validation and OTP endpoints
router.post('/:companySlug/verification/send-code', async (req, res, next) => {
  try {
    const { sendOTPCodePublic } = await import('../controllers/public.controller.js');
    await sendOTPCodePublic(req, res, next);
  } catch (err) {
    next(err);
  }
});
router.post('/:companySlug/verification/verify-code', async (req, res, next) => {
  try {
    const { verifyOTPCodePublic } = await import('../controllers/public.controller.js');
    await verifyOTPCodePublic(req, res, next);
  } catch (err) {
    next(err);
  }
});
router.get('/:companySlug/client-validation/:token', async (req, res, next) => {
  try {
    const { getClientByValidationToken } = await import('../controllers/public.controller.js');
    await getClientByValidationToken(req, res, next);
  } catch (err) {
    next(err);
  }
});
router.post('/:companySlug/client-validation/confirm', async (req, res, next) => {
  try {
    const { confirmClientValidation } = await import('../controllers/public.controller.js');
    await confirmClientValidation(req, res, next);
  } catch (err) {
    next(err);
  }
});

export default router;
