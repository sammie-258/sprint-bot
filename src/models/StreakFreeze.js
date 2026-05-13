const mongoose = require('mongoose');

const streakFreezeSchema = new mongoose.Schema({
    userId: String,
    freezesAvailable: { type: Number, default: 0 },
    lastEarnedDate:   { type: String, default: null }
});

module.exports = mongoose.model("StreakFreeze", streakFreezeSchema);
