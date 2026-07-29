const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
    groupId: String, startTime: Date, duration: Number, createdBy: String,
    retryCount: { type: Number, default: 0 },
    status: { type: String, default: 'pending' }
});

scheduleSchema.index({ startTime: 1 });

module.exports = mongoose.model("ScheduledSprint", scheduleSchema);
