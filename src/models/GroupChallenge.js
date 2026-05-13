const mongoose = require('mongoose');

const challengeSchema = new mongoose.Schema({
    groupId: String, target: Number,
    current:      { type: Number, default: 0 },
    contributors: { type: Object, default: {} },
    createdBy: String, startedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("GroupChallenge", challengeSchema);
