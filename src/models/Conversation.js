import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Project whose number holds the chat (missing in conversations saved before projects had their own number)
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    index: true
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: false
  },
  waId: {
    type: String,
    required: true,
    index: true
  },
  lastMessage: {
    type: String
  },
  unreadCount: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active'
  }
}, {
  timestamps: true
});

// Ensure one conversation per phone number per tenant
conversationSchema.index({ tenantId: 1, waId: 1 }, { unique: true });

const Conversation = mongoose.model('Conversation', conversationSchema);

export default Conversation;
