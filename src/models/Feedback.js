const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
    userId: String, name: String, groupId: String,
    message: String, isRead: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Feedback", feedbackSchema);
