const mongoose = require('mongoose');

const dailyStatsSchema = new mongoose.Schema({
    userId: String, name: String, groupId: String, date: String,
    words: { type: Number, default: 0 }, timestamp: { type: Date, default: Date.now }
});

dailyStatsSchema.index({ userId: 1, groupId: 1, date: 1 }, { unique: true });
dailyStatsSchema.index({ date: 1 });
dailyStatsSchema.index({ timestamp: -1 });
dailyStatsSchema.index({ groupId: 1, timestamp: -1 });

module.exports = mongoose.model("DailyStats", dailyStatsSchema);
