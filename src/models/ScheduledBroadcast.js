const mongoose = require('mongoose');

const scheduledBroadcastSchema = new mongoose.Schema({
    message: String, image: String,
    sendAt: Date, sent: { type: Boolean, default: false },
    retryCount: { type: Number, default: 0 },
    status: { type: String, default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

scheduledBroadcastSchema.index({ sent: 1, sendAt: 1 });

module.exports = mongoose.model("ScheduledBroadcast", scheduledBroadcastSchema);
