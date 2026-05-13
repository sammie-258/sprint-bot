const mongoose = require('mongoose');

const weeklyChallengeSchema = new mongoose.Schema({
    groupId: String, target: Number,
    current:      { type: Number,  default: 0 },
    contributors: { type: Object,  default: {} },
    weekStart: Date, weekEnd: Date,
    resolved:  { type: Boolean, default: false }
});

module.exports = mongoose.model("WeeklyChallenge", weeklyChallengeSchema);
