import mongoose from 'mongoose';

// Plan changes and legal states registered on the contract (approvals happen outside Operix)
const planHistorySchema = new mongoose.Schema({
  kind: { type: String, enum: ['extension', 'otrosi', 'recalculation', 'legal_status'], required: true },
  summary: String,
  changes: mongoose.Schema.Types.Mixed,
  reason: String,
  approvedByName: String,
  approvedAt: Date,
  documentUrl: String,
  contractSigned: Boolean,
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recordedByName: String,
  recordedAt: { type: Date, default: Date.now },
}, { _id: true });

const contractSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
    index: true,
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  client: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Client', 
    required: true,
  },
  lot: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Lot', 
    required: true,
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  contractDate: Date,
  negotiation: String, 
  appendix: String,
  totalValue: Number,
  initialQuotaPercentage: Number,
  initialQuotasCount: Number,
  installmentsCount: Number,
  installmentValue: Number,
  paymentDay: Number,
  startDate: Date,
  bonus: String,
  bonusValue: Number,
  bonusId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bonus', required: false },
  commercial: String,
  recaudadoSiigo2024: { type: Number, default: 0 },
  recaudadoSiigo2025: { type: Number, default: 0 },
  revisadoPor: String,
  juridicalRequirement: String,
  observations: String,
  excelRowId: Number,
  status: { type: String, default: 'ACTIVO' }, // Possible values: FIRMADO, PENDIENTE, DISPONIBLE, etc.
  // Payment plan rules: 'v2' for contracts sold under the project policy; older contracts have none
  // and are never recalculated automatically
  planRules: { type: String },
  planPolicy: {
    initialDeadlineDays: Number,
    minDaysBeforeFirstOrdinary: Number,
    earlyStart: Boolean,
    initialQuotaMode: { type: String, enum: ['free', 'fixed'] },
  },
  initialDeadline: Date,
  // Legal state registered by the company; no default so older contracts stay unregistered
  legalStatus: { type: String, enum: ['sin_firmar', 'firmado', 'con_otrosi'] },
  signedAt: Date,
  contractDocumentUrl: String,
  planHistory: { type: [planHistorySchema], default: undefined },
}, { timestamps: true });

contractSchema.index({ tenantId: 1, companyId: 1 });
contractSchema.index({ client: 1 });
contractSchema.index({ lot: 1 });
contractSchema.index({ sellerId: 1 });
contractSchema.index({ status: 1 });

export default mongoose.model('Contract', contractSchema);
