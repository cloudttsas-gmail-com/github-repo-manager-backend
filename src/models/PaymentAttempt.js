import mongoose from 'mongoose';

const paymentAttemptSchema = new mongoose.Schema({
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
  contractId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contract',
    required: true,
    index: true,
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
    index: true,
  },
  quotas: [{
    quotaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quota',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    }
  }],
  amount: {
    type: Number,
    required: true,
  },
  // Tipo de pago seleccionado por el cliente/asesor al reportar:
  // TOTAL = paga el valor completo de la cuota, MINIMO = pago mínimo ofrecido,
  // OTRO = monto libre, PARCIAL = abono menor al valor de la cuota
  paymentType: {
    type: String,
    enum: {
      values: ['TOTAL', 'MINIMO', 'OTRO', 'PARCIAL'],
      message: 'Tipo de pago no válido',
    },
    default: 'TOTAL',
    index: true,
  },
  // Valor total de la cuota objetivo en el momento del reporte.
  // Trazabilidad física: permite saber qué era "el total" cuando el cliente reportó,
  // sin depender del valor actual de la cuota (puede cambiar por reestructuración).
  quotaValue: {
    type: Number,
  },
  banco: {
    type: String,
    required: true,
  },
  // The company's authorized account (Company.bankAccounts) the payment went to, when chosen
  bankAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  paymentMethod: {
    type: String,
    required: true,
  },
  fechaPago: {
    type: Date,
    required: true,
  },
  comprobante: {
    type: String, // URL/Path to the capture image in R2
  },
  observations: {
    type: String,
  },
  status: {
    type: String,
    enum: ['PENDIENTE', 'APROBADO', 'RECHAZADO'],
    default: 'PENDIENTE',
    index: true,
  },
  rejectedReason: {
    type: String,
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: {
    type: Date,
  },
  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  rejectedAt: {
    type: Date,
  },
  receiptNumber: {
    type: Number,
    index: true,
  },
}, { timestamps: true });

paymentAttemptSchema.index({ tenantId: 1, companyId: 1, status: 1 });
paymentAttemptSchema.index({ companyId: 1, receiptNumber: 1 });
paymentAttemptSchema.index({ 'quotas.quotaId': 1 });

export default mongoose.model('PaymentAttempt', paymentAttemptSchema);
