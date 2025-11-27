// =======================
//       IMPORTS
// =======================
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require("mongoose");
const QRCode = require('qrcode');
const express = require('express');
const http = require('http'); 
require("dotenv").config();

// =======================
//   CONFIG & SERVER SETUP
// =======================
const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = "Africa/Lagos"; // GMT+1

// 👑 SUPER ADMIN CONFIG
const OWNER_NUMBER = '2347087899166'; // Plain number
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // ⚠️ Set this in Render ENV

// 🟢 MIDDLEWARE
app.use(express.json()); // Allow reading JSON from Web Admin

// CORS: Allow external websites (Dashboard/Admin Panel)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); 
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, x-admin-password");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
let client = null; 

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

const MONGO_URI = process.env.MONGO_URI; 
if (!MONGO_URI) {
    console.error("❌ ERROR: MONGO_URI is missing!");
    process.exit(1);
}

// In-memory active sprints
let activeSprints = {}; 

// =======================
//   WEB API ENDPOINTS
// =======================

// Root Route
app.get('/', async (req, res) => {
    if (isConnected) {
        res.send('<h1>✅ Sprint Bot is Online</h1><p>API is active.</p>');
    } else if (qrCodeData) {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`<div style="text-align:center;padding-top:50px;"><h1>Scan with WhatsApp</h1><img src="${qrImage}"><p>Refresh page if code expires.</p></div>`);
    } else {
        res.send('<h1>⏳ Booting up... refresh in 10s.</h1>');
    }
});

// 🟢 PUBLIC DASHBOARD DATA
app.get('/api/stats', async (req, res) => {
    try {
        let qrImage = null;
        if (!isConnected && qrCodeData) {
            qrImage = await QRCode.toDataURL(qrCodeData);
        }

        // 1. Top 10 All-Time (Group by Name)
        const topWritersRaw = await DailyStats.aggregate([
            { $group: { _id: "$name", total: { $sum: "$words" } } }, 
            { $sort: { total: -1 } },
            { $limit: 10 }
        ]);
        const topWriters = topWritersRaw.map(w => ({ name: w._id, words: w.total }));

        // 2. Today's Top 10 (Group by Name)
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const todayWritersRaw = await DailyStats.aggregate([
            { $match: { date: todayStr } }, 
            { $group: { _id: "$name", total: { $sum: "$words" } } }, 
            { $sort: { total: -1 } },       
            { $limit: 10 }
        ]);
        const todayWriters = todayWritersRaw.map(w => ({ name: w._id, words: w.total }));

        // 3. Totals
        const totalWordsAgg = await DailyStats.aggregate([{ $group: { _id: null, total: { $sum: "$words" } } }]);
        const totalWords = totalWordsAgg[0]?.total || 0;
        const totalWritersAgg = await DailyStats.distinct("name");
        const totalWriters = totalWritersAgg.length;
        const totalGroupsAgg = await DailyStats.distinct("groupId");
        const totalGroups = totalGroupsAgg.length;

        // 4. Top Groups
        const topGroupsRaw = await DailyStats.aggregate([
            { $group: { _id: "$groupId", total: { $sum: "$words" } } },
            { $sort: { total: -1 } },
            { $limit: 10 }
        ]);

        const topGroups = await Promise.all(topGroupsRaw.map(async (g) => {
            let groupName = "Unknown Group";
            if (g._id === "Manual_Correction") return null; // Skip ghost group
            
            if (client && isConnected) {
                try {
                    const chat = await client.getChatById(g._id);
                    if (chat && chat.name) groupName = chat.name;
                } catch (e) {}
            }
            return { name: groupName, words: g.total };
        }));

        // 5. Chart Data
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const chartDataRaw = await DailyStats.aggregate([
            { $match: { timestamp: { $gte: sevenDaysAgo } } },
            { $group: { _id: "$date", total: { $sum: "$words" } } },
            { $sort: { _id: 1 } } 
        ]);
        const chartData = {
            labels: chartDataRaw.map(d => d._id), 
            data: chartDataRaw.map(d => d.total)
        };

        res.json({ 
            isConnected, 
            qrCode: qrImage, 
            topWriters, 
            todayWriters, 
            totalWords, 
            totalWriters, 
            totalGroups: totalGroups.filter(g => g !== null).length, 
            topGroups: topGroups.filter(g => g !== null), 
            chartData 
        });

    } catch (e) {
        console.error("API Error:", e);
        res.status(500).json({ error: "Server Error" });
    }
});

