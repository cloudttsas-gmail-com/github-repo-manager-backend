import mongoose from 'mongoose';

/**
 * One version of a WhatsApp template of a project, as Operix sent it to Meta (created, edited or
 * restored) or as it was found in Meta before its first change from Operix (`found`). Meta keeps
 * no history, so this is the only record of how a template looked before and who changed it.
 */
const templateVersionSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  templateId: String,
  name: { type: String, required: true },
  language: { type: String, required: true },
  category: String,
  parameterFormat: String,
  components: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // What a media header attached at that time (see TemplateMedia)
  media: {
    source: String,
    fileUrl: String,
    fileName: String,
  },
  action: { type: String, enum: ['found', 'created', 'edited', 'restored'], required: true },
  restoredFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'TemplateVersion' },
  // Who did it; empty for `found` and for Operix itself (default templates on connecting)
  by: {
    userId: { type: mongoose.Schema.Types.ObjectId },
    name: String,
    role: String,
  },
}, { timestamps: true });

templateVersionSchema.index({ companyId: 1, name: 1, language: 1, createdAt: -1 });

export default mongoose.model('TemplateVersion', templateVersionSchema);
