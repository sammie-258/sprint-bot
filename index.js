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

const OWNER_NUMBER = '2347087899166@c.us'; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; 

app.use(express.json()); 

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
let groupCache = {}; // Stores ID -> Name mapping
let lastCacheUpdate = 0;

const updateGroupCache = async (force = false) => {
    // Only update if 5 minutes have passed, or if forced
    if (!force && Date.now() - lastCacheUpdate < 5 * 60 * 1000) return;
    
    if (sock && isConnected) {
        try {
            const groups = await sock.groupFetchAllParticipating();
            for (const [jid, data] of Object.entries(groups)) {
                groupCache[jid] = data.subject;
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

const MONGO_URI = process.env.MONGO_URI; 
if (!MONGO_URI) { console.error("❌ ERROR: MONGO_URI is missing!"); process.exit(1); }

let activeSprints = {}; 

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
            name: groupCache[g._id] || g._id || "Unknown Group", // READ FROM CACHE
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
                name: groupCache[chatId] || chatId, // READ FROM CACHE
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
            groupName: groupCache[s.groupId] || s.groupId, // READ FROM CACHE
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

app.post('/api/admin/search', requireAdmin, async (req, res) => {
try {
const { query } = req.body;
const users = await DailyStats.aggregate([
{ $match: { name: { $regex: query, $options: 'i' } } },
{ $group: { _id: "$userId", name: { $first: "$name" }, totalWords: { $sum: "$words" }, lastActive: { $max: "$date" } } },
{ $limit: 15 }
]);
res.json(users);
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/groups', requireAdmin, async (req, res) => {
    try {
        await updateGroupCache(); // Check if update needed

        // We need the full list, so we might need to map the cache keys
        const groupList = Object.entries(groupCache).map(([jid, name]) => ({
            id: jid,
            name: name,
            participants: 0 // Note: Caching names means we lose live participant count here to save bandwidth
        }));

        res.json(groupList);
    } catch (e) {
        console.error("Admin Group Fetch Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/update', requireAdmin, async (req, res) => {
    try {
        const { userId, amount, type, name } = req.body; // Added 'name' here

        // --- NEW: Handle Name Update ---
        if (type === 'name') {
            if (!name || name.trim() === "") {
                return res.status(400).json({ error: "Name cannot be empty." });
            }
            
            // Update the name in ALL past records so the leaderboard stays consistent
            await DailyStats.updateMany({ userId }, { name });
            
            // Update the name in their personal goal settings too
            await PersonalGoal.updateMany({ userId }, { name });

            return res.json({ success: true, message: `Name updated to ${name}` });
        }
        // -------------------------------

        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });

        let doc = await DailyStats.findOne({ userId, date: todayStr }).sort({ timestamp: -1 });

        if (!doc) {
            const history = await DailyStats.findOne({ userId }).sort({ timestamp: -1 });
            if (!history) return res.status(404).json({ message: "No history found for this user." });

            doc = await DailyStats.create({
                userId, name: history.name, groupId: history.groupId,
                date: todayStr, words: 0, timestamp: new Date()
            });
        }

        if (type === 'set') {
            const diff = parseInt(amount) - doc.words;
            doc.words = parseInt(amount);
            doc.timestamp = new Date();
            await doc.save();
            await PersonalGoal.findOneAndUpdate({ userId, isActive: true }, { $inc: { current: diff } });
        } else {
            // Default is 'add'
            doc.words += parseInt(amount);
            doc.timestamp = new Date();
            await doc.save();
            await PersonalGoal.findOneAndUpdate({ userId, isActive: true }, { $inc: { current: parseInt(amount) } });
        }
        res.json({ success: true, newTotal: doc.words });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
try {
const { message } = req.body;
if (!sock || !isConnected) return res.status(500).json({ error: "Bot offline" });

const chats = await sock.groupFetchAllParticipating();
let count = 0;

for (const [jid, group] of Object.entries(chats)) {
try {
await sock.sendMessage(jid, { text: `📢 *ANNOUNCEMENT*\n\n${message}` });
count++;
await new Promise(r => setTimeout(r, 500));
} catch(e) { console.log("Broadcast error", e); }
}

res.json({ success: true, count });
} catch (e) { res.status(500).json({ error: e.message }); }
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
    let senderName = senderId.split('@')[0];
    
    // 1. Try to get WhatsApp Profile Name
    try {
        const contact = await sock.getContactBasicInfo(senderId);
        if (contact.pushName) senderName = contact.pushName;
    } catch (err) { senderName = senderId.split('@')[0]; }

    // 2. CHECK DATABASE: If they have a custom name saved from before, use that instead
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
return sock.sendMessage(chatId, { text: `🤖 *SPRINT BOT MENU*

🏃 *Sprinting*
!sprint 20 : Start a 20 min sprint
!wc 500 : Log 500 words
!time : Check time remaining
!finish : End sprint & view results
!cancel : Stop the current timer

📅 *Planning*
!schedule 20 in 60 : Sprint in 60 mins
!unschedule : Cancel scheduled sprints

📊 *Stats & Goals*
!daily : Today's leaderboard
!weekly : Last 7 days leaderboard
!monthly : Last 30 days leaderboard
!top10 : All-time Hall of Fame
!goal set 50000 : Set personal target
!goal check : View goal progress

⚙ *Utils*
!log 500 : Manually add words (no timer)
!myname Sam : Update your display name` }, { quoted: msg });
}

if (command === "!log") {
let count = parseInt(args[1]);
if (isNaN(count) || count <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!log 500`" }, { quoted: msg });
try {
await DailyStats.findOneAndUpdate({ userId: senderId, groupId: chatId, date: todayStr }, { name: senderName, $inc: { words: count }, timestamp: new Date() }, { upsert: true, new: true });
const goal = await PersonalGoal.findOne({ userId: senderId, isActive: true });

await sock.sendMessage(chatId, { text: `✅ Logged ${count} words.` }, { quoted: msg });

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

if (command === "!sprint") {
let m = parseInt(args[1]);
if (isNaN(m) || m <= 0 || m > 180) return sock.sendMessage(chatId, { text: "❌ Use: `!sprint 20`" }, { quoted: msg });
if (activeSprints[chatId]) return sock.sendMessage(chatId, { text: "⚠️ Running." }, { quoted: msg });
await startSprintSession(chatId, m);
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
if (!s) return sock.sendMessage(chatId, { text: "❌ No sprint." }, { quoted: msg });

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
    
    if (l.length === 0) { 
        delete activeSprints[chatId]; 
        await ActiveSprint.deleteOne({ groupId: chatId });
        console.log(`🏃 Sprint ENDED in ${chatId} (No participants)`);
        return sock.sendMessage(chatId, { text: "🏃 Ended. Empty." }, { quoted: msg }); 
    }

    let txt = `🏆 *SPRINT RESULTS* 🏆\n\n`;
    let mentions = []; // 1. Create array to store IDs

    for (let i = 0; i < l.length; i++) {
        let p = l[i];
        mentions.push(p.uid); // 2. Add user ID to mentions list
        
        // 3. Use @number format in the text string
        txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} @${p.uid.split('@')[0]} : ${p.words} words (${Math.round(p.words/s.duration)} WPM)\n`;
        
        try {
            await DailyStats.findOneAndUpdate({ userId: p.uid, groupId: chatId, date: todayStr }, { name: p.name, $inc: { words: p.words }, timestamp: new Date() }, { upsert: true });
            const g = await PersonalGoal.findOne({ userId: p.uid, isActive: true });
            if (g) { 
                g.current += p.words; 
                await g.save(); 
                if (g.current >= g.target) { 
                    g.isActive = false; 
                    await g.save(); 
                    txt += `\n🎉 Goal Hit!`; 
                } 
            }
        } catch (e) {}
    }
    delete activeSprints[chatId];
    await ActiveSprint.deleteOne({ groupId: chatId });

    console.log(`🏃 Sprint ENDED in ${chatId} with ${l.length} writers`);

    txt += "\nGreat job, everyone!\n\n👉 *Next Step:* Type `!sprint 15` to go again or `!schedule` to plan ahead!";

    // 4. Pass the mentions array here
    await sock.sendMessage(chatId, { text: txt, mentions: mentions });
}

if (["!daily", "!weekly", "!monthly"].includes(command)) {
const d = command === "!daily";
const days = d ? 1 : command === "!weekly" ? 7 : 30;

let title = "";
if (d) title = `Daily Leaderboard (${todayStr})`;
else if (command === "!weekly") title = "Weekly Leaderboard";
else title = "Monthly Leaderboard";

let stats;
if (d) stats = await DailyStats.find({ groupId: chatId, date: todayStr }).sort({ words: -1 });
else {
const dt = new Date(); dt.setDate(dt.getDate() - days);
stats = await DailyStats.aggregate([{ $match: { groupId: chatId, timestamp: { $gte: dt } } }, { $group: { _id: "$userId", totalWords: { $sum: "$words" }, name: { $first: "$name" } } }, { $sort: { totalWords: -1 } }, { $limit: 15 }]);
}
if (stats.length === 0) return sock.sendMessage(chatId, { text: "📉 No stats." }, { quoted: msg });
let txt = `🏆 *${title}*\n\n`;
stats.forEach((s, i) => { txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} ${s.name}: ${d ? s.words : s.totalWords} words\n`; });
await sock.sendMessage(chatId, { text: txt });
}

if (command === "!goal") {
const sub = args[1]?.toLowerCase();

if (sub === "set") {
const t = parseInt(args[2]);
if (isNaN(t)) return sock.sendMessage(chatId, { text: "❌ Use: `!goal set 5000`" }, { quoted: msg });
await PersonalGoal.updateMany({ userId: senderId }, { isActive: false });
await PersonalGoal.create({ userId: senderId, name: senderName, target: t, current: 0 });
return sock.sendMessage(chatId, { text: `🎯 Goal set: ${t} words` }, { quoted: msg });
}

if (sub === "check") {
const g = await PersonalGoal.findOne({ userId: senderId, isActive: true });
if (!g) return sock.sendMessage(chatId, { text: "❌ No active goal. Start one with `!goal set [number]`" }, { quoted: msg });

const rawPct = (g.current / g.target) * 100;
const pct = Math.min(100, Math.max(0, rawPct));
const filledCount = Math.round(pct / 10); 
const emptyCount = 10 - filledCount;
const bar = "🟩".repeat(filledCount) + "⬜".repeat(emptyCount);

const txt = `🎯 *Goal Progress*\n` +
`👤 ${g.name}\n` +
`📊 ` + "```" + `${g.current} / ${g.target}` + "```" + ` words\n` +  // <--- Wrapped in ``` for highlighting
`${bar} (${rawPct.toFixed(1)}%)\n` +
`📅 Started: ${g.startDate}`;

return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
}
}

if (command === "!cancel") {
if (activeSprints[chatId]) { 
delete activeSprints[chatId]; 
await ActiveSprint.deleteOne({ groupId: chatId }); 
await sock.sendMessage(chatId, { text: "🚫 Cancelled." }, { quoted: msg }); 
}
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