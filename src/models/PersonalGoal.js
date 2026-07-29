const mongoose = require('mongoose');

const goalSchema = new mongoose.Schema({
    userId: String, name: String, target: Number,
    current:    { type: Number,  default: 0 },
    isActive:   { type: Boolean, default: true },
    startDate:  { type: String,  default: () => new Date().toLocaleDateString('en-CA', { timeZone: "Africa/Lagos" }) },
    startedAt:  { type: Date,    default: Date.now },
    completedAt:{ type: Date,    default: null }
});

goalSchema.index({ userId: 1, isActive: 1 });

module.exports = mongoose.model("PersonalGoal", goalSchema);
