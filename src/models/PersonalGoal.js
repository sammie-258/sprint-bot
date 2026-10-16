const mongoose = require('mongoose');

const goalSchema = new mongoose.Schema({
    userId:         String,
    name:           String,
    type:           { type: String, enum: ['open', 'day', 'week', 'month'], default: 'open' },
    target:         Number,
    current:        { type: Number,  default: 0 },
    isActive:       { type: Boolean, default: true },
    milestone50Hit: { type: Boolean, default: false },
    startDate:      { type: String,  default: () => new Date().toLocaleDateString('en-CA', { timeZone: "Africa/Lagos" }) },
    startedAt:      { type: Date,    default: Date.now },
    completedAt:    { type: Date,    default: null }
});

goalSchema.index({ userId: 1, type: 1, isActive: 1 });
goalSchema.index({ userId: 1, isActive: 1 });

module.exports = mongoose.model("PersonalGoal", goalSchema);
