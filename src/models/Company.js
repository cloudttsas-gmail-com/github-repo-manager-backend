import mongoose from 'mongoose';

const companySchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: [true, 'Tenant is required'],
    index: true,
  },
  name: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true,
    maxlength: [150, 'Name cannot exceed 150 characters'],
  },
  slug: {
    type: String,
    trim: true,
    lowercase: true,
    unique: true,
  },
  rfc: {
    type: String,
    trim: true,
    maxlength: [20, 'RFC cannot exceed 20 characters'],
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
  },
  nit: {
    type: String,
    trim: true,
  },
  address: {
    type: String,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
  },
  bankInfo: {
    banco: String,
    tipoCuenta: String,
    numeroCuenta: String,
  },
  bankAccounts: [{
    banco: { type: String, required: true },
    tipoCuenta: { type: String, required: true },
    numeroCuenta: { type: String, required: true },
    titular: { type: String },
    qrCode: { type: String },
    isActive: { type: Boolean, default: true },
    accountingAccount: { type: String, default: '' }
  }],
  integrations: {
    whatsappEnabled: { type: Boolean, default: false },
    whatsappApiKey: String,
    whatsappWabaId: String,
    whatsappPhoneId: String,
    whatsappAccessToken: String,
    whatsappDisplayPhone: String,
    whatsappVerifiedName: String,
    whatsappConnectedAt: Date,
    daptaEnabled: { type: Boolean, default: false },
    daptaApiKey: String,
  },
  logo: {
    type: String,
  },
  projectLogo: {
    type: String,
  },
  propertyType: {
    type: String,
    enum: ['lotes', 'casas', 'apartamentos', 'locales'],
    default: 'lotes',
  },
}, {
  timestamps: true,
});

companySchema.index({ tenantId: 1, status: 1 });

// Set only by the Meta connection flow (whatsapp.controller); never sent to clients
export const WHATSAPP_CONNECTION_FIELDS = [
  'whatsappApiKey', 'whatsappAccessToken', 'whatsappWabaId', 'whatsappPhoneId',
  'whatsappDisplayPhone', 'whatsappVerifiedName',
];
const SECRET_INTEGRATION_FIELDS = ['whatsappApiKey', 'whatsappAccessToken'];

// A schema transform (not a toJSON method) also applies when a company is populated into another document
companySchema.set('toJSON', {
  transform: (doc, obj) => {
    delete obj.__v;
    if (obj.integrations) {
      obj.integrations.whatsappConnected = Boolean(obj.integrations.whatsappAccessToken);
      SECRET_INTEGRATION_FIELDS.forEach((field) => delete obj.integrations[field]);
    }
    return obj;
  },
});

const Company = mongoose.model('Company', companySchema);

export default Company;
