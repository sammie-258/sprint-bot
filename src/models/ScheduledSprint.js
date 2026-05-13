const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
    groupId: String, startTime: Date, duration: Number, createdBy: String
});

module.exports = mongoose.model("ScheduledSprint", scheduleSchema);
