const mongoose = require('mongoose');

const sprintRecordSchema = new mongoose.Schema({
    groupId: String, duration: Number,
    participants: [{ userId: String, name: String, words: Number, wpm: Number }],
    timestamp: { type: Date, default: Date.now }
});

sprintRecordSchema.index({ groupId: 1, timestamp: -1 });
sprintRecordSchema.index({ 'participants.userId': 1 });

module.exports = mongoose.model("SprintRecord", sprintRecordSchema);
