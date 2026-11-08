import express from 'express';
import { 
  verifyWebhook, 
  handleWebhook, 
  getChatHistory, 
  getConversations,
  getTemplates,
  createTemplate,
  deleteTemplate,
  sendMessage,
  connect,
  disconnect,
  getConfig
} from '../controllers/whatsapp.controller.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { tenantMiddleware } from '../middleware/tenant.js';
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

router.get('/config', canConfigure, getConfig);
router.post('/connect', canConfigure, connect);
router.post('/disconnect', canConfigure, disconnect);
router.get('/conversations', canFollowUp, getConversations);
router.get('/templates', canFollowUp, getTemplates);
router.post('/templates', canFollowUp, createTemplate);
router.delete('/templates/:name', canFollowUp, deleteTemplate);
router.get('/history/:clientId', canFollowUp, getChatHistory);
router.post('/send', canFollowUp, sendMessage);

export default router;
