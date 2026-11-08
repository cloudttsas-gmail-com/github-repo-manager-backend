import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';

import authRoutes from './routes/auth.routes.js';
import categoryRoutes from './routes/category.routes.js';
import transactionRoutes from './routes/transaction.routes.js';
import importRoutes from './routes/import.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import clientRoutes from './routes/client.routes.js';
import lotRoutes from './routes/lot.routes.js';
import adminRoutes from './routes/admin.routes.js';
import companyRoutes from './routes/company.routes.js';
import tenantRoutes from './routes/tenant.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import publicRoutes from './routes/public.routes.js';
import bankRoutes from './routes/bank.routes.js';
import aiChatRoutes from './routes/aiChat.routes.js';
import portalRoutes from './routes/portal.routes.js';
import limitRoutes from './routes/limit.routes.js';
import whatsappRoutes from './routes/whatsapp.routes.js';
import reportRoutes from './routes/report.routes.js';
import auditRoutes from './routes/audit.routes.js';
import bonusRoutes from './routes/bonus.routes.js';
import paymentScheduleRoutes from './routes/paymentSchedule.routes.js';
import paymentPlanRoutes from './routes/paymentPlan.routes.js';
import contractRoutes from './routes/contract.routes.js';
import aiAgentToolRoutes from './routes/ai.routes.js';
import knowledgeRoutes from './routes/knowledge.routes.js';
import escalationRoutes from './routes/escalation.routes.js';
import commissionPlanRoutes from './routes/commissionPlan.routes.js';
import commissionRoutes from './routes/commission.routes.js';
import errorHandler from './middleware/errorHandler.js';
import connectDB from './config/database.js';

const app = express();
app.set('trust proxy', 1);

// Security headers & CORS Configuration
const frontendUrl = process.env.FRONTEND_URL;
const extraOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : [];

const allowedOrigins = [
  frontendUrl,
  'http://localhost:3002',
  'http://127.0.0.1:3002',
  'http://192.168.1.106:3002', 
  ...extraOrigins
].filter(Boolean);

// Extract origins for CSP (e.g., https://example.com)
const cspOrigins = allowedOrigins.map(url => {
  try { return new URL(url).origin; } catch (e) { return url; }
});

const isDev = process.env.NODE_ENV !== 'production';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", ...cspOrigins],
      connectSrc: ["'self'", "https:", ...cspOrigins, ...(isDev ? ["ws://localhost:*", "http://localhost:*"] : [])],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      ...(isDev ? {} : { upgradeInsecureRequests: [] })
    },
  },
  frameguard: { action: 'deny' },
  hsts: isDev ? false : {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Ensure Database Connection (Serverless robustness)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    next(err);
  }
});

// CORS
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, isDev); // Allow all in dev, strict in prod
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { success: false, message: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Auth endpoints rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { success: false, message: 'Too many authentication attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Body parsing
// Keep the raw bytes of Meta webhook calls: their signature is computed over the exact body.
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith('/api/whatsapp/webhook')) req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(mongoSanitize());

// Cookies
app.use(cookieParser());

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    success: true, 
    message: 'Server is running',
    version: '1.0.0', // Build version
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/import', importRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/lots', lotRoutes);
app.use('/api/admin-users', adminRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/banks', bankRoutes);
app.use('/api/ai', aiAgentToolRoutes);
app.use('/api/ai', aiChatRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/escalations', escalationRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/limits', limitRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/bonuses', bonusRoutes);
app.use('/api/commission-plans', commissionPlanRoutes);
app.use('/api/commissions', commissionRoutes);
app.use('/api/payment-schedule', paymentScheduleRoutes);
app.use('/api/payment-plan', paymentPlanRoutes);
app.use('/api/contracts', contractRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Error handler
app.use(errorHandler);

export default app;
