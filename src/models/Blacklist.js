const mongoose = require('mongoose');

const blacklistSchema = new mongoose.Schema({ userId: String });

module.exports = mongoose.model("Blacklist", blacklistSchema);
