import mongoose from 'mongoose';

/**
 * What goes in the media header of a company's own WhatsApp template. Meta keeps only a
 * sample of it, so Operix records the source to attach when the template is sent: a file
 * the company uploaded, or a PDF Operix makes for each buyer (statement, plan, receipt).
 */
const templateMediaSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true },
  language: { type: String, required: true },
  format: { type: String, enum: ['IMAGE', 'VIDEO', 'DOCUMENT'], required: true },
  source: { type: String, enum: ['file', 'estado_cuenta', 'plan_pagos', 'recibo'], required: true },
  fileUrl: String,
  fileName: String,
}, { timestamps: true });

templateMediaSchema.index({ companyId: 1, name: 1, language: 1 }, { unique: true });

export default mongoose.model('TemplateMedia', templateMediaSchema);
