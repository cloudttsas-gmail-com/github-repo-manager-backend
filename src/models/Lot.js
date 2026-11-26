import mongoose from 'mongoose';
import { buildUnitKey } from '../utils/propertyIdentifier.js';

const lotSchema = new mongoose.Schema({
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
  stage: {
    type: String,
    trim: true,
  },
  manzana: {
    type: String,
    trim: true,
  },
  nomenclature: {
    type: String,
    trim: true,
  },
  lotNumber: {
    type: String,
    trim: true,
  },
  reference: {
    type: String,
    trim: true,
  },
  area: {
    type: Number,
    min: [0.01, 'El área debe ser mayor a 0'],
  },
  price: {
    type: Number,
  },
  images: [{
    type: String,
  }],
  status: {
    type: String,
    enum: ['disponible', 'apartado', 'separado', 'vendido'],
    default: 'disponible',
  },
  maxInstallments: {
    type: Number,
    default: 24,
  },
  reservedAt: Date,
  expiresAt: Date,
  reservationBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
  },

  reservationDetails: {
    type: String,
  },
  // What the buyer paid to hold a 'separado' lot; the sale discounts it from the initial quota
  reservationAmount: {
    type: Number,
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  propertyType: {
    type: String,
    enum: ['lotes', 'casas', 'apartamentos', 'locales'],
    default: 'lotes',
  },
  tower: {
    type: String,
    trim: true,
  },
  floor: {
    type: String,
    trim: true,
  },
  unitKey: {
    type: String,
    trim: true,
  },
  excelRowId: Number,
  isDeleted: {
    type: Boolean,
    default: false,
    index: true,
  },
  deletedAt: {
    type: Date,
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  deletedReason: {
    type: String,
    trim: true,
  },
}, { timestamps: true });

lotSchema.index({ tenantId: 1, companyId: 1 });
lotSchema.index({ tenantId: 1, companyId: 1, isDeleted: 1 });
lotSchema.index({ status: 1 });
lotSchema.index({ status: 1, isDeleted: 1 });
lotSchema.index({ reference: 1 });
lotSchema.index({ sellerId: 1 });
lotSchema.index({ companyId: 1, status: 1 });
lotSchema.index(
  { companyId: 1, unitKey: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, unitKey: { $type: 'string' } } },
);

lotSchema.pre('validate', function setUnitKey(next) {
  this.unitKey = buildUnitKey(this.propertyType, {
    stage: this.stage,
    manzana: this.manzana,
    tower: this.tower,
    floor: this.floor,
    lotNumber: this.lotNumber,
  });
  next();
});

export default mongoose.model('Lot', lotSchema);
