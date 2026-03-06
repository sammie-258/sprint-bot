// =======================
//       IMPORTS
// =======================
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");
const express = require('express');
const http = require('http'); 
const os = require('os'); 
const QR = require('qrcode');
const fs = require('fs'); 
const path = require('path');
require("dotenv").config();

// =======================
//   HELPER FUNCTIONS
// =======================
const toSuperscript = (num) => {
    const map = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
    return num.toString().split('').map(d => map[d]).join('');
};

const getRank = (total) => {
    if (total >= 1000000) return "Novel God ⚡";
    if (total >= 500000) return "Word Expert 🎓";
    if (total >= 250000) return "Word Architect 🏗️";
    if (total >= 100000) return "Prolific Writer 📚";
    if (total >= 50000) return "Novelist 📘";
    if (total >= 10000) return "Aspiring Author ✍️";
    return "Unranked ⚪";
};

// NEW: Calculate duration string between two dates
const getDurationString = (startDate, endDate = new Date()) => {
    const start = new Date(startDate);
    const diffMs = endDate - start;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (diffDays > 0) return `${diffDays} day${diffDays !== 1 ? 's' : ''}${diffHours > 0 ? ` ${diffHours}h` : ''}`;
    if (diffHours > 0) return `${diffHours} hour${diffHours !== 1 ? 's' : ''}`;
    return "less than an hour";
};

// =======================
//   MANUAL GARBAGE COLLECTION
// =======================
if (global.gc) {
    setInterval(() => { global.gc(); }, 30000);
}

// =======================
//   CONFIG & SERVER SETUP
// =======================
const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = "Africa/Lagos"; 

const BASE_URL = process.env.RENDER_EXTERNAL_URL || "https://quillreads.com"; 

const OWNER_NUMBER = '223733486772376@lid'; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; 

app.use(express.json({ limit: '10mb' })); 
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// CORS
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); 
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, x-admin-password");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Admin Auth Helper
const requireAdmin = (req, res, next) => {
    const password = req.headers['x-admin-password'];
    if (password === ADMIN_PASSWORD) return next();
    res.status(403).json({ error: "Unauthorized" });
};

let qrCodeData = null;
let isConnected = false;
let sock = null; 
let maintenanceMode = false; 

// --- Group Cache System ---
let groupCache = {}; 
let lastCacheUpdate = 0;

const updateGroupCache = async (force = false) => {
    if (!force && Date.now() - lastCacheUpdate < 5 * 60 * 1000) return;
    if (sock && isConnected) {
        try {
            const groups = await sock.groupFetchAllParticipating();
            for (const [jid, data] of Object.entries(groups)) {
                groupCache[jid] = { 
                    subject: data.subject, 
                    size: data.participants ? data.participants.length : 0 
                };
            }
            lastCacheUpdate = Date.now();
            console.log("🔄 Group cache updated.");
        } catch (e) {
            console.log("⚠️ Cache update paused (Rate Limit or Connection issue). Using old data.");
        }
    }
};

// =======================
//   DATABASE SCHEMAS
// =======================
const dailyStatsSchema = new mongoose.Schema({
    userId: String,
    name: String,
    groupId: String,
    date: String, 
    words: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now } 
});
const DailyStats = mongoose.model("DailyStats", dailyStatsSchema);

// UPDATED: Added completedAt field
const goalSchema = new mongoose.Schema({
    userId: String,
    name: String,
    target: Number,
    current: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    startDate: { type: String, default: () => new Date().toLocaleDateString('en-CA', { timeZone: "Africa/Lagos" }) },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null }
});
const PersonalGoal = mongoose.model("PersonalGoal", goalSchema);

const scheduleSchema = new mongoose.Schema({
    groupId: String,
    startTime: Date,
    duration: Number,
    createdBy: String
});
const ScheduledSprint = mongoose.model("ScheduledSprint", scheduleSchema);

const blacklistSchema = new mongoose.Schema({ userId: String });
const Blacklist = mongoose.model("Blacklist", blacklistSchema);

const activeSprintSchema = new mongoose.Schema({
    groupId: String,
    endsAt: Number,
    duration: Number,
    participants: { type: Object, default: {} }
});
const ActiveSprint = mongoose.model("ActiveSprint", activeSprintSchema);

const userProfileSchema = new mongoose.Schema({
    userId: String,
    name: String,
    currentStreak: { type: Number, default: 0 },
    bestStreak: { type: Number, default: 0 },
    lastActiveDate: String, 
    totalWordsAllTime: { type: Number, default: 0 },
    joinedAt: { type: Date, default: Date.now }
});
const UserProfile = mongoose.model("UserProfile", userProfileSchema);

const challengeSchema = new mongoose.Schema({
    groupId: String,
    target: Number,
    current: { type: Number, default: 0 },
    contributors: { type: Object, default: {} }, 
    createdBy: String,
    startedAt: { type: Date, default: Date.now }
});
const GroupChallenge = mongoose.model("GroupChallenge", challengeSchema);

const MONGO_URI = process.env.MONGO_URI; 
if (!MONGO_URI) { console.error("❌ ERROR: MONGO_URI is missing!"); process.exit(1); }

let activeSprints = {};
let activePomodoros = {}; 

// =======================
//   WEB API ENDPOINTS
// =======================

app.get('/', (req, res) => {
    res.redirect('https://quillreads.com/sprint-bot-dashboard');
});

