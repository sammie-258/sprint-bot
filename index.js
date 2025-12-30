// =======================
//       IMPORTS
// =======================
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");
const express = require('express');
const http = require('http'); 
const os = require('os'); 
const QR = require('qrcode');
require("dotenv").config();

// =======================
//   MANUAL GARBAGE COLLECTION
// =======================
if (global.gc) {
setInterval(() => {
global.gc();
}, 30000);
}

// =======================
//   CONFIG & SERVER SETUP
// =======================
const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = "Africa/Lagos"; 

const OWNER_NUMBER = '223733486772376@lid'; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; 

app.use(express.json({ limit: '10mb' })); // Allow images up to 10MB
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

// --- NEW: Group Cache System ---
let groupCache = {}; // Stores ID -> { subject, size }
let lastCacheUpdate = 0;

const updateGroupCache = async (force = false) => {
    if (!force && Date.now() - lastCacheUpdate < 5 * 60 * 1000) return;
    
    if (sock && isConnected) {
        try {
            const groups = await sock.groupFetchAllParticipating();
            for (const [jid, data] of Object.entries(groups)) {
                // Store both Name and Participant Count
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
// -------------------------------

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

const goalSchema = new mongoose.Schema({
userId: String,
name: String,
target: Number,
current: { type: Number, default: 0 },
isActive: { type: Boolean, default: true },
startDate: { type: String, default: () => new Date().toLocaleDateString('en-CA', { timeZone: "Africa/Lagos" }) }
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

// --- NEW: User Profile (For Streaks & XP) ---
const userProfileSchema = new mongoose.Schema({
    userId: String,
    name: String,
    currentStreak: { type: Number, default: 0 },
    bestStreak: { type: Number, default: 0 },
    lastActiveDate: String, // Format: "YYYY-MM-DD"
    totalWordsAllTime: { type: Number, default: 0 },
    joinedAt: { type: Date, default: Date.now }
});
const UserProfile = mongoose.model("UserProfile", userProfileSchema);

// --- NEW: Group Challenge Schema ---
const challengeSchema = new mongoose.Schema({
    groupId: String,
    target: Number,
    current: { type: Number, default: 0 },
    contributors: { type: Object, default: {} }, // Stores { userId: { name: "Sam", words: 500 } }
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

app.get('/api/stats', async (req, res) => {
    try {
        let qrImage = null;
        if (!isConnected && qrCodeData) qrImage = await QR.toDataURL(qrCodeData);

        // Use Cached Data instead of hitting WhatsApp API
        await updateGroupCache(); // Tries to update if 5 mins have passed

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
            name: groupCache[g._id]?.subject || g._id || "Unknown Group", // READ FROM CACHE
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
            maintenanceMode,
            chartData 
        });
    } catch (e) { console.error("API Error:", e); res.status(500).json({ error: "Server Error" }); }
});

app.get('/api/admin/system', requireAdmin, async (req, res) => {
const uptime = process.uptime();
const memory = process.memoryUsage();
res.json({
uptime: uptime,
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
        await updateGroupCache(); // Check if update needed
        
        const sprints = [];
        for (const [chatId, sprint] of Object.entries(activeSprints)) {
            const timeLeft = Math.max(0, sprint.endsAt - Date.now());
            sprints.push({
                id: chatId,
                name: groupCache[chatId]?.subject || chatId, // READ FROM CACHE
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
await sock.sendMessage(chatId, { text: "🛑 **ADMIN STOP**: Sprint cancelled by Super Admin." });
}
} catch(e) {}
return res.json({ success: true });
}
res.status(404).json({ error: "Sprint not found" });
});

app.get('/api/admin/scheduled', requireAdmin, async (req, res) => {
    try {
        await updateGroupCache(); // Check if update needed

        const sprints = await ScheduledSprint.find({ startTime: { $gt: new Date() } }).sort({ startTime: 1 });
        const result = sprints.map((s) => ({
            id: s._id,
            groupName: groupCache[s.groupId]?.subject || s.groupId, // READ FROM CACHE
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
const sprint = await ScheduledSprint.findById(id);
if (sprint) {
await ScheduledSprint.deleteOne({ _id: id });
}
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// --- UPDATED: Search with Full Profile & Ban Status ---
app.post('/api/admin/search', requireAdmin, async (req, res) => {
    try {
        const { query } = req.body;
        
        // 1. Get basic stats (Total Words & Name)
        const users = await DailyStats.aggregate([
            { $match: { name: { $regex: query, $options: 'i' } } },
            { $group: { _id: "$userId", name: { $first: "$name" }, totalWords: { $sum: "$words" }, lastActive: { $max: "$date" } } },
            { $limit: 15 }
        ]);

        // 2. Enrich with Profile Data (Rank, Streak, Ban Status)
        const enrichedUsers = await Promise.all(users.map(async (u) => {
            const profile = await UserProfile.findOne({ userId: u._id });
            const isBanned = await Blacklist.exists({ userId: u._id });
            
            // Calculate Rank Helper
            let rank = "Unranked ⚪"; 
            const total = profile ? profile.totalWordsAllTime : u.totalWords;
            if (total >= 10000) rank = "Aspiring Author ✍️";
            if (total >= 50000) rank = "Novelist 📘";
            if (total >= 100000) rank = "Prolific Writer 📚";
            if (total >= 250000) rank = "Word Architect 🏗️";
            if (total >= 500000) rank = "Word Expert 🎓";
            if (total >= 1000000) rank = "Novel God ⚡";

            return {
                ...u,
                rank: rank,
                streak: profile ? profile.currentStreak : 0,
                bestStreak: profile ? profile.bestStreak : 0,
                trueTotal: total,
                isBanned: !!isBanned
            };
        }));

        res.json(enrichedUsers);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- NEW: Ban/Unban Endpoint ---
app.post('/api/admin/ban', requireAdmin, async (req, res) => {
    try {
        const { userId, action } = req.body; // action: 'ban' or 'unban'
        
        if (action === 'ban') {
            await Blacklist.updateOne({ userId }, { userId }, { upsert: true });
            console.log(`🚫 BANNED User: ${userId}`);
        } else {
            await Blacklist.deleteOne({ userId });
            console.log(`✅ UNBANNED User: ${userId}`);
        }
        
        res.json({ success: true, isBanned: action === 'ban' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/groups', requireAdmin, async (req, res) => {
    try {
        await updateGroupCache(); 

        const groupList = Object.entries(groupCache).map(([jid, data]) => ({
            id: jid,
            name: data.subject,  // Read name from object
            participants: data.size // Read size from object
        }));

        res.json(groupList);
    } catch (e) {
        console.error("Admin Group Fetch Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/update', requireAdmin, async (req, res) => {
    try {
        const { userId, amount, type, name } = req.body; 

        // 1. Handle Name Update
        if (type === 'name') {
            if (!name || name.trim() === "") {
                return res.status(400).json({ error: "Name cannot be empty." });
            }
            // Update name everywhere
            await DailyStats.updateMany({ userId }, { name });
            await PersonalGoal.updateMany({ userId }, { name });
            await UserProfile.updateMany({ userId }, { name }); // <--- ADDED THIS TO SYNC PROFILE NAME
            return res.json({ success: true, message: `Name updated to ${name}` });
        }

        // 2. Handle Word Count Update
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        let doc = await DailyStats.findOne({ userId, date: todayStr }).sort({ timestamp: -1 });

        // If no entry for today exists, create one using last known data
        if (!doc) {
            const history = await DailyStats.findOne({ userId }).sort({ timestamp: -1 });
            if (!history) return res.status(404).json({ message: "No history found for this user." });

            doc = await DailyStats.create({
                userId, name: history.name, groupId: history.groupId,
                date: todayStr, words: 0, timestamp: new Date()
            });
        }

        let diff = 0;
        let newDailyTotal = 0;

        // Calculate the difference (delta) so we can apply it to the lifetime profile
        if (type === 'set') {
            diff = parseInt(amount) - doc.words;
            doc.words = parseInt(amount);
        } else {
            // Default is 'add'
            diff = parseInt(amount);
            doc.words += diff;
        }
        
        newDailyTotal = doc.words;
        doc.timestamp = new Date();
        await doc.save();

        // 3. SYNC OTHER COLLECTIONS
        // Update Personal Goal
        await PersonalGoal.findOneAndUpdate({ userId, isActive: true }, { $inc: { current: diff } });

        // --- FIX STARTS HERE ---
        // Update the Lifetime UserProfile so the Manage Writers tab updates immediately
        await UserProfile.findOneAndUpdate(
            { userId }, 
            { $inc: { totalWordsAllTime: diff } }, 
            { upsert: true } // Create profile if it doesn't exist
        );
        // --- FIX ENDS HERE ---

        res.json({ success: true, newTotal: newDailyTotal });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
    try {
        const { message, image } = req.body; // 'image' is a Base64 string

        // Validation: Must have at least text OR image
        if (!message && !image) return res.status(400).json({ error: "Provide text or image" });

        const groups = await ActiveSprint.find({}); // Or however you track groups
        // If you don't track all groups in ActiveSprint, you might need a GroupList collection.
        // For now, let's assume you broadcast to active groups or use a list you saved.
        // IMPORTANT: If you want to broadcast to ALL groups the bot is in, you need to save them to DB when bot joins.
        // For this example, I will assume you want to send to 'DailyStats' unique groupIds or similar.
        // But to keep it simple and safe, let's just loop through a known list or active sprints.
        // BETTER: Use your existing logic for fetching groups.
        
        // Let's assume you have a way to get all groupIds. 
        // If not, use: const groups = await GroupChallenge.distinct("groupId"); 
        // Or strictly strictly:
        const chats = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(chats);

        let count = 0;
        
        for (const id of groupIds) {
            try {
                if (image) {
                    // Send Image (with or without caption)
                    const buffer = Buffer.from(image.split(",")[1], 'base64');
                    await sock.sendMessage(id, { image: buffer, caption: message || "" });
                } else {
                    // Send Text Only
                    await sock.sendMessage(id, { text: message });
                }
                count++;
                await new Promise(r => setTimeout(r, 500)); // Delay to prevent spam blocks
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
await sock.sendMessage(doc.groupId, { text: `🛑 **TIME'S UP!** (Restored)\n\nReply with *!wc [number]* now.\nType *!finish* to end.` });
} catch (e) {}
}
}, remainingTime);
} else {
ActiveSprint.deleteOne({ _id: doc._id }).exec();
}
});

const getTodayDateGMT1 = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });

// --- NEW: Streak Manager Helper ---
const updateStreak = async (userId, name, wordsToAdd) => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
    
    // Calculate "Yesterday" in Lagos Time
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterday = d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

    let profile = await UserProfile.findOne({ userId });

    if (!profile) {
        // First time user? Create profile.
        profile = await UserProfile.create({
            userId, 
            name, 
            currentStreak: 1, 
            bestStreak: 1, 
            lastActiveDate: today, 
            totalWordsAllTime: wordsToAdd
        });
        return { profile, status: 'new' };
    }

    // Update Name & Total Words
    profile.name = name; 
    profile.totalWordsAllTime += wordsToAdd;

    // STREAK LOGIC
    if (profile.lastActiveDate === today) {
        // Already wrote today. Streak stays same.
    } else if (profile.lastActiveDate === yesterday) {
        // Wrote yesterday? Streak goes up! 🔥
        profile.currentStreak += 1;
        if (profile.currentStreak > profile.bestStreak) profile.bestStreak = profile.currentStreak;
        profile.lastActiveDate = today;
    } else {
        // Missed a day? Reset to 1. 😢
        profile.currentStreak = 1;
        profile.lastActiveDate = today;
    }

    await profile.save();
    return { profile, status: 'updated' };
};
// ----------------------------------

// --- NEW: Challenge Manager Helper ---
const updateChallenge = async (groupId, userId, name, wordsToAdd) => {
    const challenge = await GroupChallenge.findOne({ groupId });
    if (!challenge) return; // No active challenge in this group

    // 1. Update Total
    challenge.current += wordsToAdd;

    // 2. Update Individual Contributor
    if (!challenge.contributors[userId]) {
        challenge.contributors[userId] = { name: name, words: 0 };
    }
    challenge.contributors[userId].words += wordsToAdd;
    // Update name in case they changed it
    challenge.contributors[userId].name = name; 

    // 3. Check for VICTORY
    if (challenge.current >= challenge.target) {
        // Sort contributors by words
        const leaderboard = Object.values(challenge.contributors).sort((a, b) => b.words - a.words);
        const top = leaderboard[0];

        let txt = `🎉 *CHALLENGE DESTROYED!* 🎉\n` +
                  `━━━━━━━━━━━━━━━━\n` +
                  `🎯 Target: *${challenge.target.toLocaleString()} words*\n` +
                  `⚡ Final Total: ${challenge.current.toLocaleString()}\n\n` +
                  `👑 *MVP:* ${top.name} (${top.words})\n\n` +
                  `📜 *Contributors:* \n`;
        
        leaderboard.forEach((c, i) => {
            txt += `${i+1}. ${c.name}: ${c.words}\n`;
        });

        // Delete the finished challenge
        await GroupChallenge.deleteOne({ _id: challenge._id });
        
        return { completed: true, text: txt, mentions: Object.keys(challenge.contributors) };
    } else {
        // Just save progress
        await GroupChallenge.updateOne({ _id: challenge._id }, { current: challenge.current, contributors: challenge.contributors });
        return { completed: false };
    }
};
// -------------------------------------

const startSprintSession = async (chatId, duration) => {
if (activeSprints[chatId]) return false; 
console.log(`🏃 Sprint STARTED in ${chatId} for ${duration} mins`);
const endTime = Date.now() + duration * 60000;

activeSprints[chatId] = { duration, endsAt: endTime, participants: {} };

await ActiveSprint.create({ 
groupId: chatId, 
duration, 
endsAt: endTime, 
participants: {} 
});

await sock.sendMessage(chatId, { text: `🏃 *Writing Sprint Started!*\nDuration: *${duration} minutes*\n\nUse *!wc <number>* to log words.` });

setTimeout(async () => {
if (activeSprints[chatId]) {
try { 
await sock.sendMessage(chatId, { text: `🛑 **TIME'S UP!**\n\nReply with *!wc [number]* now.\nType *!finish* to end.` }); 
} 
catch (e) { console.log("Timeout error", e); }
}
}, duration * 60000);
return true;
};

setInterval(async () => {
if (!isConnected) return;
try {
const now = new Date();
const dueSprints = await ScheduledSprint.find({ startTime: { $lte: now } });
for (const sprint of dueSprints) {
const started = await startSprintSession(sprint.groupId, sprint.duration);
if (!started) {
await sock.sendMessage(sprint.groupId, { text: `⚠️ Scheduled sprint skipped.` });
} else {
    await sock.sendMessage(sprint.groupId, { 
        text: `(Sprint scheduled by @${sprint.createdBy.split('@')[0]})`,
        mentions: [sprint.createdBy] // <--- This turns the text into a blue clickable tag
    });
}
await ScheduledSprint.deleteOne({ _id: sprint._id });
}
} catch (e) { console.error("Scheduler Error:", e); }
}, 60000);

// =======================
//   BAILEYS INITIALIZATION
// =======================

const { state, saveCreds } = await useMultiFileAuthState('.auth_info_baileys');

const initializeBot = async () => {
const { version } = await fetchLatestBaileysVersion();

sock = makeWASocket({
version,
auth: state,
printQRInTerminal: false,
browser: ['Sprint Bot', 'Chrome', '120.0'],
msgRetryCounterMax: 15,
defaultQueryTimeoutMs: 60000,
});

// QR Code Event
sock.ev.on('connection.update', (update) => {
const { connection, lastDisconnect, qr } = update;

if (qr) {
qrCodeData = qr;
console.log('New QR Code Generated');
}

if (connection === 'connecting') {
console.log('⏳ Connecting...');
// ... inside sock.ev.on('connection.update') ...
} else if (connection === 'open') {
    isConnected = true;
    console.log('✅ Bot Connected!');
    qrCodeData = null;
    
    // --- NEW: Run initial cache update ---
    updateGroupCache(true); 
    // -------------------------------------
} else if (connection === 'close') {
isConnected = false;
const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
console.log('❌ Connection closed:', lastDisconnect?.error, 'Reconnecting:', shouldReconnect);

if (shouldReconnect) {
setTimeout(() => initializeBot(), 3000);
}
}
});

// Credentials Update
sock.ev.on('creds.update', saveCreds);

// Message Handler
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

// Extract text from message
let body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
if (!body.startsWith("!")) return;

// Get sender name (Default to Number)
    // 1. Get sender name (Default to Number)
    let senderName = senderId.split('@')[0];
    
    // 2. Try to get WhatsApp "PushName" (The name they set on their profile)
    // This comes directly with the message, so it is fast and reliable.
    if (msg.pushName) {
        senderName = msg.pushName;
    }

    // 3. CHECK DATABASE: If they have a custom !myname saved, OVERRIDE everything
    const savedProfile = await DailyStats.findOne({ userId: senderId }).sort({ timestamp: -1 });
    if (savedProfile && savedProfile.name) {
        senderName = savedProfile.name;
    }

const args = body.trim().split(" ");
const command = args[0].toLowerCase();
const todayStr = getTodayDateGMT1();

const getTargetId = (argIndex = 1) => {
// In Baileys, mentions are stored differently
// For now, try to parse number from args
const potentialNumber = args[argIndex]?.replace(/\D/g, '');
if (potentialNumber && potentialNumber.length > 5) return potentialNumber + '@c.us';
return null;
};

// --- ADMIN COMMANDS ---
if (isOwner) {
if (command === "!broadcast") {
const message = args.slice(1).join(" ");
if (!message) return sock.sendMessage(chatId, { text: "❌ Empty." }, { quoted: msg });

const chats = await sock.groupFetchAllParticipating();
let count = 0;

for (const [jid] of Object.entries(chats)) {
try {
await sock.sendMessage(jid, { text: `📢 *ANNOUNCEMENT*\n\n${message}` });
count++;
} catch(e) {}
}
return sock.sendMessage(chatId, { text: `✅ Broadcasted to ${count} groups.` }, { quoted: msg });
}

if (command === "!sys") {
const uptime = process.uptime();
return sock.sendMessage(chatId, { text: `⚙️ **System**\n⏱️ ${Math.floor(uptime/60)}m\n🔧 Maintenance: ${maintenanceMode ? "ON" : "OFF"}` }, { quoted: msg });
}

if (command === "!correct" || command === "!setword") {
const targetId = getTargetId(1);
const amount = parseInt(args[2]);
const isSet = command === "!setword";
if (!targetId || isNaN(amount)) return sock.sendMessage(chatId, { text: `❌ Usage: \`${command} number 500\`` }, { quoted: msg });

let filter = { userId: targetId, date: todayStr };
if (isGroup) filter.groupId = chatId;

let targetDoc = await DailyStats.findOne(filter).sort({ timestamp: -1 });

if (!targetDoc) {
const history = await DailyStats.findOne({ userId: targetId }).sort({ timestamp: -1 });
if (history) {
targetDoc = await DailyStats.create({ userId: targetId, groupId: isGroup ? chatId : history.groupId, date: todayStr, name: history.name, words: 0, timestamp: new Date() });
sock.sendMessage(chatId, { text: `✅ Created new entry.` }, { quoted: msg });
} else {
return sock.sendMessage(chatId, { text: "❌ User has no history." }, { quoted: msg });
}
}

if (isSet) {
const diff = amount - targetDoc.words;
targetDoc.words = amount;
await PersonalGoal.findOneAndUpdate({ userId: targetId, isActive: true }, { $inc: { current: diff } });
} else {
targetDoc.words += amount;
await PersonalGoal.findOneAndUpdate({ userId: targetId, isActive: true }, { $inc: { current: amount } });
}
targetDoc.timestamp = new Date();
await targetDoc.save();
return sock.sendMessage(chatId, { text: `✅ Done. New Total: ${targetDoc.words}` }, { quoted: msg });
}

if (command === "!leave") {
await sock.sendMessage(chatId, { text: "👋 Bye!" });
await sock.groupLeave(chatId);
return;
}
}

// --- REGULAR COMMANDS ---
if (command === "!help") {
    return sock.sendMessage(chatId, { text: 
`🤖 *SPRINT BOT COMMANDS*
━━━━━━━━━━━━━━━━━━

🍅 *Sprinting & Focus*
• *!sprint 20* → Start 20 min sprint
• *!pomo 25 5 4* → Start Pomodoro (Sprint/Break/Rounds)
• *!wc 500* → Log words (during sprint)
• *!time* → Check time remaining
• *!finish* → End sprint & view results
• *!cancel* → Stop current timer

⚔️ *Challenges*
• *!challenge 5000* → Start group boss battle
• *!challenge check* → View boss HP
• *!challenge stop* → Cancel challenge

📊 *Stats & Profile*
• *!profile* → Rank, Streak & Total
• *!daily* → Today's Global Leaderboard
• *!top10* → All-Time Hall of Fame
• *!myname Sam* → Set your display name

🎯 *Goals*
• *!goal set 1000* → Set daily target
• *!goal check* → View progress
• *!goal history* → View past records

⚙️ *Utils*
• *!log 500* → Add words manually (No timer)
• *!schedule 20 in 60* → Plan a sprint
• *!unschedule* → Cancel plans` }, { quoted: msg });
}

if (command === "!log") {
    let count = parseInt(args[1]);
    if (isNaN(count) || count <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!log 500`" }, { quoted: msg });
    
    try {
        // 1. Update Daily Leaderboard (Existing logic)
        await DailyStats.findOneAndUpdate({ userId: senderId, groupId: chatId, date: todayStr }, { name: senderName, $inc: { words: count }, timestamp: new Date() }, { upsert: true, new: true });
        
        // 2. Update Personal Goal (Existing logic)
        const goal = await PersonalGoal.findOne({ userId: senderId, isActive: true });
        if (goal) {
            goal.current += count;
            if (goal.current >= goal.target) { 
                goal.isActive = false; 
                await goal.save(); 
                await sock.sendMessage(chatId, { text: `🎉 *GOAL HIT!* 🏆\n\nCongratulations! You smashed your target of ${goal.target} words!` });
            } else {
                await goal.save();
            }
        }

        // 3. --- NEW: Update Streak & Profile ---
        const { profile } = await updateStreak(senderId, senderName, count);
        const streakIcon = profile.currentStreak > 2 ? `🔥 ${profile.currentStreak}` : `${profile.currentStreak}`;
        
        // --- NEW: Update Group Challenge ---
        const challengeRes = await updateChallenge(chatId, senderId, senderName, count);
        // -----------------------------------

        if (challengeRes && challengeRes.completed) {
            // Send Victory Message if challenge finished
            await sock.sendMessage(chatId, { text: challengeRes.text, mentions: challengeRes.mentions });
        } else {
            // Normal Log Message
            await sock.sendMessage(chatId, { text: `✅ Logged ${count} words.\n📈 Streak: ${streakIcon} days` }, { quoted: msg });
        }
    } catch (e) { console.error(e); }
}

if (command === "!top10" || command === "!top") {
const top = await DailyStats.aggregate([{ $group: { _id: "$name", total: { $sum: "$words" } } }, { $sort: { total: -1 } }, { $limit: 10 }]);
if (top.length === 0) return sock.sendMessage(chatId, { text: "📉 No data." }, { quoted: msg });
let txt = `🌎 **ALL-TIME HALL OF FAME**\n\n`;
top.forEach((w, i) => { txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} ${w._id}: ${w.total.toLocaleString()}\n`; });
await sock.sendMessage(chatId, { text: txt });
}

if (command === "!myname") {
const n = args.slice(1).join(" ");
if (!n) return sock.sendMessage(chatId, { text: "❌ Use: `!myname Sam`" }, { quoted: msg });
await DailyStats.updateMany({ userId: senderId }, { name: n });
await PersonalGoal.updateMany({ userId: senderId }, { name: n });
return sock.sendMessage(chatId, { text: `✅ Name: ${n}` }, { quoted: msg });
}

if (command === "!profile") {
    // 1. Get or Create Profile
    let profile = await UserProfile.findOne({ userId: senderId });
    
    // 2. FORCE SYNC: Calculate true total from DailyStats history
    const historyStats = await DailyStats.aggregate([
        { $match: { userId: senderId } },
        { $group: { _id: null, total: { $sum: "$words" } } }
    ]);
    const trueTotal = historyStats[0]?.total || 0;

    // If profile doesn't exist, create it with the true total
    if (!profile) {
        profile = await UserProfile.create({
            userId: senderId,
            name: senderName,
            currentStreak: 0,
            bestStreak: 0,
            lastActiveDate: "",
            totalWordsAllTime: trueTotal 
        });
    } else {
        // If profile exists but total is wrong (e.g. only showing 1), update it
        if (profile.totalWordsAllTime < trueTotal) {
            profile.totalWordsAllTime = trueTotal;
            await profile.save();
        }
    }

    const goal = await PersonalGoal.findOne({ userId: senderId, isActive: true });

    let rank = "Unranked ⚪"; 
    
    if (profile.totalWordsAllTime >= 10000) rank = "Aspiring Author ✍️";
    if (profile.totalWordsAllTime >= 50000) rank = "Novelist 📘";
    if (profile.totalWordsAllTime >= 100000) rank = "Prolific Writer 📚";
    if (profile.totalWordsAllTime >= 250000) rank = "Word Architect 🏗️";
    if (profile.totalWordsAllTime >= 500000) rank = "Word Expert 🎓";
    if (profile.totalWordsAllTime >= 1000000) rank = "Novel God ⚡";
    
    let txt = `👤 *WRITER PROFILE*\n` +
              `━━━━━━━━━━━━━━\n` +
              `📛 *${profile.name}*\n` +
              `🎖️ Rank: ${rank}\n\n` +
              `🔥 Current Streak: *${profile.currentStreak} days*\n` +
              `🏆 Best Streak: ${profile.bestStreak} days\n` +
              `📚 All-Time Words: ${profile.totalWordsAllTime.toLocaleString()}\n`;
    
    // --- VISUAL FIX: Add Progress Bar ---
    if (goal) {
        const rawPct = (goal.current / goal.target) * 100;
        const pct = Math.min(100, Math.max(0, rawPct));
        const filledCount = Math.round(pct / 10); 
        const emptyCount = 10 - filledCount;
        const bar = "🟩".repeat(filledCount) + "⬜".repeat(emptyCount);

        txt += `\n🎯 *Current Goal:*\n` + 
               "```" + `${goal.current} / ${goal.target}` + "```" + ` (${pct.toFixed(1)}%)\n` +
               `${bar}`;
    }

    return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
}

if (command === "!challenge") {
    const sub = args[1];
    
    // Check Status
    const active = await GroupChallenge.findOne({ groupId: chatId });
    
    if (sub === "status" || sub === "check") {
        if (!active) return sock.sendMessage(chatId, { text: "💤 No active challenge. Start one with `!challenge 5000`" }, { quoted: msg });
        const pct = ((active.current / active.target) * 100).toFixed(1);
        const bar = "🟩".repeat(Math.round(pct/10)) + "⬜".repeat(10 - Math.round(pct/10));
        return sock.sendMessage(chatId, { text: `⚔️ *Current Challenge*\n\n🎯 Target: ${active.target}\n📊 Progress: ${active.current} (${pct}%)\n${bar}` }, { quoted: msg });
    }

    // Stop Challenge
    if (sub === "stop" || sub === "cancel") {
        if (!active) return sock.sendMessage(chatId, { text: "❌ No challenge to stop." }, { quoted: msg });
        await GroupChallenge.deleteOne({ groupId: chatId });
        return sock.sendMessage(chatId, { text: "🚫 Challenge cancelled." }, { quoted: msg });
    }

    // Start New Challenge
    const target = parseInt(sub);
    if (isNaN(target) || target <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!challenge 5000`" }, { quoted: msg });

    if (active) return sock.sendMessage(chatId, { text: `⚠️ A challenge is already active (${active.current}/${active.target}).\nFinish it or use \`!challenge stop\`.` }, { quoted: msg });

    await GroupChallenge.create({
        groupId: chatId,
        target: target,
        current: 0,
        contributors: {},
        createdBy: senderId
    });

    return sock.sendMessage(chatId, { text: `⚔️ *NEW CHALLENGE STARTED!* ⚔️\n\n🎯 Target: *${target.toLocaleString()} words*\n\nEvery \`!log\` and sprint finish counts towards this goal. Let's write!` }, { quoted: msg });
}

if (command === "!sprint") {
    let m = parseInt(args[1]);
    if (isNaN(m) || m <= 0 || m > 180) return sock.sendMessage(chatId, { text: "❌ Use: `!sprint 20`" }, { quoted: msg });
    
    if (activeSprints[chatId]) {
        const s = activeSprints[chatId];
        const timeLeft = Math.ceil((s.endsAt - Date.now()) / 60000);
        return sock.sendMessage(chatId, { 
            text: `⚠️ **Sprint Already Active!**\n\nThere is a sprint running with approx *${timeLeft} mins* left.\n\nJoin in by typing \`!wc [number]\` now!` 
        }, { quoted: msg });
    }
    // ----------------------------

    await startSprintSession(chatId, m);
}

if (command === "!pomo") {
    // Usage: !pomo [sprint] [break] [rounds]
    // Default: 25 sprint, 5 break, 4 rounds
    const sprintTime = parseInt(args[1]) || 25;
    const breakTime = parseInt(args[2]) || 5;
    const rounds = parseInt(args[3]) || 4;

    if (activeSprints[chatId]) return sock.sendMessage(chatId, { text: "⚠️ A sprint is already running!" }, { quoted: msg });
    if (activePomodoros[chatId]) return sock.sendMessage(chatId, { text: "⚠️ A Pomodoro session is already active!" }, { quoted: msg });

    // Save Pomo State
    activePomodoros[chatId] = {
        sprintTime,
        breakTime,
        roundsLeft: rounds,
        totalRounds: rounds,
        isBreak: false
    };

    await sock.sendMessage(chatId, { 
        text: `🍅 *POMODORO STARTED!* 🍅\n\n🔄 Rounds: ${rounds}\n🏃 Sprint: ${sprintTime}m\n☕ Break: ${breakTime}m\n\n*Round 1/${rounds} starting NOW!*` 
    }, { quoted: msg });

    // Start First Sprint
    await startSprintSession(chatId, sprintTime);
}

if (command === "!schedule") {
if (args[2] !== 'in') return sock.sendMessage(chatId, { text: "❌ Use: `!schedule 20 in 60`" }, { quoted: msg });
const d = parseInt(args[1]), w = parseInt(args[3]);
if (isNaN(d) || isNaN(w)) return sock.sendMessage(chatId, { text: "❌ Invalid numbers." }, { quoted: msg });

const s = new Date(Date.now() + w * 60000);
await ScheduledSprint.create({ groupId: chatId, startTime: s, duration: d, createdBy: senderId });

const timeStr = s.toLocaleTimeString('en-GB', { timeZone: "Africa/Lagos", hour: '2-digit', minute: '2-digit' });

return sock.sendMessage(chatId, { text: `📅 *Sprint Scheduled!*\n\nDuration: ${d} mins\nStart: In ${w} mins (approx ${timeStr} GMT+1)` }, { quoted: msg });
}

if (command === "!unschedule") {
const r = await ScheduledSprint.deleteMany({ groupId: chatId });
if (r.deletedCount > 0) return sock.sendMessage(chatId, { text: `✅ Cancelled.` }, { quoted: msg });
return sock.sendMessage(chatId, { text: "🤷 None found." }, { quoted: msg });
}

if (command === "!time") {
const s = activeSprints[chatId];
if (!s) return sock.sendMessage(chatId, { text: "❌ No active sprint." }, { quoted: msg });
const r = s.endsAt - Date.now();
if (r <= 0) return sock.sendMessage(chatId, { text: "🛑 Time up!" }, { quoted: msg });
const endDates = new Date(s.endsAt);
const timeString = endDates.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });

return sock.sendMessage(chatId, { text: `⏳ *${Math.floor(r/60000)}m ${Math.floor((r/1000)%60)}s* remaining\n(Ends approx ${timeString})` }, { quoted: msg });
}

if (command === "!wc") {
    const s = activeSprints[chatId];
    
    // --- BETTER ERROR (Your Version) ---
    if (!s) return sock.sendMessage(chatId, { text: "❌ **No Active Sprint**\n\nYou can use !log to manually add your word count, or start a new sprint!\nTry typing: `!log 500` or `!sprint 20`" }, { quoted: msg });
    // -----------------------------------

    let c = parseInt(args[1]==='add'||args[1]==='+'?args[2]:args[1]);
    let add = args[1]==='add'||args[1]==='+';

    if (isNaN(c)) return sock.sendMessage(chatId, { text: "❌ Invalid." }, { quoted: msg });
    if (!s.participants[senderId]) s.participants[senderId] = { name: senderName, words: 0 };

    if (add) { 
        s.participants[senderId].words += c; 
        await sock.sendMessage(chatId, { text: `➕ Added. Total: ${s.participants[senderId].words}` }, { quoted: msg }); 
    }
    else { 
        s.participants[senderId].words = c; 
        await sock.sendMessage(chatId, { text: `✅` }, { quoted: msg }); 
    }

    await ActiveSprint.updateOne(
        { groupId: chatId }, 
        { $set: { participants: s.participants } }
    );
}

if (command === "!finish") {
    const s = activeSprints[chatId];
    if (!s) return sock.sendMessage(chatId, { text: "❌ No sprint." }, { quoted: msg });
    
    const l = Object.entries(s.participants).map(([u, d]) => ({ ...d, uid: u })).sort((a, b) => b.words - a.words);
    
    // Cleanup sprint data
    delete activeSprints[chatId]; 
    await ActiveSprint.deleteOne({ groupId: chatId });

    let mentions = []; 

    // 1. Handle Empty Sprint
    if (l.length === 0) { 
        console.log(`🏃 Sprint ENDED in ${chatId} (No participants)`);
        await sock.sendMessage(chatId, { 
            text: "🏃 **Sprint Finished**\n\nNo words were logged this time. 🦗" 
        }, { quoted: msg }); 

        if (!activePomodoros[chatId]) {
            return sock.sendMessage(chatId, { text: "Ready to try again? Type `!sprint 15` to start a new one!" });
        }
    } 
    
    // 2. Handle Sprint with Results
    else { 
        let txt = `🏆 *SPRINT RESULTS* 🏆\n\n`;

        for (let i = 0; i < l.length; i++) {
            let p = l[i];
            mentions.push(p.uid); // Collect IDs to tag later
            
            txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} @${p.uid.split('@')[0]} : ${p.words} words (${Math.round(p.words/s.duration)} WPM)\n`;
            
            try {
                // Stats & Gamification Updates
                await DailyStats.findOneAndUpdate({ userId: p.uid, groupId: chatId, date: todayStr }, { name: p.name, $inc: { words: p.words }, timestamp: new Date() }, { upsert: true });
                await updateStreak(p.uid, p.name, p.words);

                const g = await PersonalGoal.findOne({ userId: p.uid, isActive: true });
                if (g) { 
                    g.current += p.words; 
                    await g.save(); 
                    if (g.current >= g.target) { g.isActive = false; await g.save(); txt += `\n🎉 Goal Hit!`; } 
                }
                
                const chRes = await updateChallenge(chatId, p.uid, p.name, p.words);
                if (chRes && chRes.completed) {
                    setTimeout(async () => { await sock.sendMessage(chatId, { text: chRes.text, mentions: chRes.mentions }); }, 2000);
                }
            } catch (e) { console.error(e); }
        }

        if (!activePomodoros[chatId]) {
            txt += "\nGreat job, everyone!\n\n👉 *Next Step:* Type `!sprint 15` to go again or `!schedule` to plan ahead!";
        }

        await sock.sendMessage(chatId, { text: txt, mentions: mentions });
    }

    // 3. POMODORO LOGIC (Updated with Tagging)
    if (activePomodoros[chatId]) {
        const pomo = activePomodoros[chatId];
        pomo.roundsLeft--;

        // --- NEW: SAVE PARTICIPANTS ---
        // We save the 'mentions' array from the sprint so we can tag them later
        if (mentions.length > 0) pomo.lastParticipants = mentions;
        // ------------------------------

        if (pomo.roundsLeft > 0) {
            // START BREAK
            pomo.isBreak = true;
            await sock.sendMessage(chatId, { 
                text: `🛑 *Sprint Ended!* \n\n☕ Take a *${pomo.breakTime} min* break.\nNext round starts automatically.` 
            });

            setTimeout(async () => {
                // Check if Pomo wasn't cancelled during the break
                if (activePomodoros[chatId]) {
                    pomo.isBreak = false;
                    const roundNum = pomo.totalRounds - pomo.roundsLeft + 1;
                    
                    // --- NEW: TAG PARTICIPANTS ---
                    const writersToTag = pomo.lastParticipants || [];
                    const tagText = writersToTag.length > 0 ? `\n\nSummoning: ${writersToTag.map(id => '@' + id.split('@')[0]).join(' ')}` : "";
                    
                    await sock.sendMessage(chatId, { 
                        text: `🔔 *BREAK OVER!* \n\n🏃 Round ${roundNum}/${pomo.totalRounds}: ${pomo.sprintTime} mins!\nWrite! Write! Write!${tagText}`,
                        mentions: writersToTag
                    });
                    // -----------------------------
                    
                    await startSprintSession(chatId, pomo.sprintTime);
                }
            }, pomo.breakTime * 60000); 

        } else {
            // POMO FINISHED
            delete activePomodoros[chatId];
            await sock.sendMessage(chatId, { text: `🎉 *POMODORO COMPLETE!* 🍅\n\nYou survived ${pomo.totalRounds} rounds. Amazing focus!` });
        }
    }
}

if (["!daily", "!weekly", "!monthly"].includes(command)) {
const d = command === "!daily";
const days = d ? 1 : command === "!weekly" ? 7 : 30;

let title = "";
if (d) title = `Daily Leaderboard (${todayStr})`;
else if (command === "!weekly") title = "Weekly Leaderboard";
else title = "Monthly Leaderboard";

// ... inside the ["!daily", "!weekly", "!monthly"] block ...

let stats;
if (d) {
    // DAILY: Global Sync (Aggregates words across ALL groups for today)
    stats = await DailyStats.aggregate([
        { $match: { date: todayStr } }, // 1. Find all logs for today
        { $group: { 
            _id: "$userId", 
            totalWords: { $sum: "$words" }, // 2. Sum them up per user
            name: { $first: "$name" },
            streak: { $first: "$userId" } // Hack to pass ID for streak check later
        }}, 
        { $sort: { totalWords: -1 } }, 
        { $limit: 15 }
    ]);
}
else {
    // WEEKLY/MONTHLY: (Already aggregated correctly in your old code, but let's ensure it's global too)
    const dt = new Date(); dt.setDate(dt.getDate() - days);
    stats = await DailyStats.aggregate([
        { $match: { timestamp: { $gte: dt } } }, // Remove 'groupId: chatId' to make it global
        { $group: { _id: "$userId", totalWords: { $sum: "$words" }, name: { $first: "$name" } } }, 
        { $sort: { totalWords: -1 } }, 
        { $limit: 15 }
    ]);
}

if (stats.length === 0) return sock.sendMessage(chatId, { text: "📉 No stats." }, { quoted: msg });

let txt = `🏆 *${title}*\n\n`;

// Fetch streaks for visual flare
for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    
    // Check streak
    const p = await UserProfile.findOne({ userId: s._id });
    const fire = (p && p.currentStreak > 2) ? "🔥" : "";
    
    txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} ${s.name} ${fire}: ${s.totalWords.toLocaleString()} words\n`;
}

await sock.sendMessage(chatId, { text: txt });
}

if (command === "!goal") {
    const sub = args[1]?.toLowerCase();

    // 1. SET GOAL
    if (sub === "set") {
        const t = parseInt(args[2]);
        if (isNaN(t)) return sock.sendMessage(chatId, { text: "❌ Use: `!goal set 5000`" }, { quoted: msg });
        await PersonalGoal.updateMany({ userId: senderId }, { isActive: false });
        await PersonalGoal.create({ userId: senderId, name: senderName, target: t, current: 0 });
        return sock.sendMessage(chatId, { text: `🎯 Goal set: ${t} words` }, { quoted: msg });
    }

    // 2. GOAL HISTORY (Moved outside of 'check')
    if (sub === "history") {
        const history = await PersonalGoal.find({ userId: senderId, isActive: false })
                                          .sort({ _id: -1 })
                                          .limit(5);

        if (history.length === 0) {
            return sock.sendMessage(chatId, { text: "📜 No past goals found." }, { quoted: msg });
        }

        let txt = `📜 *GOAL HISTORY (Last 5)*\n━━━━━━━━━━━━━━\n`;

        history.forEach((g) => {
            const percent = Math.min(100, (g.current / g.target) * 100).toFixed(1);
            const isWin = g.current >= g.target;
            const icon = isWin ? "✅" : "❌";
            
            txt += `${icon} *${g.startDate}*\n`;
            txt += `   Target: ${g.target.toLocaleString()} words\n`;
            txt += `   Result: ${g.current.toLocaleString()} (${percent}%)\n\n`;
        });

        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    // 3. CHECK GOAL (Default if no other sub-command matches, or explicit 'check')
    if (sub === "check" || !sub) {
        const g = await PersonalGoal.findOne({ userId: senderId, isActive: true });
        if (!g) return sock.sendMessage(chatId, { text: "❌ No active goal. Start one with `!goal set [number]`" }, { quoted: msg });

        const rawPct = (g.current / g.target) * 100;
        const pct = Math.min(100, Math.max(0, rawPct));
        const filledCount = Math.round(pct / 10); 
        const emptyCount = 10 - filledCount;
        const bar = "🟩".repeat(filledCount) + "⬜".repeat(emptyCount);

        const txt = `🎯 *Goal Progress*\n` +
        `👤 ${g.name}\n` +
        `📊 ` + "```" + `${g.current} / ${g.target}` + "```" + ` words\n` + 
        `${bar} (${rawPct.toFixed(1)}%)\n` +
        `📅 Started: ${g.startDate}`;

        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }
}

if (command === "!cancel" || command === "!stop") {
    let text = "";

    // Cancel Sprint
    if (activeSprints[chatId]) {
        clearTimeout(activeSprints[chatId].timeout); // Stop timer
        delete activeSprints[chatId];
        await ActiveSprint.deleteOne({ groupId: chatId });
        text += "🚫 Sprint cancelled.\n";
    }

    // Cancel Pomodoro
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

process.on('unhandledRejection', (reason, promise) => {
console.log('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
console.log('⚠️ Uncaught Exception:', err);
});