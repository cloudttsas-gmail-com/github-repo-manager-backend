import mongoose from 'mongoose';

// One step in the life of a billing: who did what and when, with the note or reason given
const historyEntrySchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['FILED', 'APPROVED', 'REJECTED', 'APPROVAL_REVERTED', 'PAID'],
    required: true,
  },
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  note: String,
}, { _id: false });

const installmentSchema = new mongoose.Schema({
  milestoneKey: {
    type: String,
    enum: ['INITIAL_QUOTA', 'QUOTA_NUMBER'],
    required: true,
  },
  quotaNumber: Number,
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  status: {
    type: String,
    enum: ['PENDING', 'AVAILABLE', 'FILED', 'APPROVED', 'PAID', 'REJECTED'],
    default: 'PENDING',
  },
  filedAt: Date,
  filedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  billingNumber: Number,
  attachmentUrl: String,
  invoiceUrl: String,
  socialSecurityUrl: String,
  rutUrl: String,
  bankCertUrl: String,
  stampedAt: Date,
  filingSeal: {
    radNumber: String,
    stampedAt: Date,
    sellerName: String,
    sellerDocument: String,
    amount: Number,
    milestoneLabel: String,
    statusText: { type: String, default: 'RECIBIDO' },
  },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  approvalNote: String,
  paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  paidAt: Date,
  // What the payer reports: the day the money was sent, how or from which bank, and an optional receipt
  paymentDate: Date,
  paymentMethod: String,
  paymentReceiptUrl: String,
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: Date,
  rejectedReason: String,
  history: [historyEntrySchema],
}, { _id: false });

const commissionSchema = new mongoose.Schema({
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
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CommissionPlan',
  },
  contractId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contract',
    required: true,
    index: true,
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  initialQuotaPercentage: Number,
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  installments: [installmentSchema],
}, { timestamps: true });

commissionSchema.index({ companyId: 1, sellerId: 1 });
commissionSchema.index({ companyId: 1, 'installments.status': 1 });

export default mongoose.model('Commission', commissionSchema);
