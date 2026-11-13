import express from 'express';
import { 
  verifyWebhook, 
  handleWebhook, 
  getChatHistory, 
  getConversations,
  getTemplates,
  createDefaultTemplates,
  createTemplate,
  getTemplateFields,
  deleteTemplate,
  sendMessage,
  connect,
  disconnect,
  getConfig
} from '../controllers/whatsapp.controller.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import { companyMiddleware } from '../middleware/company.js';
import { PERMISSIONS } from '../config/permissions.js';
import AppError from '../utils/AppError.js';

const router = express.Router();

// Public Webhook routes (called by Meta)
router.get('/webhook', verifyWebhook);
router.post('/webhook', handleWebhook);

// Protected routes (called by CRM)
router.use(protect);
router.use(tenantMiddleware);

// The buyer's portal account belongs to the same tenant, but never uses the company's WhatsApp
router.use((req, res, next) => (
  req.user.role === 'cliente'
    ? next(new AppError('No tienes permiso para realizar esta acción', 403))
    : next()
));

// Connecting the company's number is configuration; chats and templates are collection follow-up
const canConfigure = checkPermission(PERMISSIONS.CONFIG_TENANT);
const canFollowUp = checkPermission(PERMISSIONS.CARTERA_FOLLOWUP);

// Everything but the public signup values acts on the active project (`?companyId=`)
router.get('/config', canConfigure, getConfig);
router.post('/connect', canConfigure, companyMiddleware, connect);
router.post('/templates/defaults', canConfigure, companyMiddleware, createDefaultTemplates);
router.post('/disconnect', canConfigure, companyMiddleware, disconnect);
router.get('/conversations', canFollowUp, companyMiddleware, getConversations);
router.get('/templates', canFollowUp, companyMiddleware, getTemplates);
router.get('/template-fields', canFollowUp, companyMiddleware, getTemplateFields);
router.post('/templates', canFollowUp, companyMiddleware, createTemplate);
router.delete('/templates/:name', canFollowUp, companyMiddleware, deleteTemplate);
router.get('/history/:clientId', canFollowUp, companyMiddleware, getChatHistory);
router.post('/send', canFollowUp, companyMiddleware, sendMessage);

export default router;
