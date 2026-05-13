const mongoose = require('mongoose');

const groupMetaSchema = new mongoose.Schema({
    groupId: String,
    subject: String,
    size: Number,
    lastActive: { type: Date, default: Date.now }
});

module.exports = mongoose.model("GroupMeta", groupMetaSchema);
