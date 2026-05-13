const mongoose = require('mongoose');

const dailyStatsSchema = new mongoose.Schema({
    userId: String, name: String, groupId: String, date: String,
    words: { type: Number, default: 0 }, timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model("DailyStats", dailyStatsSchema);
