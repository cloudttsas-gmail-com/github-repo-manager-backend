import mongoose from 'mongoose';

/**
 * One document per payment operation sent by a form (requestId). Its unique key
 * makes a double click or a retried request a no-op instead of a second payment.
 */
const idempotencyKeySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 },
});

export default mongoose.model('IdempotencyKey', idempotencyKeySchema);
