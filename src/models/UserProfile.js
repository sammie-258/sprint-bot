const mongoose = require('mongoose');

const userProfileSchema = new mongoose.Schema({
    userId: String, name: String,
    currentStreak:     { type: Number, default: 0 },
    bestStreak:        { type: Number, default: 0 },
    lastActiveDate:    String,
    totalWordsAllTime: { type: Number, default: 0 },
    joinedAt:          { type: Date,   default: Date.now },
    badges:            { type: [String], default: [] },
    activityLog:       { type: String,   default: '0'.repeat(35) },
    bestSprintWords:   { type: Number,   default: 0 },
    bestSprintWpm:     { type: Number,   default: 0 },
    sprintCount:       { type: Number,   default: 0 },
    totalSprintWords:  { type: Number,   default: 0 },
    isInactive:        { type: Boolean,  default: false },
    isArchived:        { type: Boolean,  default: false }
});

module.exports = mongoose.model("UserProfile", userProfileSchema);
