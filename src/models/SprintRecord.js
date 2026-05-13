const mongoose = require('mongoose');

const sprintRecordSchema = new mongoose.Schema({
    groupId: String, duration: Number,
    participants: [{ userId: String, name: String, words: Number, wpm: Number }],
    timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model("SprintRecord", sprintRecordSchema);
