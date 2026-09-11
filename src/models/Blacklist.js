const mongoose = require('mongoose');

const blacklistSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    reason: { type: String, default: "" },
    bannedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null } // null = permanent ban, Date = temporary timeout
});

blacklistSchema.index({ userId: 1 }, { unique: true });
blacklistSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Blacklist", blacklistSchema);
