import express from 'express';
import {
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  changeUserPassword,
  updateProfile,
  changeMyPassword,
  uploadProfileImage,
  getSellers,
  getSystemLogs,
} from '../controllers/admin.controller.js';
import { protect, checkPermission } from '../middleware/auth.js';
import { PERMISSIONS, hasPermission } from '../config/permissions.js';
import { tenantMiddleware } from '../middleware/tenant.js';
import upload from '../middleware/upload.js';

const router = express.Router();

// All admin-user routes require auth + tenant context
router.use(protect);
router.use(tenantMiddleware);

// Superadmin only
router.get('/logs', checkPermission(PERMISSIONS.SYSTEM_LOGS), getSystemLogs);

// Other admin routes
router.get('/all', checkPermission(PERMISSIONS.EQUIPO_VIEW), getAllUsers);
// The seller list also feeds the sale, the reservation and the seller change: whoever sells needs it
router.get('/sellers', (req, res, next) => (
  hasPermission(req.user.role, PERMISSIONS.LOTES_SALE)
    ? next()
    : checkPermission(PERMISSIONS.EQUIPO_VIEW)(req, res, next)
), getSellers);
router.post('/create', checkPermission(PERMISSIONS.EQUIPO_MANAGE), createUser);
router.put('/update/:id', checkPermission(PERMISSIONS.EQUIPO_MANAGE), updateUser);
router.put('/change-password/:id', checkPermission(PERMISSIONS.EQUIPO_MANAGE), changeUserPassword);
router.delete('/delete/:id', checkPermission(PERMISSIONS.EQUIPO_MANAGE), deleteUser);

// Profile routes (any authenticated user can update their own profile)
router.put('/profile', updateProfile);
router.put('/change-my-password', changeMyPassword);
router.put('/upload-photo', upload.single('image'), uploadProfileImage);

export default router;
