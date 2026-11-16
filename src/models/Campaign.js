import mongoose from 'mongoose';

export const CAMPAIGN_STATUSES = ['scheduled', 'sending', 'sent', 'cancelled'];

/**
 * A WhatsApp send («envío») with one of the project's approved templates. Recipients are picked
 * from the filters when it is created (CampaignRecipient); their template values are worked out
 * when each message goes out, so balances are current.
 */
const campaignSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  name: { type: String, required: true, maxlength: 120 },
  template: {
    name: { type: String, required: true },
    language: { type: String, required: true },
    category: { type: String, required: true },
  },
  // Values the company fills by hand for variables no table gives (none today; kept for later fields)
  values: { type: mongoose.Schema.Types.Mixed, default: {} },
  filters: { type: mongoose.Schema.Types.Mixed, default: {} },
  exclusions: {
    pendingPayment: { type: Boolean, default: true },
    openPromise: { type: Boolean, default: true },
  },
  excluded: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: CAMPAIGN_STATUSES, default: 'scheduled', index: true },
  scheduledAt: { type: Date, required: true },
  startedAt: Date,
  finishedAt: Date,
  cancelledAt: Date,
  estimatedCostUsd: Number,
  // Why it is waiting, when something outside Operix holds it (Meta paused the template)
  notice: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: String,
}, { timestamps: true });

campaignSchema.index({ status: 1, scheduledAt: 1 });
campaignSchema.index({ tenantId: 1, companyId: 1, createdAt: -1 });

export default mongoose.model('Campaign', campaignSchema);
