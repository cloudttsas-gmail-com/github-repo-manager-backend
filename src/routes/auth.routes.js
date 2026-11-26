import { Router } from 'express';
import {
  register,
  login,
  logout,
  getMe,
  selectTenant,
  refreshTokenHandler,
  verifyClientOtp,
  requestClientPasswordReset,
  resetClientPassword,
  getClientProjects,
  switchClient,
  changeClientPassword,
} from '../controllers/auth.controller.js';
import { protect } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import {
  registerValidation,
  loginValidation,
} from '../validators/auth.validators.js';

const router = Router();

// Public auth routes
router.post('/register', validate(registerValidation), register);
router.post('/login', validate(loginValidation), login);
router.post('/admin/login', validate(loginValidation), login); // alias for frontend compatibility
router.post('/verify-client-otp', verifyClientOtp);
router.post('/select-tenant', selectTenant);
router.post('/refresh', refreshTokenHandler);
router.post('/client-password/request', requestClientPasswordReset);
router.post('/client-password/reset', resetClientPassword);

// Protected auth routes
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);
router.get('/client-projects', protect, getClientProjects);
router.post('/switch-client', protect, switchClient);
router.put('/client-password', protect, changeClientPassword);

export default router;
