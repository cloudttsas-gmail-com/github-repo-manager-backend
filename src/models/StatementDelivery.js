import mongoose from 'mongoose';

/**
 * Each time an account statement is sent, shared or looked up, so the company
 * can see what the buyer received and when.
 */
const statementDeliverySchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  contractId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  // whatsapp and email are sends; link is a copied link; view, pdf and excel are lookups
  channel: { type: String, enum: ['whatsapp', 'email', 'link', 'view', 'pdf', 'excel'], required: true },
  source: { type: String, enum: ['panel', 'portal', 'public'], required: true },
  // sent; disabled when notifications are off (nothing left Operix); failed when the provider refused it
  status: { type: String, enum: ['sent', 'disabled', 'failed', 'done'], default: 'done' },
  destination: String,
  error: String,
  sentBy: {
    userId: { type: mongoose.Schema.Types.ObjectId },
    name: String,
  },
  // What the buyer saw, to answer "what did they receive"
  snapshot: {
    balance: Number,
    overdueCount: Number,
    overdueAmount: Number,
    daysOverdue: Number,
  },
}, { timestamps: true });

statementDeliverySchema.index({ tenantId: 1, companyId: 1, clientId: 1, createdAt: -1 });

export default mongoose.model('StatementDelivery', statementDeliverySchema);