// 👑 ADMIN API: SEARCH USER
app.post('/api/admin/search', requireAdmin, async (req, res) => {
    try {
        const { query } = req.body;
        // Search by name (case insensitive)
        const users = await DailyStats.aggregate([
            { $match: { name: { $regex: query, $options: 'i' } } },
            { $group: { _id: "$userId", name: { $first: "$name" }, totalWords: { $sum: "$words" }, lastActive: { $max: "$date" } } },
            { $limit: 10 }
        ]);
        res.json(users);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 👑 ADMIN API: EDIT STATS (Set/Add Word Count)
app.post('/api/admin/update', requireAdmin, async (req, res) => {
    try {
        const { userId, amount, type } = req.body; // type: 'set' or 'add'
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        
        // Find user's entry for today (most recent active group)
        const doc = await DailyStats.findOne({ userId, date: todayStr }).sort({ timestamp: -1 });

        if (!doc) return res.status(404).json({ message: "User has no entry for today to edit. User must sprint first." });

        if (type === 'set') {
            const diff = amount - doc.words;
            doc.words = parseInt(amount);
            doc.name = "Fixed by Admin";
            doc.timestamp = new Date();
            await doc.save();
            await PersonalGoal.findOneAndUpdate({ userId, isActive: true }, { $inc: { current: diff } });
        } else {
            // Add (Correct)
            doc.words += parseInt(amount);
            doc.timestamp = new Date();
            await doc.save();
            await PersonalGoal.findOneAndUpdate({ userId, isActive: true }, { $inc: { current: parseInt(amount) } });
        }

        res.json({ success: true, newTotal: doc.words });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 👑 ADMIN API: BROADCAST
app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
    try {
        const { message } = req.body;
        if (!client || !isConnected) return res.status(500).json({ error: "Bot offline" });

        const chats = await client.getChats();
        const groups = chats.filter(c => c.id.server === 'g.us');
        
        for (const group of groups) {
            await group.sendMessage(`📢 *ANNOUNCEMENT*\n\n${message}`);
        }
        res.json({ success: true, count: groups.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

// 🟢 KEEP-ALIVE
setInterval(() => {
    http.get(`http://localhost:${PORT}/`, (res) => {}).on('error', (err) => {});
}, 5 * 60 * 1000); 

// =======================
//   MAIN LOGIC
// =======================
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB connected successfully");

        const store = new MongoStore({ mongoose: mongoose });

        client = new Client({
            authStrategy: new RemoteAuth({
                store: store,
                backupSyncIntervalMs: 300000
            }),
            puppeteer: {
                headless: true,
                args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-accelerated-2d-canvas", "--no-first-run", "--no-zygote", "--single-process", "--disable-gpu"]
            }
        });

        // --- HELPER: TIMEZONES ---
        const getCurrentTimeGMT1 = () => new Date().toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour12: false });
        const getTodayDateGMT1 = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const formatTimeGMT1 = (dateObj) => dateObj.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });

        // --- SHARED SPRINT START ---
        const startSprintSession = async (chatId, duration) => {
            if (activeSprints[chatId]) return false; 
            const endTime = Date.now() + duration * 60000;
            console.log(`[${getCurrentTimeGMT1()}] Starting sprint in ${chatId}. Duration: ${duration}m.`);

            activeSprints[chatId] = {
                duration: duration, 
                endsAt: endTime,
                participants: {}
            };

            const chat = await client.getChatById(chatId);
            await chat.sendMessage(`🏁 *Writing Sprint Started!*\nDuration: *${duration} minutes*\n\nUse *!wc <number>* to log words.`);

            setTimeout(async () => {
                if (activeSprints[chatId]) {
                    try {
                        await chat.sendMessage(`🛑 **TIME'S UP!**\n\nReply with *!wc [number]* now.\nType *!finish* to end.`);
                    } catch (e) { console.log("Timeout error", e); }
                }
            }, duration * 60000);
            return true;
        };

        // --- SCHEDULER WATCHER ---
        setInterval(async () => {
            if (!isConnected) return;
            try {
                const now = new Date();
                const dueSprints = await ScheduledSprint.find({ startTime: { $lte: now } });
                for (const sprint of dueSprints) {
                    const started = await startSprintSession(sprint.groupId, sprint.duration);
                    if (!started) {
                        const chat = await client.getChatById(sprint.groupId);
                        await chat.sendMessage(`⚠️ Scheduled sprint skipped because a sprint is already running.`);
                    } else {
                        const chat = await client.getChatById(sprint.groupId);
                        await chat.sendMessage(`(This sprint was scheduled by @${sprint.createdBy.split('@')[0]})`, { mentions: [sprint.createdBy] });
                    }
                    await ScheduledSprint.deleteOne({ _id: sprint._id });
                }
            } catch (e) { console.error("Scheduler Error:", e); }
        }, 60000); 

        // --- CLIENT EVENTS ---
        client.on("qr", qr => { qrCodeData = qr; console.log(`[${getCurrentTimeGMT1()}] New QR Code generated`); });
        client.on("ready", () => { isConnected = true; console.log(`[${getCurrentTimeGMT1()}] Client is ready!`); });

        // --- MESSAGE HANDLER ---
        client.on("message", async msg => {
            try {
                const chat = await msg.getChat();
                const chatId = chat.id._serialized;
                let senderId = msg.author || msg.from;
                
                if (await Blacklist.exists({ userId: senderId })) return;

                // 🛡️ OWNER CHECK
                const isOwner = senderId.includes(OWNER_NUMBER);

                if (!chat.isGroup && !isOwner) return;

                // 🛡️ NAME RECOVERY
                let senderName = senderId.split('@')[0]; 
                try {
                    const contact = await msg.getContact();
                    senderId = contact.id._serialized; 
                    if (contact.pushname) senderName = contact.pushname;
                    else if (contact.name) senderName = contact.name;
                    else if (contact.number) senderName = contact.number;
                } catch (err) {
                    senderName = msg._data?.notifyName || senderId.split('@')[0];
                }

                if (!msg.body.startsWith("!")) return;

                const args = msg.body.trim().split(" ");
                const command = args[0].toLowerCase();
                const todayString = getTodayDateGMT1; 

                // Helper: Get Target ID
                const getTargetId = (argIndex = 1) => {
                    if (msg.mentionedIds.length > 0) return msg.mentionedIds[0];
                    const potentialNumber = args[argIndex]?.replace(/\D/g, '');
                    if (potentialNumber && potentialNumber.length > 5) {
                        return potentialNumber + '@c.us';
                    }
                    return null;
                };

                // Helper: Get Target Name
                const getTargetName = async (targetId) => {
                    try {
                        const contact = await client.getContactById(targetId);
                        return contact.pushname || contact.name || contact.number || "Writer";
                    } catch (e) { return "Writer"; }
                };

                // ==========================================
                // 👑 SUPER ADMIN COMMANDS
                // ==========================================
                if (isOwner) {
                    
                    if (command === "!broadcast") {
                        const message = args.slice(1).join(" ");
                        if (!message) return msg.reply("❌ Message empty.");
                        
                        const chats = await client.getChats();
                        const groups = chats.filter(c => c.id.server === 'g.us');
                        
                        msg.reply(`📢 Broadcasting to ${groups.length} groups...`);
                        for (const group of groups) { await group.sendMessage(`📢 *ANNOUNCEMENT*\n\n${message}`); }
                        return;
                    }

                    if (command === "!groups") {
                        const chats = await client.getChats();
                        const groups = chats.filter(c => c.id.server === 'g.us');
                        let report = `🤖 **I am in ${groups.length} groups:**\n\n`;
                        groups.forEach((g, i) => { report += `${i+1}. ${g.name}\n`; });
                        return msg.reply(report);
                    }

                    if (command === "!sys") {
                        const uptime = process.uptime();
                        const mem = process.memoryUsage().heapUsed / 1024 / 1024;
                        return msg.reply(`⚙️ **System Status**\n\n⏱️ Uptime: ${Math.floor(uptime / 60)} mins\n💾 Memory: ${mem.toFixed(2)} MB`);
                    }

                    // 🛠️ CORRECT (Smart Update)
                    if (command === "!correct") {
                        const targetId = getTargetId(1);
                        const amount = parseInt(args[2]);

                        if (!targetId || isNaN(amount)) return msg.reply("❌ Usage: `!correct @User -500`");

                        const todayStr = todayString();
                        let filter = { userId: targetId, date: todayStr };
                        
                        // Smart Group Detection
                        if (chat.isGroup) {
                            filter.groupId = chatId;
                        } 

                        // Find document logic: Try to find existing doc
                        // If in DM, sorting by timestamp -1 ensures we get the LATEST activity from any group
                        const targetDoc = await DailyStats.findOne(filter).sort({ timestamp: -1 });

                        if (!targetDoc) {
                            if (chat.isGroup) {
                                // Create new only if in group context
                                const targetName = await getTargetName(targetId);
                                await DailyStats.create({
                                    userId: targetId, groupId: chatId, date: todayStr,
                                    name: targetName, words: amount, timestamp: new Date()
                                });
                                return msg.reply(`✅ Created new entry for ${targetName} with ${amount} words.`);
                            } else {
                                return msg.reply("❌ User has no active sprint record today. I cannot create a new one from DM (unknown group). Please use this command inside their group.");
                            }
                        }

                        targetDoc.words += amount;
                        targetDoc.timestamp = new Date();
                        await targetDoc.save();

                        await PersonalGoal.findOneAndUpdate({ userId: targetId, isActive: true }, { $inc: { current: amount } });
                        return msg.reply(`✅ Adjusted count by ${amount}. New Total: ${targetDoc.words}`);
                    }

                    // 🛠️ SETWORD (Smart Update)
                    if (command === "!setword") {
                        const targetId = getTargetId(1);
                        const amount = parseInt(args[2]);

                        if (!targetId || isNaN(amount)) return msg.reply("❌ Usage: `!setword @User 2500`");

                        const todayStr = todayString();
                        let filter = { userId: targetId, date: todayStr };
                        if (chat.isGroup) filter.groupId = chatId;

                        const targetDoc = await DailyStats.findOne(filter).sort({ timestamp: -1 });

                        if (!targetDoc) {
                            if (chat.isGroup) {
                                const targetName = await getTargetName(targetId);
                                await DailyStats.create({
                                    userId: targetId, groupId: chatId, date: todayStr,
                                    name: targetName, words: amount, timestamp: new Date()
                                });
                                return msg.reply(`✅ Created new entry set to ${amount}.`);
                            } else {
                                return msg.reply("❌ No record found today to update. Please run inside the group.");
                            }
                        }

                        targetDoc.words = amount;
                        targetDoc.name = "Fixed by Admin"; 
                        await targetDoc.save();
                        
                        return msg.reply(`✅ Forced daily count to **${amount}**.`);
                    }

                    // 🛠️ SETNAME (Admin fix for "Writer")
                    if (command === "!setname") {
                        const targetId = getTargetId(1);
                        const nameStartIndex = msg.mentionedIds.length > 0 ? 2 : 2; 
                        const newName = args.slice(nameStartIndex).join(" ");

                        if (!targetId || !newName) return msg.reply("❌ Usage: `!setname @User New Name`");

                        await DailyStats.updateMany({ userId: targetId }, { name: newName });
                        await PersonalGoal.updateMany({ userId: targetId }, { name: newName });
                        return msg.reply(`✅ Updated name to **${newName}** for all records.`);
                    }

                    // 🛠️ CLEAN GHOSTS
                    if (command === "!cleanghosts") {
                        const res = await DailyStats.deleteMany({ groupId: "Manual_Correction" });
                        return msg.reply(`🧹 Cleaned up ${res.deletedCount} ghost records.`);
                    }

                    if (command === "!wipe") {
                        const targetId = getTargetId(1);
                        if (!targetId) return msg.reply("❌ Tag or provide number.");
                        
                        let query = { userId: targetId, date: todayString() };
                        if (chat.isGroup) query.groupId = chatId;

                        await DailyStats.deleteMany(query);
                        return msg.reply(`✅ Wiped stats for today.`);
                    }

                    if (command === "!ban") {
                        const targetId = getTargetId(1);
                        if (!targetId) return msg.reply("❌ Tag or provide number.");
                        await Blacklist.create({ userId: targetId });
                        return msg.reply(`🚫 User banned.`);
                    }

                    if (command === "!unban") {
                        const targetId = getTargetId(1);
                        if (!targetId) return msg.reply("❌ Tag or provide number.");
                        await Blacklist.deleteMany({ userId: targetId });
                        return msg.reply(`✅ User unbanned.`);
                    }

                    if (command === "!leave") {
                        await chat.sendMessage("👋 Admin ordered me to leave. Goodbye!");
                        await chat.leave();
                        return;
                    }
                }

                // ==========================================
                // 👤 REGULAR COMMANDS
                // ==========================================

                if (command === "!help") {
                    return msg.reply(`🤖 *SPRINT BOT MENU*

🏃 *Sprinting*
!sprint 20 : Start a 20 min sprint
!wc 500 : Log words
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

⚙️ *Utils*
!log 500 : Manually add words (no timer)
!myname Sam : Update your display name`);
                }

                if (command === "!log") {
                    let count = parseInt(args[1]);
                    if (isNaN(count) || count <= 0) return msg.reply("❌ Invalid number. Use: `!log 500`");
                    const date = todayString();
                    let goalUpdateText = "";
                    try {
                        await DailyStats.findOneAndUpdate({ userId: senderId, groupId: chatId, date }, { name: senderName, $inc: { words: count }, timestamp: new Date() }, { upsert: true, new: true });
                        const goal = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                        if (goal) {
                            goal.current += count;
                            await goal.save();
                            if (goal.current >= goal.target) {
                                goalUpdateText = `\n🎉 @${senderId.split('@')[0]} just COMPLETED their goal of ${goal.target} words!`;
                                goal.isActive = false; await goal.save();
                            }
                        }
                        let replyText = `✅ Manually logged **${count}** words for ${senderName}.` + goalUpdateText;
                        if (goalUpdateText) await chat.sendMessage(replyText, { mentions: [senderId] });
                        else await msg.reply(replyText);
                    } catch (err) { console.error(err); }
                }

                if (command === "!top10" || command === "!top") {
                    const top = await DailyStats.aggregate([
                        { $group: { _id: "$name", total: { $sum: "$words" } } },
                        { $sort: { total: -1 } },
                        { $limit: 10 }
                    ]);
                    if (top.length === 0) return msg.reply("📉 No data yet.");
                    let text = `🌍 **ALL-TIME HALL OF FAME** 🌍\n\n`;
                    top.forEach((w, i) => {
                        let medal = i === 0 ? "🥇" : (i === 1 ? "🥈" : (i === 2 ? "🥉" : "🎖️"));
                        text += `${medal} ${w._id}: **${w.total.toLocaleString()}**\n`;
                    });
                    await chat.sendMessage(text);
                }

                if (command === "!myname" || command === "!setname") {
                    const newName = args.slice(1).join(" ");
                    if (!newName) return msg.reply("❌ Please provide a name. Example: `!myname Sam`");
                    await DailyStats.updateMany({ userId: senderId }, { name: newName });
                    await PersonalGoal.updateMany({ userId: senderId }, { name: newName });
                    return msg.reply(`✅ Name updated to **${newName}** for all stats!`);
                }

                if (command === "!sprint") {
                    let minutes = parseInt(args[1]);
                    if (isNaN(minutes) || minutes <= 0 || minutes > 180) return msg.reply("❌ Invalid time. Use: `!sprint 20`");
                    if (activeSprints[chatId]) return msg.reply("⚠️ A sprint is already running.");
                    await startSprintSession(chatId, minutes);
                }

                if (command === "!schedule") {
                    if (args[2]?.toLowerCase() !== 'in') return msg.reply("❌ Format: `!schedule <duration> in <minutes>`");
                    const durationMins = parseInt(args[1]);
                    const delayMins = parseInt(args[3]);
                    if (isNaN(durationMins) || isNaN(delayMins)) return msg.reply("❌ Invalid numbers.");
                    const startTime = new Date(Date.now() + delayMins * 60000);
                    await ScheduledSprint.create({ groupId: chatId, startTime, duration: durationMins, createdBy: senderId });
                    return msg.reply(`📅 **Sprint Scheduled!**\n\nDuration: ${durationMins} mins\nStart: In ${delayMins} mins (approx ${formatTimeGMT1(startTime)} GMT+1)`);
                }

                if (command === "!unschedule") {
                    const result = await ScheduledSprint.deleteMany({ groupId: chatId });
                    if (result.deletedCount > 0) return msg.reply(`✅ Cancelled ${result.deletedCount} scheduled sprint(s).`);
                    return msg.reply("🤷 No upcoming sprints found.");
                }

                if (command === "!time") {
                    const sprint = activeSprints[chatId];
                    if (!sprint) return msg.reply("❌ No active sprint.");
                    const remainingMs = sprint.endsAt - Date.now();
                    if (remainingMs <= 0) return msg.reply("🛑 Time is up! Type `!finish` to end.");
                    const mins = Math.floor((remainingMs / 1000) / 60);
                    const secs = Math.floor((remainingMs / 1000) % 60);
                    return msg.reply(`⏳ Time remaining: *${mins}m ${secs}s*`);
                }

                if (command === "!wc") {
                    const sprint = activeSprints[chatId];
                    if (!sprint) return msg.reply("❌ No active sprint.");
                    let count = 0;
                    let isAdding = false;
                    if (args[1] === 'add' || args[1] === '+') { count = parseInt(args[2]); isAdding = true; } else { count = parseInt(args[1]); }
                    if (isNaN(count) || count < 0) return msg.reply("❌ Invalid number.");
                    if (!sprint.participants[senderId]) sprint.participants[senderId] = { name: senderName, words: 0 };
                    if (isAdding) {
                        sprint.participants[senderId].words += count;
                        await msg.reply(`➕ Added. Total: *${sprint.participants[senderId].words}*`);
                    } else {
                        sprint.participants[senderId].words = count;
                        await msg.react('✅');
                    }
                    return;
                }

                if (command === "!finish") {
                    const sprint = activeSprints[chatId];
                    if (!sprint) return msg.reply("❌ No active sprint running.");
                    const date = todayString();
                    const leaderboardArray = Object.entries(sprint.participants).map(([uid, data]) => ({ ...data, uid })).sort((a, b) => b.words - a.words);
                    if (leaderboardArray.length === 0) {
                        delete activeSprints[chatId];
                        return msg.reply("🏁 Sprint ended! No entries recorded.");
                    }
                    let leaderboardText = `🏆 *SPRINT RESULTS* 🏆\n\n`;
                    let goalUpdateText = "";
                    let mentionsList = []; 
                    for (let i = 0; i < leaderboardArray.length; i++) {
                        let p = leaderboardArray[i];
                        mentionsList.push(p.uid);
                        let medal = i === 0 ? "🥇" : (i === 1 ? "🥈" : (i === 2 ? "🥉" : "🎖️"));
                        const wpm = Math.round(p.words / sprint.duration);
                        leaderboardText += `${medal} @${p.uid.split('@')[0]} : ${p.words} words (${wpm} WPM)\n`;
                        try {
                            await DailyStats.findOneAndUpdate({ userId: p.uid, groupId: chatId, date }, { name: p.name, $inc: { words: p.words }, timestamp: new Date() }, { upsert: true, new: true });
                            const goal = await PersonalGoal.findOne({ userId: p.uid, isActive: true });
                            if (goal) {
                                goal.current += p.words;
                                await goal.save();
                                if (goal.current >= goal.target) {
                                    goalUpdateText += `\n🎉 @${p.uid.split('@')[0]} just COMPLETED their goal of ${goal.target} words!`;
                                    goal.isActive = false; await goal.save();
                                }
                            }
                        } catch (err) { console.error("DB Save Error", err); }
                    }
                    delete activeSprints[chatId];
                    leaderboardText += "\nGreat job everyone! Type !sprint to go again.";
                    if (goalUpdateText) leaderboardText += "\n" + goalUpdateText;
                    await chat.sendMessage(leaderboardText, { mentions: mentionsList });
                }

                if (["!daily", "!weekly", "!monthly"].includes(command)) {
                    const isDaily = command === "!daily";
                    const days = isDaily ? 1 : (command === "!weekly" ? 7 : 30);
                    const todayGMT1 = todayString();
                    const title = isDaily ? `Daily Leaderboard (${todayGMT1})` : (command === "!weekly" ? "Weekly Leaderboard" : "Monthly Leaderboard");
                    let stats;
                    if (isDaily) {
                         stats = await DailyStats.find({ groupId: chatId, date: todayGMT1 }).sort({ words: -1 });
                    } else {
                        const cutoffDate = new Date();
                        cutoffDate.setDate(cutoffDate.getDate() - days);
                        stats = await DailyStats.aggregate([
                            { $match: { groupId: chatId, timestamp: { $gte: cutoffDate } } },
                            { $group: { _id: "$userId", totalWords: { $sum: "$words" }, name: { $first: "$name" } } },
                            { $sort: { totalWords: -1 } },
                            { $limit: 15 }
                        ]);
                    }
                    if (stats.length === 0) return msg.reply(`📉 No stats found.`);
                    let text = `🏆 **${title}**\n\n`;
                    stats.forEach((s, i) => {
                        let medal = "🎖️";
                        if (i === 0) medal = "🥇";
                        if (i === 1) medal = "🥈";
                        if (i === 2) medal = "🥉";
                        text += `${medal} ${s.name}: ${isDaily ? s.words : s.totalWords}\n`;
                    });
                    await chat.sendMessage(text);
                }

                if (command === "!goal") {
                    const subCmd = args[1]?.toLowerCase();
                    if (subCmd === "set") {
                        const target = parseInt(args[2]);
                        if (isNaN(target) || target <= 0) return msg.reply("❌ Use: `!goal set 50000`");
                        await PersonalGoal.updateMany({ userId: senderId }, { isActive: false });
                        await PersonalGoal.create({ userId: senderId, name: senderName, target: target, current: 0, isActive: true });
                        return msg.reply(`🎯 Personal goal set to **${target}** words!`);
                    }
                    if (subCmd === "check" || subCmd === "status") {
                        const goal = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                        if (!goal) return msg.reply("❌ No active goal. Set one: `!goal set 50000`");
                        const percent = ((goal.current / goal.target) * 100).toFixed(1);
                        const progressBar = "🟩".repeat(Math.round(Math.min(goal.current / goal.target, 1) * 10)) + "⬜".repeat(10 - Math.round(Math.min(goal.current / goal.target, 1) * 10));
                        return msg.reply(`🎯 **Goal Progress**\n👤 ${goal.name}\n📊 ${goal.current} / ${goal.target} words\n${progressBar} (${percent}%)\n📅 Started: ${goal.startDate}`);
                    }
                }

                if (command === "!cancel") {
                    if (activeSprints[chatId]) {
                        delete activeSprints[chatId];
                        await msg.reply("🚫 Sprint cancelled.");
                    }
                }

            } catch (err) {
                console.error("Handler error:", err);
            }
        });

        client.initialize();
    })
    .catch(err => {
        console.error("❌ MongoDB connection error:", err);
        process.exit(1);
    });