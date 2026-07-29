const mongoose = require('mongoose');

const groupMetaSchema = new mongoose.Schema({
    groupId: String,
    subject: String,
    size: Number,
    lastActive: { type: Date, default: Date.now }
});

groupMetaSchema.index({ groupId: 1 }, { unique: true });

module.exports = mongoose.model("GroupMeta", groupMetaSchema);
