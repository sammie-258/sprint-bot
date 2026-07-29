const mongoose = require('mongoose');

const blacklistSchema = new mongoose.Schema({ userId: String });
blacklistSchema.index({ userId: 1 }, { unique: true });

module.exports = mongoose.model("Blacklist", blacklistSchema);
