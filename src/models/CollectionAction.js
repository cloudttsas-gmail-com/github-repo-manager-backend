import mongoose from 'mongoose';

export const ACTION_CHANNELS = ['llamada', 'whatsapp', 'visita', 'correo', 'otro'];
export const ACTION_RESULTS = ['contactado', 'promesa', 'no_contesta', 'numero_errado', 'ya_pago', 'se_niega', 'otro'];

/**
 * A collection action («gestión de cobro»): someone on the team contacted a buyer (or tried to).
 * With result «promesa» it carries a payment promise; whether it was kept is worked out from the
 * approved payments when read (collectionActions.service.js), never stored.
 */
const collectionActionSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
  contractId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  channel: { type: String, enum: ACTION_CHANNELS, required: true },
  result: { type: String, enum: ACTION_RESULTS, required: true },
  notes: { type: String, maxlength: 2000 },
  promise: {
    amount: { type: Number, min: 0 },
    dueDate: Date,
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: String,
}, { timestamps: true });

collectionActionSchema.index({ tenantId: 1, companyId: 1, createdAt: -1 });
collectionActionSchema.index({ tenantId: 1, companyId: 1, 'promise.dueDate': 1 });

export default mongoose.model('CollectionAction', collectionActionSchema);
