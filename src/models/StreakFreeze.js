const mongoose = require('mongoose');

const streakFreezeSchema = new mongoose.Schema({
    userId: String,
    freezesAvailable: { type: Number, default: 0 },
    lastEarnedDate:   { type: String, default: null }
});

streakFreezeSchema.index({ userId: 1 }, { unique: true });

module.exports = mongoose.model("StreakFreeze", streakFreezeSchema);
