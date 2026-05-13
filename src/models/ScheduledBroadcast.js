const mongoose = require('mongoose');

const scheduledBroadcastSchema = new mongoose.Schema({
    message: String, image: String,
    sendAt: Date, sent: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("ScheduledBroadcast", scheduledBroadcastSchema);
