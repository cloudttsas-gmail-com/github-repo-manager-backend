import mongoose from 'mongoose';

export const RECIPIENT_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'cancelled'];

/** One buyer of a send: the message Meta got for them and what happened to it. */
const campaignRecipientSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  contractId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  phone: String,
  status: { type: String, enum: RECIPIENT_STATUSES, default: 'queued' },
  // Why it did not go out when its turn came (opted out, weekly limit reached…)
  skipReason: String,
  waMessageId: { type: String, index: true, sparse: true },
  error: String,
  sentAt: Date,
  deliveredAt: Date,
  readAt: Date,
  repliedAt: Date,
  optedOutAt: Date,
}, { timestamps: true });

campaignRecipientSchema.index({ campaignId: 1, status: 1 });
campaignRecipientSchema.index({ tenantId: 1, companyId: 1, clientId: 1, sentAt: -1 });

export default mongoose.model('CampaignRecipient', campaignRecipientSchema);