// --- Profile Card Route ---
app.get('/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const potentialJids = [
            userId.includes('@') ? userId : userId + '@s.whatsapp.net',
            userId.includes('@') ? userId : userId + '@lid'
        ];

        const profile = await UserProfile.findOne({ userId: { $in: potentialJids } });
        
        if (!profile) return res.status(404).send(`<h1>Profile Not Found</h1><p>ID: ${userId}</p>`);

        const goal = await PersonalGoal.findOne({ userId: profile.userId, isActive: true });
        const rank = getRank(profile.totalWordsAllTime);

        // NEW: Get today's words
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const todayStatsAgg = await DailyStats.aggregate([
            { $match: { userId: profile.userId, date: todayStr } },
            { $group: { _id: null, total: { $sum: "$words" } } }
        ]);
        const dailyWords = todayStatsAgg[0]?.total || 0;
        
        const templatePath = path.join(__dirname, 'profile.html');
        if (!fs.existsSync(templatePath)) {
            return res.status(500).send("<h1>Error: Profile Template Missing</h1>");
        }

        let template = fs.readFileSync(templatePath, 'utf8');

        let html = template
            .replace(/{{NAME}}/g, profile.name)
            .replace(/{{INITIAL}}/g, profile.name.charAt(0).toUpperCase())
            .replace(/{{RANK}}/g, rank)
            .replace(/{{TOTAL}}/g, profile.totalWordsAllTime.toLocaleString())
            .replace(/{{STREAK}}/g, profile.currentStreak)
            .replace(/{{DAILY_WORDS}}/g, dailyWords.toLocaleString()); // NEW

        if (goal) {
            const pct = Math.min(100, (goal.current / goal.target) * 100).toFixed(1);
            html = html
                .replace('{{GOAL_DISPLAY}}', 'block')
                .replace('{{GOAL_CURRENT}}', goal.current.toLocaleString())
                .replace('{{GOAL_TARGET}}', goal.target.toLocaleString())
                .replace('{{GOAL_PERCENT}}', pct);
        } else {
            html = html.replace('{{GOAL_DISPLAY}}', 'hidden');
        }

        res.send(html);
    } catch (e) {
        console.error(e);
        res.status(500).send("Error generating profile");
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        let qrImage = null;
        if (!isConnected && qrCodeData) qrImage = await QR.toDataURL(qrCodeData);

        await updateGroupCache(); 

        const topWritersRaw = await DailyStats.aggregate([
            { $group: { _id: "$name", total: { $sum: "$words" } } }, 
            { $sort: { total: -1 } }, { $limit: 10 }
        ]);
        const topWriters = topWritersRaw.map(w => ({ name: w._id, words: w.total }));

        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const todayWritersRaw = await DailyStats.aggregate([
            { $match: { date: todayStr } }, 
            { $group: { _id: "$name", total: { $sum: "$words" } } }, 
            { $sort: { total: -1 } }, { $limit: 10 }
        ]);
        const todayWriters = todayWritersRaw.map(w => ({ name: w._id, words: w.total }));

        const topGroupsRaw = await DailyStats.aggregate([
            { $match: { groupId: { $exists: true, $ne: "Manual_Correction" } } }, 
            { $group: { _id: "$groupId", total: { $sum: "$words" } } },
            { $sort: { total: -1 } },
            { $limit: 10 }
        ]);

        const topGroups = topGroupsRaw.map(g => ({
            name: groupCache[g._id]?.subject || `Group ${g._id.substring(0, 8)}...`,
            words: g.total
        }));

        const totalWordsAgg = await DailyStats.aggregate([{ $group: { _id: null, total: { $sum: "$words" } } }]);
        const totalWritersAgg = await DailyStats.distinct("name");
        const allGroupIds = await DailyStats.distinct("groupId");
        
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const chartDataRaw = await DailyStats.aggregate([
            { $match: { timestamp: { $gte: sevenDaysAgo } } },
            { $group: { _id: "$date", total: { $sum: "$words" } } },
            { $sort: { _id: 1 } } 
        ]);
        const chartData = { labels: chartDataRaw.map(d => d._id), data: chartDataRaw.map(d => d.total) };

        res.json({ 
            isConnected, 
            qrCode: qrImage, 
            topWriters, 
            todayWriters, 
            topGroups, 
            totalWords: totalWordsAgg[0]?.total || 0, 
            totalWriters: totalWritersAgg.length, 
            totalGroups: allGroupIds.filter(id => id !== "Manual_Correction").length,
            chartData 
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/system', requireAdmin, (req, res) => {
    const memory = process.memoryUsage();
    res.json({
        uptime: process.uptime(),
        memory: Math.round(memory.heapUsed / 1024 / 1024),
        platform: os.platform() + " " + os.release(),
        cpu: os.cpus()[0].model,
        maintenance: maintenanceMode,
        activeSprintsCount: Object.keys(activeSprints).length
    });
});

app.post('/api/admin/maintenance', requireAdmin, (req, res) => {
    const { status } = req.body; 
    maintenanceMode = status;
    res.json({ success: true, status: maintenanceMode });
});

app.get('/api/admin/sprints', requireAdmin, async (req, res) => {
    try {
        await updateGroupCache();
        const sprints = [];
        for (const [chatId, sprint] of Object.entries(activeSprints)) {
            const timeLeft = Math.max(0, sprint.endsAt - Date.now());
            sprints.push({
                id: chatId,
                name: groupCache[chatId]?.subject || chatId, 
                timeLeft: Math.ceil(timeLeft / 1000 / 60), 
                participants: Object.keys(sprint.participants).length
            });
        }
        res.json(sprints);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/sprints/stop', requireAdmin, async (req, res) => {
    const { chatId } = req.body;
    if (activeSprints[chatId]) {
        delete activeSprints[chatId];
        await ActiveSprint.deleteOne({ groupId: chatId }); 
        try {
            if (sock && isConnected) {
                await sock.sendMessage(chatId, { text: "🛑 *ADMIN STOP*: Sprint cancelled by Super Admin." });
            }
        } catch(e) {}
        return res.json({ success: true });
    }
    res.status(404).json({ error: "Sprint not found" });
});

app.get('/api/admin/scheduled', requireAdmin, async (req, res) => {
    try {
        await updateGroupCache();
        const sprints = await ScheduledSprint.find({ startTime: { $gt: new Date() } }).sort({ startTime: 1 });
        const result = sprints.map((s) => ({
            id: s._id,
            groupName: groupCache[s.groupId]?.subject || s.groupId,
            startTime: s.startTime,
            duration: s.duration,
            createdBy: s.createdBy.split('@')[0]
        }));
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/scheduled/cancel', requireAdmin, async (req, res) => {
    const { id } = req.body;
    try {
        await ScheduledSprint.findByIdAndDelete(id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// FIXED: Removed .limit(20) — now returns all writers
app.post('/api/admin/search', requireAdmin, async (req, res) => {
    try {
        const { query } = req.body;
        const profiles = await UserProfile.find({ name: { $regex: query, $options: 'i' } });

        const enrichedUsers = await Promise.all(profiles.map(async (p) => {
            const isBanned = await Blacklist.exists({ userId: p.userId });
            const rank = getRank(p.totalWordsAllTime);
            return {
                _id: p.userId,
                name: p.name,
                totalWords: p.totalWordsAllTime,
                lastActive: p.lastActiveDate,
                rank: rank,
                streak: p.currentStreak,
                bestStreak: p.bestStreak,
                trueTotal: p.totalWordsAllTime,
                isBanned: !!isBanned
            };
        }));

        res.json(enrichedUsers);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/update', requireAdmin, async (req, res) => {
    const { userId, amount, type, name } = req.body;
    try {
        if (type === 'name') {
            await UserProfile.findOneAndUpdate({ userId }, { name });
            await DailyStats.updateMany({ userId }, { name });
            await PersonalGoal.updateMany({ userId }, { name });
            return res.json({ success: true, message: "Name updated." });
        }

        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const history = await DailyStats.findOne({ userId }).sort({ timestamp: -1 });
        let doc = await DailyStats.findOne({ userId, date: todayStr, groupId: history?.groupId || "Manual_Correction" });

        if (!doc) {
            doc = await DailyStats.create({
                userId, name: history?.name || userId, groupId: history?.groupId || "Manual_Correction",
                date: todayStr, words: 0, timestamp: new Date()
            });
        }

        let diff = 0;
        if (type === 'set') {
            diff = parseInt(amount) - doc.words;
            doc.words = parseInt(amount);
        } else {
            diff = parseInt(amount);
            doc.words += diff;
        }

        doc.timestamp = new Date();
        await doc.save();

        await PersonalGoal.findOneAndUpdate({ userId, isActive: true }, { $inc: { current: diff } });
        await UserProfile.findOneAndUpdate({ userId }, { $inc: { totalWordsAllTime: diff } }, { upsert: true });

        res.json({ success: true, newTotal: doc.words });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ban', requireAdmin, async (req, res) => {
    const { userId, action } = req.body;
    try {
        if (action === 'ban') {
            await Blacklist.findOneAndUpdate({ userId }, { userId }, { upsert: true });
        } else {
            await Blacklist.deleteMany({ userId });
        }
        res.json({ success: true, isBanned: action === 'ban' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
    try {
        const { message, image } = req.body; 
        if (!message && !image) return res.status(400).json({ error: "Provide text or image" });

        const chats = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(chats);
        let count = 0;
        
        for (const id of groupIds) {
            try {
                if (image) {
                    const buffer = Buffer.from(image.split(",")[1], 'base64');
                    await sock.sendMessage(id, { image: buffer, caption: message || "" });
                } else {
                    await sock.sendMessage(id, { text: message });
                }
                count++;
                await new Promise(r => setTimeout(r, 500)); 
            } catch (e) {
                console.error(`Failed to send to ${id}`);
            }
        }

        res.json({ success: true, count });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/groups', requireAdmin, async (req, res) => {
    if (!sock || !isConnected) return res.json([]);
    try {
        const groups = await sock.groupFetchAllParticipating();
        const result = Object.entries(groups).map(([jid, data]) => ({
            id: jid,
            name: data.subject || jid,
            participants: data.participants ? data.participants.length : 0
        }));
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/groups/leave', requireAdmin, async (req, res) => {
    const { chatId } = req.body;
    try {
        if (sock && isConnected) {
            await sock.sendMessage(chatId, { text: "👋 This bot is leaving via Admin Console. Goodbye!" });
            await sock.groupLeave(chatId);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// NEW: Accept group invitation via invite link or code
app.post('/api/admin/groups/accept', requireAdmin, async (req, res) => {
    const { inviteCode } = req.body;
    if (!inviteCode) return res.status(400).json({ error: "Provide an invite code or link." });
    if (!sock || !isConnected) return res.status(503).json({ error: "Bot is not connected." });

    try {
        // Strip full URL down to just the code if a full link was pasted
        const code = inviteCode.includes('chat.whatsapp.com/')
            ? inviteCode.split('chat.whatsapp.com/').pop().trim()
            : inviteCode.trim();

        const groupId = await sock.groupAcceptInvite(code);
        res.json({ success: true, groupId });
    } catch (e) {
        console.error("Group accept error:", e);
        res.status(500).json({ error: e.message || "Failed to join group. Check the invite code." });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

setInterval(() => {
    http.get(`http://localhost:${PORT}/`, (res) => {}).on('error', (err) => {});
}, 5 * 60 * 1000); 

// =======================
//   MAIN LOGIC
// =======================

mongoose.connect(MONGO_URI)
.then(async () => { 
    console.log("✅ MongoDB connected");

    const restoredSprints = await ActiveSprint.find({});
    restoredSprints.forEach(doc => {
        if (doc.endsAt > Date.now()) {
            activeSprints[doc.groupId] = {
                duration: doc.duration,
                endsAt: doc.endsAt,
                participants: doc.participants
            };
            console.log(`♻️ Restored active sprint for group ${doc.groupId}`);

            const remainingTime = doc.endsAt - Date.now();
            setTimeout(async () => {
                if (activeSprints[doc.groupId] && sock && isConnected) {
                    try {
                        await sock.sendMessage(doc.groupId, { text: `🛑 *TIME'S UP!* (Restored)\n\nReply with *!wc [number]* now.\nType *!finish* to end.` });
                    } catch (e) {}
                }
            }, remainingTime);
        } else {
            ActiveSprint.deleteOne({ _id: doc._id }).exec();
        }
    });

    const getTodayDateGMT1 = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });

    // =======================
    //   STREAK MANAGER
    // =======================
    const updateStreak = async (userId, name, wordsToAdd) => {
        const today = getTodayDateGMT1();
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const yesterday = d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

        let profile = await UserProfile.findOne({ userId });

        if (!profile) {
            profile = await UserProfile.create({
                userId, name, currentStreak: 1, bestStreak: 1, 
                lastActiveDate: today, totalWordsAllTime: wordsToAdd
            });
            return { profile, status: 'new', rankUp: null, isNovelGod: false };
        }

        const oldRank = getRank(profile.totalWordsAllTime);
        const newTotal = profile.totalWordsAllTime + wordsToAdd;
        const newRank = getRank(newTotal);
        
        let rankUp = null;
        if (oldRank !== newRank) rankUp = newRank;

        // NEW: Flag if they just hit 1M (Novel God)
        const isNovelGod = rankUp === "Novel God ⚡";

        profile.name = name; 
        profile.totalWordsAllTime = newTotal;

        if (profile.lastActiveDate === today) {
            // already active today, no streak change
        } else if (profile.lastActiveDate === yesterday) {
            profile.currentStreak += 1;
            if (profile.currentStreak > profile.bestStreak) profile.bestStreak = profile.currentStreak;
            profile.lastActiveDate = today;
        } else {
            profile.currentStreak = 1;
            profile.lastActiveDate = today;
        }

        await profile.save();
        return { profile, status: 'updated', rankUp, isNovelGod };
    };

    // =======================
    //   CHALLENGE MANAGER
    // =======================
    const updateChallenge = async (groupId, userId, name, wordsToAdd) => {
        const challenge = await GroupChallenge.findOne({ groupId });
        if (!challenge) return; 

        challenge.current += wordsToAdd;

        if (!challenge.contributors[userId]) {
            challenge.contributors[userId] = { name: name, words: 0 };
        }
        challenge.contributors[userId].words += wordsToAdd;
        challenge.contributors[userId].name = name; 

        if (challenge.current >= challenge.target) {
            const leaderboard = Object.values(challenge.contributors).sort((a, b) => b.words - a.words);
            const top = leaderboard[0];
            const mentions = Object.keys(challenge.contributors);
            
            const taggedContributors = leaderboard.map((c, i) => {
                const uid = Object.keys(challenge.contributors).find(key => challenge.contributors[key].name === c.name);
                const tag = uid ? `@${uid.split('@')[0]}` : c.name;
                return `${i+1}. ${tag}: ${c.words.toLocaleString()} words`;
            }).join('\n');

            // NEW: Calculate how long the challenge took
            const duration = getDurationString(challenge.startedAt);

            let txt = `🎉 *CHALLENGE DESTROYED!* 🎉\n` +
                      `━━━━━━━━━━━━━━━━\n` +
                      `🎯 Target: *${challenge.target.toLocaleString()} words*\n` +
                      `⚡ Final Total: ${challenge.current.toLocaleString()}\n` +
                      `⏱️ Completed in: *${duration}*\n\n` +
                      `👑 *MVP:* ${top.name} (${top.words.toLocaleString()} words)\n\n` +
                      `📜 *Contributors:*\n${taggedContributors}`;
            
            await GroupChallenge.deleteOne({ _id: challenge._id });
            return { completed: true, text: txt, mentions };
        } else {
            await GroupChallenge.updateOne({ _id: challenge._id }, { current: challenge.current, contributors: challenge.contributors });
            return { completed: false };
        }
    };

    // =======================
    //   SPRINT SESSION
    // =======================
    const startSprintSession = async (chatId, duration) => {
        if (activeSprints[chatId]) return false; 
        console.log(`🏃 Sprint STARTED in ${chatId} for ${duration} mins`);
        const endTime = Date.now() + duration * 60000;

        activeSprints[chatId] = { duration, endsAt: endTime, participants: {} };

        await ActiveSprint.create({ groupId: chatId, duration, endsAt: endTime, participants: {} });
        await sock.sendMessage(chatId, { text: `🏃 *Writing Sprint Started!*\nDuration: *${duration} minutes*\n\nUse *!wc <number>* to log words.` });

        setTimeout(async () => {
            if (activeSprints[chatId]) {
                try { 
                    await sock.sendMessage(chatId, { text: `🛑 *TIME'S UP!*\n\nReply with *!wc [number]* now.\nType *!finish* to end.` }); 
                } catch (e) { console.log("Timeout error", e); }
            }
        }, duration * 60000);
        return true;
    };

    // =======================
    //   SCHEDULED SPRINT RUNNER
    // =======================
    setInterval(async () => {
        if (!isConnected) return;
        try {
            const now = new Date();
            const dueSprints = await ScheduledSprint.find({ startTime: { $lte: now } });
            for (const sprint of dueSprints) {
                const started = await startSprintSession(sprint.groupId, sprint.duration);
                if (!started) {
                    await sock.sendMessage(sprint.groupId, { text: `⚠️ Scheduled sprint skipped (one already active).` });
                } else {
                    await sock.sendMessage(sprint.groupId, { 
                        text: `(Sprint scheduled by @${sprint.createdBy.split('@')[0]})`,
                        mentions: [sprint.createdBy] 
                    });
                }
                await ScheduledSprint.deleteOne({ _id: sprint._id });
            }
        } catch (e) { console.error("Scheduler Error:", e); }
    }, 60000);

    // =======================
    //   STREAK REMINDER (1hr before midnight)
    // NEW FEATURE
    // =======================
    setInterval(async () => {
        if (!isConnected) return;
        try {
            const now = new Date();
            const lagosTime = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
            const h = lagosTime.getHours();
            const m = lagosTime.getMinutes();

            // Fire at 23:00 (11 PM Lagos time), within the first minute
            if (h !== 23 || m !== 0) return;

            const today = getTodayDateGMT1();

            // Find all users who haven't logged today
            const allProfiles = await UserProfile.find({ currentStreak: { $gt: 0 } });
            const activeToday = await DailyStats.distinct("userId", { date: today });
            const activeTodaySet = new Set(activeToday);

            const atRisk = allProfiles.filter(p => !activeTodaySet.has(p.userId));
            if (atRisk.length === 0) return;

            // For each at-risk user, find which groups they've been in recently
            for (const profile of atRisk) {
                try {
                    // Find the most recent group they were active in
                    const recentStat = await DailyStats.findOne({ userId: profile.userId }).sort({ timestamp: -1 });
                    if (!recentStat || !recentStat.groupId) continue;

                    const groupId = recentStat.groupId;
                    // Make sure the bot is still in that group
                    if (!groupCache[groupId]) continue;

                    await sock.sendMessage(groupId, {
                        text: `⚠️ *Streak Alert!* ⚠️\n\n@${profile.userId.split('@')[0]}, your *${profile.currentStreak}-day streak* is at risk! 🔥\n\nYou have *1 hour* left to log any words before the day resets.\n\nType *!log 1* or start a *!sprint* to keep it alive!`,
                        mentions: [profile.userId]
                    });

                    // Small delay to avoid rate limiting
                    await new Promise(r => setTimeout(r, 1000));
                } catch (e) {
                    console.error(`Streak reminder error for ${profile.userId}:`, e.message);
                }
            }
            console.log(`🔔 Streak reminders sent to ${atRisk.length} at-risk writers.`);
        } catch (e) {
            console.error("Streak reminder scheduler error:", e);
        }
    }, 60000); // Runs every minute, only acts at 23:00

    // =======================
    //   MVP ANNOUNCEMENTS SCHEDULER
    // NEW FEATURE
    // =======================
    setInterval(async () => {
        if (!isConnected) return;
        try {
            const now = new Date();
            const lagosTime = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
            const h = lagosTime.getHours();
            const m = lagosTime.getMinutes();
            const s = lagosTime.getSeconds();
            const today = getTodayDateGMT1();

            // Only act in the 23:59 minute
            if (h !== 23 || m !== 59) return;

            const groups = await sock.groupFetchAllParticipating();
            const groupIds = Object.keys(groups);

            // --- DAILY MVP at 11:59:40 ---
            if (s >= 40 && s < 45) {
                console.log("🏆 Running Daily MVP announcements...");
                for (const gid of groupIds) {
                    try {
                        const topToday = await DailyStats.aggregate([
                            { $match: { groupId: gid, date: today } },
                            { $group: { _id: "$userId", total: { $sum: "$words" }, name: { $first: "$name" } } },
                            { $sort: { total: -1 } },
                            { $limit: 3 }
                        ]);
                        if (topToday.length === 0) continue;

                        const mvp = topToday[0];
                        let txt = `🌟 *DAILY MVP — ${today}* 🌟\n━━━━━━━━━━━━━━━━\n\n`;
                        txt += `👑 *MVP:* @${mvp._id.split('@')[0]} — *${mvp.total.toLocaleString()} words*\n\n`;
                        if (topToday.length > 1) {
                            txt += `*Top Writers Today:*\n`;
                            topToday.forEach((w, i) => {
                                txt += `${i===0?'🥇':i===1?'🥈':'🥉'} @${w._id.split('@')[0]}: ${w.total.toLocaleString()} words\n`;
                            });
                        }
                        txt += `\nAmazing work today! See you tomorrow! ✍️`;

                        await sock.sendMessage(gid, { 
                            text: txt, 
                            mentions: topToday.map(w => w._id) 
                        });
                        await new Promise(r => setTimeout(r, 500));
                    } catch (e) { console.error(`Daily MVP error for ${gid}:`, e.message); }
                }
            }

            // --- WEEKLY MVP at 11:59:45 (Sunday only) ---
            if (s >= 45 && s < 50) {
                const dayOfWeek = lagosTime.getDay(); // 0 = Sunday
                if (dayOfWeek === 0) {
                    console.log("🏆 Running Weekly MVP announcements...");
                    const sevenDaysAgo = new Date(lagosTime);
                    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                    const sevenDaysAgoStr = sevenDaysAgo.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

                    for (const gid of groupIds) {
                        try {
                            // Get dates in range
                            const dates = [];
                            for (let i = 0; i < 7; i++) {
                                const d = new Date(lagosTime);
                                d.setDate(d.getDate() - i);
                                dates.push(d.toLocaleDateString('en-CA', { timeZone: TIMEZONE }));
                            }

                            const topWeekly = await DailyStats.aggregate([
                                { $match: { groupId: gid, date: { $in: dates } } },
                                { $group: { _id: "$userId", total: { $sum: "$words" }, name: { $first: "$name" } } },
                                { $sort: { total: -1 } },
                                { $limit: 3 }
                            ]);
                            if (topWeekly.length === 0) continue;

                            const mvp = topWeekly[0];
                            let txt = `🏆 *WEEKLY MVP* 🏆\n━━━━━━━━━━━━━━━━\n\n`;
                            txt += `👑 *Weekly Champion:* @${mvp._id.split('@')[0]}\n📝 *${mvp.total.toLocaleString()} words* this week!\n\n`;
                            if (topWeekly.length > 1) {
                                txt += `*Top 3 This Week:*\n`;
                                topWeekly.forEach((w, i) => {
                                    txt += `${i===0?'🥇':i===1?'🥈':'🥉'} @${w._id.split('@')[0]}: ${w.total.toLocaleString()} words\n`;
                                });
                            }
                            txt += `\nOutstanding week, writers! Keep the momentum going! 🚀`;

                            await sock.sendMessage(gid, { text: txt, mentions: topWeekly.map(w => w._id) });
                            await new Promise(r => setTimeout(r, 500));
                        } catch (e) { console.error(`Weekly MVP error for ${gid}:`, e.message); }
                    }
                }
            }

            // --- MONTHLY MVP at 11:59:50 (last day of month) ---
            if (s >= 50 && s < 55) {
                const tomorrow = new Date(lagosTime);
                tomorrow.setDate(tomorrow.getDate() + 1);
                const isLastDayOfMonth = tomorrow.getDate() === 1;

                if (isLastDayOfMonth) {
                    console.log("🏆 Running Monthly MVP announcements...");
                    const monthStr = lagosTime.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: TIMEZONE });

                    // Get all dates in this month
                    const year = lagosTime.getFullYear();
                    const month = lagosTime.getMonth();
                    const daysInMonth = lagosTime.getDate();
                    const monthDates = [];
                    for (let i = 1; i <= daysInMonth; i++) {
                        const d = new Date(year, month, i);
                        monthDates.push(d.toLocaleDateString('en-CA', { timeZone: TIMEZONE }));
                    }

                    for (const gid of groupIds) {
                        try {
                            const topMonthly = await DailyStats.aggregate([
                                { $match: { groupId: gid, date: { $in: monthDates } } },
                                { $group: { _id: "$userId", total: { $sum: "$words" }, name: { $first: "$name" } } },
                                { $sort: { total: -1 } },
                                { $limit: 3 }
                            ]);
                            if (topMonthly.length === 0) continue;

                            const mvp = topMonthly[0];
                            let txt = `🎖️ *MONTHLY MVP — ${monthStr}* 🎖️\n━━━━━━━━━━━━━━━━\n\n`;
                            txt += `👑 *Monthly Champion:* @${mvp._id.split('@')[0]}\n📚 *${mvp.total.toLocaleString()} words* this month!\n\n`;
                            if (topMonthly.length > 1) {
                                txt += `*Top 3 This Month:*\n`;
                                topMonthly.forEach((w, i) => {
                                    txt += `${i===0?'🥇':i===1?'🥈':'🥉'} @${w._id.split('@')[0]}: ${w.total.toLocaleString()} words\n`;
                                });
                            }
                            txt += `\nWhat an incredible month! Onward to the next! 📖`;

                            await sock.sendMessage(gid, { text: txt, mentions: topMonthly.map(w => w._id) });
                            await new Promise(r => setTimeout(r, 500));
                        } catch (e) { console.error(`Monthly MVP error for ${gid}:`, e.message); }
                    }
                }
            }

            // --- YEARLY MVP at 11:59:55 (Dec 31) ---
            if (s >= 55 && s <= 59) {
                const isLastDayOfYear = lagosTime.getDate() === 31 && lagosTime.getMonth() === 11;

                if (isLastDayOfYear) {
                    console.log("🏆 Running Yearly MVP announcements...");
                    const year = lagosTime.getFullYear();

                    for (const gid of groupIds) {
                        try {
                            const topYearly = await DailyStats.aggregate([
                                { $match: { groupId: gid, timestamp: { $gte: new Date(`${year}-01-01`), $lte: new Date(`${year}-12-31T23:59:59`) } } },
                                { $group: { _id: "$userId", total: { $sum: "$words" }, name: { $first: "$name" } } },
                                { $sort: { total: -1 } },
                                { $limit: 3 }
                            ]);
                            if (topYearly.length === 0) continue;

                            const mvp = topYearly[0];
                            let txt = `🎊 *YEARLY MVP — ${year}* 🎊\n━━━━━━━━━━━━━━━━\n\n`;
                            txt += `👑 *Writer of the Year:* @${mvp._id.split('@')[0]}\n🌟 *${mvp.total.toLocaleString()} words* in ${year}!\n\n`;
                            if (topYearly.length > 1) {
                                txt += `*Top 3 This Year:*\n`;
                                topYearly.forEach((w, i) => {
                                    txt += `${i===0?'🥇':i===1?'🥈':'🥉'} @${w._id.split('@')[0]}: ${w.total.toLocaleString()} words\n`;
                                });
                            }
                            txt += `\nThank you for an amazing year of writing! See you in ${year + 1}! 🥂✍️`;

                            await sock.sendMessage(gid, { text: txt, mentions: topYearly.map(w => w._id) });
                            await new Promise(r => setTimeout(r, 500));
                        } catch (e) { console.error(`Yearly MVP error for ${gid}:`, e.message); }
                    }
                }
            }

        } catch (e) {
            console.error("MVP Scheduler error:", e);
        }
    }, 5000); // Check every 5 seconds to catch the specific second windows

    // =======================
    //   BAILEYS INITIALIZATION
    // =======================
    const { state, saveCreds } = await useMultiFileAuthState('.auth_info_baileys');

    const initializeBot = async () => {
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            browser: ['Sprint Bot', 'Chrome', '120.0'],
            msgRetryCounterMax: 15,
            defaultQueryTimeoutMs: 60000,
            shouldIgnoreJid: (jid) => !jid || jid === 'status@broadcast' || jid.includes('broadcast'), 
            syncFullHistory: false, 
            generateHighQualityLinkPreview: true,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCodeData = qr;
                console.log('⚠️ New QR Code Generated - Scan required');
            }
            if (connection === 'connecting') { console.log('⏳ Connecting...'); } 
            else if (connection === 'open') {
                isConnected = true;
                qrCodeData = null;
                updateGroupCache(true); 
                console.log('✅ Bot Connected!');
            } 
            else if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Connection closed. Code:', statusCode);
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log("🛑 Session invalid. Please delete .auth_info_baileys and restart to rescan.");
                } else {
                    console.log('🔄 Reconnecting...');
                    setTimeout(() => initializeBot(), 3000);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async (m) => {
            try {
                const msg = m.messages[0];
                if (!msg.message || msg.key.fromMe) return;

                const chatId = msg.key.remoteJid;
                const isGroup = chatId.endsWith('@g.us');
                const senderId = msg.key.participant || msg.key.remoteJid;

                if (await Blacklist.exists({ userId: senderId })) return;

                const isOwner = senderId.includes(OWNER_NUMBER);

                if (maintenanceMode && !isOwner) {
                    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    if (body.startsWith("!")) await sock.sendMessage(chatId, { text: "⚠️ Bot is currently in Maintenance Mode." }, { quoted: msg });
                    return;
                }

                if (!isGroup && !isOwner) return;

                let body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                if (!body.startsWith("!")) return;

                let senderName = senderId.split('@')[0];
                if (msg.pushName) senderName = msg.pushName;

                const savedProfile = await DailyStats.findOne({ userId: senderId }).sort({ timestamp: -1 });
                if (savedProfile && savedProfile.name) senderName = savedProfile.name;

                const args = body.trim().split(" ");
                const command = args[0].toLowerCase();
                const todayStr = getTodayDateGMT1();

                const getTargetId = (argIndex = 1) => {
                    const potentialNumber = args[argIndex]?.replace(/\D/g, '');
                    if (potentialNumber && potentialNumber.length > 5) return potentialNumber + '@c.us';
                    return null;
                };

                // =======================
                //   OWNER/ADMIN COMMANDS
                // =======================
                if (isOwner) {
                    if (command === "!broadcast") {
                        const message = args.slice(1).join(" ");
                        if (!message) return sock.sendMessage(chatId, { text: "❌ Empty." }, { quoted: msg });
                        const groups = await sock.groupFetchAllParticipating();
                        let count = 0;
                        for (const gid of Object.keys(groups)) {
                            try { await sock.sendMessage(gid, { text: message }); count++; } catch(e) {}
                            await new Promise(r => setTimeout(r, 300));
                        }
                        return sock.sendMessage(chatId, { text: `✅ Sent to ${count} groups.` }, { quoted: msg });
                    }

                    if (command === "!ban") {
                        const targetId = getTargetId(1);
                        if (!targetId) return sock.sendMessage(chatId, { text: "❌ Tag user." }, { quoted: msg });
                        await Blacklist.create({ userId: targetId });
                        return sock.sendMessage(chatId, { text: `🚫 Banned.` }, { quoted: msg });
                    }

                    if (command === "!unban") {
                        const targetId = getTargetId(1);
                        if (!targetId) return sock.sendMessage(chatId, { text: "❌ Tag user." }, { quoted: msg });
                        await Blacklist.deleteMany({ userId: targetId });
                        return sock.sendMessage(chatId, { text: `✅ Unbanned.` }, { quoted: msg });
                    }

                    if (command === "!setwords") {
                        const targetId = getTargetId(1);
                        const amount = parseInt(args[2]);
                        if (!targetId || isNaN(amount)) return sock.sendMessage(chatId, { text: "❌ Use: !setwords [number] [amount]" }, { quoted: msg });
                        const targetDoc = await DailyStats.findOneAndUpdate(
                            { userId: targetId, date: todayStr },
                            { $set: { words: amount }, name: senderName },
                            { upsert: true, new: true }
                        );
                        return sock.sendMessage(chatId, { text: `✅ Set. New Total: ${targetDoc.words}` }, { quoted: msg });
                    }

                    if (command === "!leave") {
                        await sock.sendMessage(chatId, { text: "👋 Bye!" });
                        await sock.groupLeave(chatId);
                        return;
                    }
                }

                // =======================
                //   REGULAR COMMANDS
                // =======================
                if (command === "!help") {
                    return sock.sendMessage(chatId, { text: 
                `🤖 *SPRINT BOT COMMANDS*
━━━━━━━━━━━━━━━━━━

🍅 *Sprinting & Focus*
*!sprint 20* → Start 20 min sprint
*!pomo 25 5 4* → Start Pomodoro (Sprint/Break/Rounds)
*!wc 500* → Log words (during sprint)
*!time* → Check time remaining
*!finish* → End sprint & view results
*!cancel* → Stop current timer

⚔️ *Challenges*
*!challenge 5000* → Start group boss battle
*!challenge check* → View boss HP
*!challenge stop* → Cancel challenge

📊 *Stats & Profile*
*!profile* → Rank, Streak & Total
*!daily* → Today's Leaderboard
*!weekly* → Last 7 days
*!monthly* → Last 30 days
*!top10* → All-Time Hall of Fame
*!myname Sam* → Set your display name

🎯 *Goals*
*!goal set 1000* → Set personal target
*!goal check* → View progress
*!goal history* → View past records

⚙️ *Utils*
*!log 500* → Add words manually (No timer)
*!schedule 20 in 60* → Plan a sprint
*!unschedule* → Cancel plans` }, { quoted: msg });
                }

                if (command === "!log") {
                    let count = parseInt(args[1]);
                    if (isNaN(count) || count <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!log 500`" }, { quoted: msg });
                    
                    try {
                        // 1. Update Daily Stats
                        await DailyStats.findOneAndUpdate(
                            { userId: senderId, groupId: chatId, date: todayStr }, 
                            { name: senderName, $inc: { words: count }, timestamp: new Date() }, 
                            { upsert: true, new: true }
                        );
                        
                        // 2. Update Personal Goal
                        const goal = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                        if (goal) {
                            goal.current += count;
                            if (goal.current >= goal.target) { 
                                goal.isActive = false;
                                goal.completedAt = new Date(); // NEW
                                await goal.save();
                                // NEW: Duration analysis
                                const duration = getDurationString(goal.startedAt);
                                await sock.sendMessage(chatId, { 
                                    text: `🎉 *GOAL ACHIEVED!* 🏆\n\n@${senderId.split('@')[0]} just smashed their goal of *${goal.target.toLocaleString()} words*!\n\n⏱️ *Completed in:* ${duration}\n📊 Final count: ${goal.current.toLocaleString()} words\n\nIncredible work! Set a new goal with *!goal set [number]* 🎯`,
                                    mentions: [senderId]
                                });
                            } else {
                                await goal.save();
                            }
                        }

                        // 3. Update Streak & Check Rank Up
                        const { profile, rankUp, isNovelGod } = await updateStreak(senderId, senderName, count);
                        const streakIcon = profile.currentStreak > 2 ? `🔥 ${profile.currentStreak}` : `${profile.currentStreak}`;
                        
                        // 4. Update Challenge
                        const challengeRes = await updateChallenge(chatId, senderId, senderName, count);

                        let responseText = `✅ Logged ${count.toLocaleString()} words.\n📈 Streak: ${streakIcon} days`;

                        if (rankUp && !isNovelGod) {
                            responseText += `\n\n🎓 *RANK UP!* You are now a *${rankUp}*!`;
                        }

                        // NEW: 1M Worldwide Announcement
                        if (isNovelGod) {
                            responseText += `\n\n⚡ *NOVEL GOD ACHIEVED!* You've written 1,000,000 words!`;
                            // Broadcast to ALL groups
                            try {
                                const allGroups = await sock.groupFetchAllParticipating();
                                for (const gid of Object.keys(allGroups)) {
                                    try {
                                        await sock.sendMessage(gid, {
                                            text: `🌍 *WORLDWIDE ANNOUNCEMENT* 🌍\n━━━━━━━━━━━━━━━━\n\n⚡ *${senderName}* has just crossed *1,000,000 words* and achieved the rank of *Novel God ⚡*!\n\nThis is a historic milestone in our writing community. 🏆\n\nCongratulations @${senderId.split('@')[0]}! You are an inspiration to writers everywhere! 🎉`,
                                            mentions: [senderId]
                                        });
                                        await new Promise(r => setTimeout(r, 500));
                                    } catch (e) { /* skip failed groups */ }
                                }
                            } catch (e) { console.error("Novel God broadcast error:", e); }
                        }

                        if (challengeRes && challengeRes.completed) {
                            await sock.sendMessage(chatId, { text: challengeRes.text, mentions: challengeRes.mentions });
                        } else {
                            await sock.sendMessage(chatId, { text: responseText, mentions: rankUp ? [senderId] : [] }, { quoted: msg });
                        }
                    } catch (e) { console.error(e); }
                }

                if (command === "!top10" || command === "!top") {
                    const top = await DailyStats.aggregate([
                        { $group: { _id: "$name", total: { $sum: "$words" } } }, 
                        { $sort: { total: -1 } }, 
                        { $limit: 10 }
                    ]);
                    if (top.length === 0) return sock.sendMessage(chatId, { text: "📉 No data." }, { quoted: msg });
                    let txt = `🌎 *ALL-TIME HALL OF FAME*\n\n`;
                    top.forEach((w, i) => { txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} ${w._id}: ${w.total.toLocaleString()}\n`; });
                    await sock.sendMessage(chatId, { text: txt });
                }

                if (command === "!myname") {
                    const n = args.slice(1).join(" ");
                    if (!n) return sock.sendMessage(chatId, { text: "❌ Use: `!myname Sam`" }, { quoted: msg });
                    await DailyStats.updateMany({ userId: senderId }, { name: n });
                    await PersonalGoal.updateMany({ userId: senderId }, { name: n });
                    return sock.sendMessage(chatId, { text: `✅ Name updated to: ${n}` }, { quoted: msg });
                }

                if (command === "!profile") {
                    let profile = await UserProfile.findOne({ userId: senderId });
                    
                    const historyStats = await DailyStats.aggregate([
                        { $match: { userId: senderId } },
                        { $group: { _id: null, total: { $sum: "$words" } } }
                    ]);
                    const trueTotal = historyStats[0]?.total || 0;

                    if (!profile) {
                        profile = await UserProfile.create({
                            userId: senderId, name: senderName,
                            currentStreak: 0, bestStreak: 0,
                            lastActiveDate: "", totalWordsAllTime: trueTotal 
                        });
                    } else {
                        if (profile.totalWordsAllTime < trueTotal) {
                            profile.totalWordsAllTime = trueTotal;
                            await profile.save();
                        }
                    }

                    // NEW: Today's word count
                    const todayStatsAgg = await DailyStats.aggregate([
                        { $match: { userId: senderId, date: todayStr } },
                        { $group: { _id: null, total: { $sum: "$words" } } }
                    ]);
                    const dailyWords = todayStatsAgg[0]?.total || 0;

                    const goal = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                    const rank = getRank(profile.totalWordsAllTime);
                    const profileLink = `${BASE_URL}/profile/${senderId.split('@')[0]}`;

                    let txt = `👤 *WRITER PROFILE*\n` +
                              `━━━━━━━━━━━━━━\n` +
                              `📛 *${profile.name}*\n` +
                              `🎖️ Rank: ${rank}\n\n` +
                              `🔥 Current Streak: *${profile.currentStreak} days*\n` +
                              `🏆 Best Streak: ${profile.bestStreak} days\n` +
                              `📅 Today's Words: *${dailyWords.toLocaleString()}*\n` + // NEW
                              `📚 All-Time Words: ${profile.totalWordsAllTime.toLocaleString()}\n\n` + 
                              `🔗 *View Card:* ${profileLink}\n`;
                    
                    if (goal) {
                        const rawPct = (goal.current / goal.target) * 100;
                        const pct = Math.min(100, Math.max(0, rawPct));
                        const filledCount = Math.round(pct / 10); 
                        const emptyCount = 10 - filledCount;
                        const bar = "🟩".repeat(filledCount) + "⬜".repeat(emptyCount);
                        txt += `\n🎯 *Current Goal:*\n` + 
                               "```" + `${goal.current.toLocaleString()} / ${goal.target.toLocaleString()}` + "```" + ` (${pct.toFixed(1)}%)\n` +
                               `${bar}`;
                    }

                    return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
                }

                if (command === "!challenge") {
                    const sub = args[1];
                    const active = await GroupChallenge.findOne({ groupId: chatId });
                    
                    if (sub === "status" || sub === "check") {
                        if (!active) return sock.sendMessage(chatId, { text: "💤 No active challenge. Start one with `!challenge 5000`" }, { quoted: msg });
                        const pct = ((active.current / active.target) * 100).toFixed(1);
                        const bar = "🟩".repeat(Math.round(pct/10)) + "⬜".repeat(10 - Math.round(pct/10));
                        // NEW: Show time since started
                        const timeSinceStart = getDurationString(active.startedAt);
                        return sock.sendMessage(chatId, { 
                            text: `⚔️ *Current Challenge*\n\n🎯 Target: ${active.target.toLocaleString()}\n📊 Progress: ${active.current.toLocaleString()} (${pct}%)\n${bar}\n⏱️ Running for: ${timeSinceStart}` 
                        }, { quoted: msg });
                    }

                    if (sub === "stop" || sub === "cancel") {
                        if (!active) return sock.sendMessage(chatId, { text: "❌ No challenge to stop." }, { quoted: msg });
                        await GroupChallenge.deleteOne({ groupId: chatId });
                        return sock.sendMessage(chatId, { text: "🚫 Challenge cancelled." }, { quoted: msg });
                    }

                    const target = parseInt(sub);
                    if (isNaN(target) || target <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!challenge 5000`" }, { quoted: msg });
                    if (active) return sock.sendMessage(chatId, { text: `⚠️ A challenge is already active (${active.current.toLocaleString()}/${active.target.toLocaleString()}).\nFinish it or use \`!challenge stop\`.` }, { quoted: msg });

                    await GroupChallenge.create({ groupId: chatId, target, current: 0, contributors: {}, createdBy: senderId });
                    return sock.sendMessage(chatId, { text: `⚔️ *NEW CHALLENGE STARTED!* ⚔️\n\n🎯 Target: *${target.toLocaleString()} words*\n\nEvery \`!log\` and sprint finish counts towards this goal. Let's write!` }, { quoted: msg });
                }

                if (["!daily", "!weekly", "!monthly"].includes(command)) {
                    const d = command === "!daily";
                    const days = d ? 1 : command === "!weekly" ? 7 : 30;
                    let title = d ? `Daily Leaderboard (${todayStr})` : command === "!weekly" ? "Weekly Leaderboard" : "Monthly Leaderboard";

                    let stats;
                    if (d) {
                        stats = await DailyStats.aggregate([
                            { $match: { date: todayStr } }, 
                            { $group: { _id: "$userId", totalWords: { $sum: "$words" }, name: { $first: "$name" } }}, 
                            { $sort: { totalWords: -1 } }, 
                            { $limit: 15 }
                        ]);
                    } else {
                        const dt = new Date(); dt.setDate(dt.getDate() - days);
                        stats = await DailyStats.aggregate([
                            { $match: { timestamp: { $gte: dt } } }, 
                            { $group: { _id: "$userId", totalWords: { $sum: "$words" }, name: { $first: "$name" } } }, 
                            { $sort: { totalWords: -1 } }, 
                            { $limit: 15 }
                        ]);
                    }

                    if (stats.length === 0) return sock.sendMessage(chatId, { text: "📉 No stats yet." }, { quoted: msg });

                    let txt = `🏆 *${title}*\n\n`;
                    for (let i = 0; i < stats.length; i++) {
                        const s = stats[i];
                        const p = await UserProfile.findOne({ userId: s._id });
                        let fire = (p && p.currentStreak > 2) ? `🔥${toSuperscript(p.currentStreak)}` : "";
                        txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} ${s.name} ${fire}: ${s.totalWords.toLocaleString()} words\n`;
                    }

                    await sock.sendMessage(chatId, { text: txt });
                }

                if (command === "!goal") {
                    const sub = args[1]?.toLowerCase();

                    if (sub === "set") {
                        const t = parseInt(args[2]);
                        if (isNaN(t)) return sock.sendMessage(chatId, { text: "❌ Use: `!goal set 5000`" }, { quoted: msg });
                        await PersonalGoal.updateMany({ userId: senderId }, { isActive: false });
                        await PersonalGoal.create({ userId: senderId, name: senderName, target: t, current: 0 });
                        return sock.sendMessage(chatId, { text: `🎯 Goal set: *${t.toLocaleString()} words*\n\nYou've got this! Every word counts. 💪` }, { quoted: msg });
                    }

                    if (sub === "history") {
                        const history = await PersonalGoal.find({ userId: senderId, isActive: false })
                                                          .sort({ _id: -1 }).limit(5);
                        if (history.length === 0) return sock.sendMessage(chatId, { text: "📜 No past goals found." }, { quoted: msg });

                        let txt = `📜 *GOAL HISTORY (Last 5)*\n━━━━━━━━━━━━━━\n`;
                        history.forEach((g) => {
                            const percent = Math.min(100, (g.current / g.target) * 100).toFixed(1);
                            const isWin = g.current >= g.target;
                            const icon = isWin ? "✅" : "❌";
                            // NEW: Duration analysis
                            const duration = g.completedAt ? getDurationString(g.startedAt, g.completedAt) : null;
                            txt += `\n${icon} *Started:* ${g.startDate}\n`;
                            txt += `   Target: ${g.target.toLocaleString()} words\n`;
                            txt += `   Result: ${g.current.toLocaleString()} (${percent}%)\n`;
                            if (isWin && duration) txt += `   ⏱️ Completed in: ${duration}\n`;
                        });

                        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
                    }

                    if (sub === "check" || !sub) {
                        const g = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                        if (!g) return sock.sendMessage(chatId, { text: "❌ No active goal. Start one with `!goal set [number]`" }, { quoted: msg });

                        const rawPct = (g.current / g.target) * 100;
                        const pct = Math.min(100, Math.max(0, rawPct));
                        const filledCount = Math.round(pct / 10); 
                        const emptyCount = 10 - filledCount;
                        const bar = "🟩".repeat(filledCount) + "⬜".repeat(emptyCount);
                        // NEW: Show time since goal started
                        const timeSinceStart = getDurationString(g.startedAt);

                        const txt = `🎯 *Goal Progress*\n` +
                            `👤 ${g.name}\n` +
                            `📊 ` + "```" + `${g.current.toLocaleString()} / ${g.target.toLocaleString()}` + "```" + ` words\n` + 
                            `${bar} (${rawPct.toFixed(1)}%)\n` +
                            `📅 Started: ${g.startDate}\n` +
                            `⏱️ Running for: ${timeSinceStart}`;

                        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
                    }
                }

                if (command === "!sprint") {
                    let m = parseInt(args[1]);
                    if (isNaN(m) || m <= 0 || m > 180) return sock.sendMessage(chatId, { text: "❌ Use: `!sprint 20`" }, { quoted: msg });
                    
                    if (activeSprints[chatId]) {
                        const s = activeSprints[chatId];
                        const timeLeft = Math.ceil((s.endsAt - Date.now()) / 60000);
                        return sock.sendMessage(chatId, { 
                            text: `⚠️ *Sprint Already Active!*\n\nThere is a sprint running with approx *${timeLeft} mins* left.\n\nJoin in by typing \`!wc [number]\` now!` 
                        }, { quoted: msg });
                    }

                    await startSprintSession(chatId, m);
                }

                if (command === "!pomo") {
                    const sprintTime = parseInt(args[1]) || 25;
                    const breakTime = parseInt(args[2]) || 5;
                    const rounds = parseInt(args[3]) || 4;

                    if (activeSprints[chatId]) return sock.sendMessage(chatId, { text: "⚠️ A sprint is already running!" }, { quoted: msg });
                    if (activePomodoros[chatId]) return sock.sendMessage(chatId, { text: "⚠️ A Pomodoro session is already active!" }, { quoted: msg });

                    activePomodoros[chatId] = { sprintTime, breakTime, roundsLeft: rounds, totalRounds: rounds, isBreak: false };
                    await sock.sendMessage(chatId, { 
                        text: `🍅 *POMODORO STARTED!* 🍅\n\n🔄 Rounds: ${rounds}\n🏃 Sprint: ${sprintTime}m\n☕ Break: ${breakTime}m\n\n*Round 1/${rounds} starting NOW!*` 
                    }, { quoted: msg });
                    await startSprintSession(chatId, sprintTime);
                }

                if (command === "!schedule") {
                    if (args[2] !== 'in') return sock.sendMessage(chatId, { text: "❌ Use: `!schedule 20 in 60`" }, { quoted: msg });
                    const d = parseInt(args[1]), w = parseInt(args[3]);
                    if (isNaN(d) || isNaN(w)) return sock.sendMessage(chatId, { text: "❌ Invalid numbers." }, { quoted: msg });

                    const s = new Date(Date.now() + w * 60000);
                    await ScheduledSprint.create({ groupId: chatId, startTime: s, duration: d, createdBy: senderId });
                    const timeStr = s.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
                    return sock.sendMessage(chatId, { text: `📅 *Sprint Scheduled!*\n\nDuration: ${d} mins\nStart: In ${w} mins (approx ${timeStr} GMT+1)` }, { quoted: msg });
                }

                if (command === "!unschedule") {
                    const r = await ScheduledSprint.deleteMany({ groupId: chatId });
                    if (r.deletedCount > 0) return sock.sendMessage(chatId, { text: `✅ Scheduled sprint cancelled.` }, { quoted: msg });
                    return sock.sendMessage(chatId, { text: "🤷 No scheduled sprints found." }, { quoted: msg });
                }

                if (command === "!time") {
                    const s = activeSprints[chatId];
                    if (!s) return sock.sendMessage(chatId, { text: "❌ No active sprint." }, { quoted: msg });
                    const r = s.endsAt - Date.now();
                    if (r <= 0) return sock.sendMessage(chatId, { text: "🛑 Time's up!" }, { quoted: msg });
                    const endDates = new Date(s.endsAt);
                    const timeString = endDates.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
                    return sock.sendMessage(chatId, { text: `⏳ *${Math.floor(r/60000)}m ${Math.floor((r/1000)%60)}s* remaining\n(Ends approx ${timeString})` }, { quoted: msg });
                }

                if (command === "!wc") {
                    const s = activeSprints[chatId];
                    if (!s) return sock.sendMessage(chatId, { 
                        text: "❌ *No Active Sprint*\n\nUse `!log 500` to manually add words, or start a sprint with `!sprint 20`" 
                    }, { quoted: msg });

                    let c = parseInt(args[1]==='add'||args[1]==='+'?args[2]:args[1]);
                    let add = args[1]==='add'||args[1]==='+';
                    if (isNaN(c)) return sock.sendMessage(chatId, { text: "❌ Invalid number." }, { quoted: msg });
                    if (!s.participants[senderId]) s.participants[senderId] = { name: senderName, words: 0 };

                    if (add) { 
                        s.participants[senderId].words += c; 
                        await sock.sendMessage(chatId, { text: `➕ Added. Total: ${s.participants[senderId].words.toLocaleString()}` }, { quoted: msg }); 
                    } else { 
                        s.participants[senderId].words = c; 
                        await sock.sendMessage(chatId, { text: `✅` }, { quoted: msg }); 
                    }

                    await ActiveSprint.updateOne({ groupId: chatId }, { $set: { participants: s.participants } });
                }

                if (command === "!finish") {
                    const s = activeSprints[chatId];
                    if (!s) return sock.sendMessage(chatId, { text: "❌ No active sprint." }, { quoted: msg });
                    
                    const l = Object.entries(s.participants).map(([u, d]) => ({ ...d, uid: u })).sort((a, b) => b.words - a.words);
                    delete activeSprints[chatId]; 
                    await ActiveSprint.deleteOne({ groupId: chatId });

                    if (l.length === 0) {
                        await sock.sendMessage(chatId, { text: "🏃 *Sprint Finished*\n\nNo words were logged this time. Ready to try again? Type `!sprint 15`!" }, { quoted: msg });
                        return;
                    }

                    let txt = `🏆 *SPRINT RESULTS* 🏆\n\n`;
                    let mentions = [];

                    for (let i = 0; i < l.length; i++) {
                        let p = l[i];
                        mentions.push(p.uid); 
                        txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} @${p.uid.split('@')[0]} : ${p.words.toLocaleString()} words (${Math.round(p.words/s.duration)} WPM)\n`;
                        
                        try {
                            await DailyStats.findOneAndUpdate(
                                { userId: p.uid, groupId: chatId, date: todayStr }, 
                                { name: p.name, $inc: { words: p.words }, timestamp: new Date() }, 
                                { upsert: true }
                            );
                            const { rankUp, isNovelGod } = await updateStreak(p.uid, p.name, p.words);

                            if (rankUp && !isNovelGod) {
                                txt += `   └─ 🎓 *RANK UP!* Now a *${rankUp}*!\n`;
                            }

                            // NEW: Novel God announcement from sprint
                            if (isNovelGod) {
                                txt += `   └─ ⚡ *NOVEL GOD ACHIEVED!* 1,000,000 words!\n`;
                                try {
                                    const allGroups = await sock.groupFetchAllParticipating();
                                    for (const gid of Object.keys(allGroups)) {
                                        try {
                                            await sock.sendMessage(gid, {
                                                text: `🌍 *WORLDWIDE ANNOUNCEMENT* 🌍\n━━━━━━━━━━━━━━━━\n\n⚡ *${p.name}* has just crossed *1,000,000 words* and achieved the rank of *Novel God ⚡*!\n\nThis is a historic milestone in our writing community. 🏆\n\nCongratulations @${p.uid.split('@')[0]}! You are an inspiration to writers everywhere! 🎉`,
                                                mentions: [p.uid]
                                            });
                                            await new Promise(r => setTimeout(r, 500));
                                        } catch (e) {}
                                    }
                                } catch (e) {}
                            }

                            // Update personal goal
                            const g = await PersonalGoal.findOne({ userId: p.uid, isActive: true });
                            if (g) { 
                                g.current += p.words; 
                                if (g.current >= g.target) { 
                                    g.isActive = false;
                                    g.completedAt = new Date(); // NEW
                                    await g.save();
                                    const duration = getDurationString(g.startedAt);
                                    txt += `   └─ 🎉 *GOAL HIT!* Completed in ${duration}!\n`;
                                } else { 
                                    await g.save(); 
                                }
                            }
                        } catch (e) { console.error(e); }
                    }

                    txt += `\nGreat work, everyone! Type \`!sprint 15\` to go again!`;
                    await sock.sendMessage(chatId, { text: txt, mentions });

                    // Handle Pomodoro continuation
                    if (activePomodoros[chatId]) {
                        const pomo = activePomodoros[chatId];
                        pomo.roundsLeft -= 1;

                        if (pomo.roundsLeft <= 0) {
                            delete activePomodoros[chatId];
                            await sock.sendMessage(chatId, { text: `🍅 *POMODORO COMPLETE!* 🍅\n\nYou survived ${pomo.totalRounds} rounds. Amazing focus!` });
                        } else {
                            await sock.sendMessage(chatId, { text: `☕ *Break Time!* ${pomo.breakTime} minutes.\n\nRound ${pomo.totalRounds - pomo.roundsLeft + 1}/${pomo.totalRounds} starts after!` });
                            setTimeout(async () => {
                                if (activePomodoros[chatId]) {
                                    await sock.sendMessage(chatId, { text: `🍅 *Break Over!* Round ${pomo.totalRounds - pomo.roundsLeft + 1}/${pomo.totalRounds} starting now!` });
                                    await startSprintSession(chatId, pomo.sprintTime);
                                }
                            }, pomo.breakTime * 60000);
                        }
                    }
                }

                if (command === "!cancel" || command === "!stop") {
                    let text = "";
                    if (activeSprints[chatId]) {
                        delete activeSprints[chatId];
                        await ActiveSprint.deleteOne({ groupId: chatId });
                        text += "🚫 Sprint cancelled.\n";
                    }
                    if (activePomodoros[chatId]) {
                        delete activePomodoros[chatId];
                        text += "🚫 Pomodoro session cancelled.";
                    }
                    if (!text) text = "💤 Nothing to cancel.";
                    await sock.sendMessage(chatId, { text }, { quoted: msg });
                }

            } catch (err) { console.error("Handler error:", err); }
        });
    };

    initializeBot();

})
.catch(err => { console.error("❌ MongoDB error:", err); process.exit(1); });

process.on('unhandledRejection', (reason) => { console.log('⚠️ Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.log('⚠️ Uncaught Exception:', err); });