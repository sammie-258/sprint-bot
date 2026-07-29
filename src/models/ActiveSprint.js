const mongoose = require('mongoose');

const activeSprintSchema = new mongoose.Schema({
    groupId: String, endsAt: Number, duration: Number,
    participants: { type: Object, default: {} }
});

activeSprintSchema.index({ groupId: 1 }, { unique: true });

module.exports = mongoose.model("ActiveSprint", activeSprintSchema);
