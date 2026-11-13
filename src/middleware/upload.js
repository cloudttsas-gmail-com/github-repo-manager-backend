import multer from 'multer';
import AppError from '../utils/AppError.js';

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'), false);
    }
  },
});

export default upload;

// Signed contract and otrosí copies (PDF only)
export const uploadDocument = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new AppError('Solo se permiten archivos PDF', 400), false);
    }
  },
});

// Media header of a WhatsApp template: the formats and sizes Meta accepts (images up to 5 MB, checked in the service)
export const TEMPLATE_MEDIA_TYPES = {
  'image/jpeg': 'IMAGE',
  'image/png': 'IMAGE',
  'video/mp4': 'VIDEO',
  'application/pdf': 'DOCUMENT',
};
export const uploadTemplateMedia = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (TEMPLATE_MEDIA_TYPES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new AppError('Solo se permiten imágenes JPG o PNG, videos MP4 o documentos PDF', 400), false);
    }
  },
});
