import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A WhatsApp notice to a buyer that Operix sends on its own (plan de pagos, quota reminders,
 * rejected payment). It waits in this queue until the project's contact hours (Ley 2300) and is
 * checked again right before it goes out: opt-out, a payment already made or in review, and, for
 * collection reminders, the weekly limit.
 */
const scheduledNoticeSchema = new mongoose.Schema({
  tenantId: { type: ObjectId, ref: 'Tenant', required: true },
  companyId: { type: ObjectId, ref: 'Company', required: true },
  clientId: { type: ObjectId, ref: 'Client', required: true },
  contractId: { type: ObjectId, ref: 'Contract' },
  quotaId: { type: ObjectId, ref: 'Quota' },
  paymentAttemptId: { type: ObjectId, ref: 'PaymentAttempt' },
  notice: {
    type: String,
    enum: ['plan_pagos', 'plan_actualizado', 'cuota_por_vencer', 'cuota_vencida', 'pago_rechazado'],
    required: true,
  },
  // One notice per key: the same reminder of a quota is never queued twice
  key: { type: String, required: true, unique: true },
  // Collection reminders count for the weekly limit of Ley 2300; the other notices answer what the buyer or the team did
  collection: { type: Boolean, default: false },
  // Data fixed when the notice was queued (the reason of a rejection, the amount reported…)
  values: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['queued', 'sending', 'sent', 'skipped', 'failed'], default: 'queued' },
  skipReason: String,
  error: String,
  scheduledAt: { type: Date, default: Date.now },
  // Set when the notice is claimed, so a message whose fate is unknown still counts for the weekly limit
  sentAt: Date,
  phone: String,
  waMessageId: String,
}, { timestamps: true });

scheduledNoticeSchema.index({ status: 1, scheduledAt: 1 });
scheduledNoticeSchema.index({ tenantId: 1, companyId: 1, clientId: 1, collection: 1, sentAt: 1 });

const ScheduledNotice = mongoose.model('ScheduledNotice', scheduledNoticeSchema);

export default ScheduledNotice;
