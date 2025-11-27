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
//   CONFIG & OWNER SETUP
// =======================
const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = "Africa/Lagos"; // GMT+1

// 👑 SUPER ADMIN ID (Your Number)
const OWNER_NUMBER = '2347087899166'; 

// 🟢 CORS
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); 
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, x-admin-password");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Admin Auth
const requireAdmin = (req, res, next) => {
    const password = req.headers['x-admin-password'];
    if (password === (process.env.ADMIN_PASSWORD || "Cyber$ecur1ty")) return next();
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
if (!MONGO_URI) { console.error("❌ ERROR: MONGO_URI is missing!"); process.exit(1); }

let activeSprints = {}; 

// =======================
//   WEB API ENDPOINTS
// =======================

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

app.get('/api/stats', async (req, res) => {
    try {
        let qrImage = null;
        if (!isConnected && qrCodeData) {
            qrImage = await QRCode.toDataURL(qrCodeData);
        }

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

        const totalWordsAgg = await DailyStats.aggregate([{ $group: { _id: null, total: { $sum: "$words" } } }]);
        const totalWords = totalWordsAgg[0]?.total || 0;
        
        const totalWritersAgg = await DailyStats.distinct("name");
        const totalWriters = totalWritersAgg.length;

        const allGroupIds = await DailyStats.distinct("groupId");
        const totalGroupsCount = allGroupIds.filter(id => id !== "Manual_Correction").length;

        const topGroupsRaw = await DailyStats.aggregate([
            { $group: { _id: "$groupId", total: { $sum: "$words" } } },
            { $sort: { total: -1 } }, { $limit: 10 }
        ]);

        const topGroups = await Promise.all(topGroupsRaw.map(async (g) => {
            let groupName = "Unknown Group";
            if (g._id === "Manual_Correction") return null;
            if (client && isConnected) {
                try {
                    const chat = await client.getChatById(g._id);
                    if (chat && chat.name) groupName = chat.name;
                } catch (e) {}
            }
            return { name: groupName, words: g.total };
        }));

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
            isConnected, qrCode: qrImage, topWriters, todayWriters, 
            totalWords, totalWriters, 
            totalGroups: totalGroupsCount, 
            topGroups: topGroups.filter(g => g !== null), 
            chartData 
        });

    } catch (e) {
        console.error("API Error:", e);
        res.status(500).json({ error: "Server Error" });
    }
});

app.post('/api/admin/search', requireAdmin, async (req, res) => {
    try {
        const { query } = req.body;
        const users = await DailyStats.aggregate([
            { $match: { name: { $regex: query, $options: 'i' } } },
            { $group: { _id: "$userId", name: { $first: "$name" }, totalWords: { $sum: "$words" }, lastActive: { $max: "$date" } } },
            { $limit: 10 }
        ]);
        res.json(users);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/update', requireAdmin, async (req, res) => {
    try {
        const { userId, amount, type } = req.body; 
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        
        const doc = await DailyStats.findOne({ userId, date: todayStr }).sort({ timestamp: -1 });

        if (!doc) return res.status(404).json({ message: "User has no entry for today to edit." });

        if (type === 'set') {
            const diff = amount - doc.words;
            doc.words = parseInt(amount);
            // doc.name = "Fixed by Admin"; // REMOVED THIS LINE
            doc.timestamp = new Date();
            await doc.save();
            await PersonalGoal.findOneAndUpdate({ userId, isActive: true }, { $inc: { current: diff } });
        } else {
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
        if (!client || !isConnected) return res.status(500).json({ error: "Bot offline" });
        const chats = await client.getChats();
        const groups = chats.filter(c => c.id.server === 'g.us');
        for (const group of groups) { await group.sendMessage(`📢 *ANNOUNCEMENT*\n\n${message}`); }
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
            authStrategy: new RemoteAuth({ store: store, backupSyncIntervalMs: 300000 }),
            puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-accelerated-2d-canvas", "--no-first-run", "--no-zygote", "--single-process", "--disable-gpu"] }
        });

        const getTodayDateGMT1 = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const formatTimeGMT1 = (dateObj) => dateObj.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });

        const startSprintSession = async (chatId, duration) => {
            if (activeSprints[chatId]) return false; 
            const endTime = Date.now() + duration * 60000;
            console.log(`[${new Date().toLocaleTimeString()}] Starting sprint in ${chatId}`);

            activeSprints[chatId] = { duration, endsAt: endTime, participants: {} };
            const chat = await client.getChatById(chatId);
            await chat.sendMessage(`🏁 *Writing Sprint Started!*\nDuration: *${duration} minutes*\n\nUse *!wc <number>* to log words.`);

            setTimeout(async () => {
                if (activeSprints[chatId]) {
                    try { await chat.sendMessage(`🛑 **TIME'S UP!**\n\nReply with *!wc [number]* now.\nType *!finish* to end.`); } 
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
                        const chat = await client.getChatById(sprint.groupId);
                        await chat.sendMessage(`⚠️ Scheduled sprint skipped.`);
                    } else {
                        const chat = await client.getChatById(sprint.groupId);
                        await chat.sendMessage(`(Sprint scheduled by @${sprint.createdBy.split('@')[0]})`, { mentions: [sprint.createdBy] });
                    }
                    await ScheduledSprint.deleteOne({ _id: sprint._id });
                }
            } catch (e) { console.error("Scheduler Error:", e); }
        }, 60000); 

        client.on("qr", qr => { qrCodeData = qr; console.log("New QR"); });
        client.on("ready", () => { isConnected = true; console.log("Client ready"); });

        client.on("message", async msg => {
            try {
                const chat = await msg.getChat();
                const chatId = chat.id._serialized;
                let senderId = msg.author || msg.from;
                
                if (await Blacklist.exists({ userId: senderId })) return;

                const isOwner = senderId.includes(OWNER_NUMBER);
                if (!chat.isGroup && !isOwner) return;

                let senderName = senderId.split('@')[0]; 
                try {
                    const contact = await msg.getContact();
                    senderId = contact.id._serialized; 
                    if (contact.pushname) senderName = contact.pushname;
                    else if (contact.name) senderName = contact.name;
                    else if (contact.number) senderName = contact.number;
                } catch (err) { senderName = msg._data?.notifyName || senderId.split('@')[0]; }

                if (!msg.body.startsWith("!")) return;

                const args = msg.body.trim().split(" ");
                const command = args[0].toLowerCase();
                const todayStr = getTodayDateGMT1(); // GLOBAL DATE VARIABLE FIXED

                const getTargetId = (argIndex = 1) => {
                    if (msg.mentionedIds.length > 0) return msg.mentionedIds[0];
                    const potentialNumber = args[argIndex]?.replace(/\D/g, '');
                    if (potentialNumber && potentialNumber.length > 5) return potentialNumber + '@c.us';
                    return null;
                };

                const getTargetName = async (targetId) => {
                    try {
                        const contact = await client.getContactById(targetId);
                        return contact.pushname || contact.name || contact.number || "Writer";
                    } catch (e) { return "Writer"; }
                };

                // --- ADMIN COMMANDS ---
                if (isOwner) {
                    if (command === "!broadcast") {
                        const message = args.slice(1).join(" ");
                        if (!message) return msg.reply("❌ Empty.");
                        const chats = await client.getChats();
                        const groups = chats.filter(c => c.id.server === 'g.us');
                        msg.reply(`📢 Sending to ${groups.length} groups...`);
                        for (const group of groups) { await group.sendMessage(`📢 *ANNOUNCEMENT*\n\n${message}`); }
                        return;
                    }

                    if (command === "!groups") {
                        const chats = await client.getChats();
                        const groups = chats.filter(c => c.id.server === 'g.us');
                        let report = `🤖 **Groups:**\n\n`;
                        groups.forEach((g, i) => { report += `${i+1}. ${g.name}\n`; });
                        return msg.reply(report);
                    }

                    if (command === "!sys") {
                        const uptime = process.uptime();
                        const mem = process.memoryUsage().heapUsed / 1024 / 1024;
                        return msg.reply(`⚙️ **Status**\n\n⏱️ ${Math.floor(uptime/60)}m\n💾 ${mem.toFixed(2)} MB`);
                    }

                    if (command === "!correct") {
                        const targetId = getTargetId(1);
                        const amount = parseInt(args[2]);
                        if (!targetId || isNaN(amount)) return msg.reply("❌ Usage: `!correct @User -500`");

                        let filter = { userId: targetId, date: todayStr };
                        if (chat.isGroup) filter.groupId = chatId;

                        const targetDoc = await DailyStats.findOne(filter).sort({ timestamp: -1 });

                        if (!targetDoc) {
                            if (chat.isGroup) {
                                const targetName = await getTargetName(targetId);
                                await DailyStats.create({ userId: targetId, groupId: chatId, date: todayStr, name: targetName, words: amount, timestamp: new Date() });
                                return msg.reply(`✅ Created entry for ${targetName}: ${amount}`);
                            } else {
                                return msg.reply("❌ No record found to correct. Use group.");
                            }
                        }
                        targetDoc.words += amount;
                        targetDoc.timestamp = new Date();
                        await targetDoc.save();
                        await PersonalGoal.findOneAndUpdate({ userId: targetId, isActive: true }, { $inc: { current: amount } });
                        return msg.reply(`✅ Adjusted. New Total: ${targetDoc.words}`);
                    }

                    if (command === "!setword") {
                        const targetId = getTargetId(1);
                        const amount = parseInt(args[2]);
                        if (!targetId || isNaN(amount)) return msg.reply("❌ Usage: `!setword @User 2500`");

                        let filter = { userId: targetId, date: todayStr };
                        if (chat.isGroup) filter.groupId = chatId;

                        const targetDoc = await DailyStats.findOne(filter).sort({ timestamp: -1 });

                        if (!targetDoc) {
                            if (chat.isGroup) {
                                const targetName = await getTargetName(targetId);
                                await DailyStats.create({ userId: targetId, groupId: chatId, date: todayStr, name: targetName, words: amount, timestamp: new Date() });
                                return msg.reply(`✅ Created entry set to ${amount}.`);
                            } else {
                                return msg.reply("❌ No record found. Use group.");
                            }
                        }
                        targetDoc.words = amount;
                        // Name is NOT changed here anymore!
                        targetDoc.timestamp = new Date();
                        await targetDoc.save();
                        return msg.reply(`✅ Set to **${amount}**.`);
                    }

                    if (command === "!setname") {
                        const targetId = getTargetId(1);
                        const nameStartIndex = msg.mentionedIds.length > 0 ? 2 : 2; 
                        const newName = args.slice(nameStartIndex).join(" ");
                        if (!targetId || !newName) return msg.reply("❌ Usage: `!setname @User Name`");
                        await DailyStats.updateMany({ userId: targetId }, { name: newName });
                        await PersonalGoal.updateMany({ userId: targetId }, { name: newName });
                        return msg.reply(`✅ Updated name to **${newName}**.`);
                    }

                    // 🛠️ NEW: Cleanup Command
                    if (command === "!cleanup") {
                        const res1 = await DailyStats.deleteMany({ name: "Fixed by Admin" });
                        const res2 = await DailyStats.deleteMany({ date: { $exists: false } });
                        return msg.reply(`🧹 Deleted ${res1.deletedCount} 'Fixed' records and ${res2.deletedCount} corrupted dates.`);
                    }

                    if (command === "!wipe") {
                        const targetId = getTargetId(1);
                        if (!targetId) return msg.reply("❌ Tag user.");
                        let query = { userId: targetId, date: todayStr };
                        if (chat.isGroup) query.groupId = chatId;
                        await DailyStats.deleteMany(query);
                        return msg.reply(`✅ Wiped.`);
                    }

                    if (command === "!ban") {
                        const targetId = getTargetId(1);
                        if (!targetId) return msg.reply("❌ Tag user.");
                        await Blacklist.create({ userId: targetId });
                        return msg.reply(`🚫 Banned.`);
                    }

                    if (command === "!unban") {
                        const targetId = getTargetId(1);
                        if (!targetId) return msg.reply("❌ Tag user.");
                        await Blacklist.deleteMany({ userId: targetId });
                        return msg.reply(`✅ Unbanned.`);
                    }

                    if (command === "!leave") {
                        await chat.sendMessage("👋 Bye!");
                        await chat.leave();
                        return;
                    }
                }

                // --- REGULAR COMMANDS ---
                if (command === "!help") {
                    return msg.reply(`🤖 *SPRINT BOT*
🏃 !sprint 20 | !wc 500
⏱️ !time | !finish | !cancel
📅 !schedule 20 in 60 | !unschedule
📊 !daily | !weekly | !monthly | !top10
🎯 !goal set 5000 | !goal check
⚙️ !log 500 | !myname Sam`);
                }

                if (command === "!log") {
                    let count = parseInt(args[1]);
                    if (isNaN(count) || count <= 0) return msg.reply("❌ Use: `!log 500`");
                    try {
                        await DailyStats.findOneAndUpdate({ userId: senderId, groupId: chatId, date: todayStr }, { name: senderName, $inc: { words: count }, timestamp: new Date() }, { upsert: true, new: true });
                        const goal = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                        let goalMsg = "";
                        if (goal) {
                            goal.current += count;
                            await goal.save();
                            if (goal.current >= goal.target) { goalMsg = `\n🎉 Goal Hit!`; goal.isActive = false; await goal.save(); }
                        }
                        let txt = `✅ Logged ${count}.` + goalMsg;
                        if(goalMsg) await chat.sendMessage(txt, {mentions: [senderId]}); else await msg.reply(txt);
                    } catch (e) { console.error(e); }
                }

                if (command === "!top10" || command === "!top") {
                    const top = await DailyStats.aggregate([{ $group: { _id: "$name", total: { $sum: "$words" } } }, { $sort: { total: -1 } }, { $limit: 10 }]);
                    if (top.length === 0) return msg.reply("📉 No data.");
                    let txt = `🌍 **ALL-TIME HALL OF FAME**\n\n`;
                    top.forEach((w, i) => { txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} ${w._id}: ${w.total.toLocaleString()}\n`; });
                    await chat.sendMessage(txt);
                }

                if (command === "!myname") {
                    const n = args.slice(1).join(" ");
                    if (!n) return msg.reply("❌ Use: `!myname Sam`");
                    await DailyStats.updateMany({ userId: senderId }, { name: n });
                    await PersonalGoal.updateMany({ userId: senderId }, { name: n });
                    return msg.reply(`✅ Name: ${n}`);
                }

                if (command === "!sprint") {
                    let m = parseInt(args[1]);
                    if (isNaN(m) || m <= 0 || m > 180) return msg.reply("❌ Use: `!sprint 20`");
                    if (activeSprints[chatId]) return msg.reply("⚠️ Running.");
                    await startSprintSession(chatId, m);
                }

                if (command === "!schedule") {
                    if (args[2] !== 'in') return msg.reply("❌ Use: `!schedule 20 in 60`");
                    const d = parseInt(args[1]), w = parseInt(args[3]);
                    if (isNaN(d) || isNaN(w)) return msg.reply("❌ Invalid.");
                    const s = new Date(Date.now() + w * 60000);
                    await ScheduledSprint.create({ groupId: chatId, startTime: s, duration: d, createdBy: senderId });
                    return msg.reply(`📅 Scheduled: ${d}m in ${w}m.`);
                }

                if (command === "!unschedule") {
                    const r = await ScheduledSprint.deleteMany({ groupId: chatId });
                    if (r.deletedCount > 0) return msg.reply(`✅ Cancelled.`);
                    return msg.reply("🤷 None found.");
                }

                if (command === "!time") {
                    const s = activeSprints[chatId];
                    if (!s) return msg.reply("❌ No sprint.");
                    const r = s.endsAt - Date.now();
                    if (r <= 0) return msg.reply("🛑 Time up!");
                    return msg.reply(`⏳ ${Math.floor(r/60000)}m ${Math.floor((r/1000)%60)}s`);
                }

                if (command === "!wc") {
                    const s = activeSprints[chatId];
                    if (!s) return msg.reply("❌ No sprint.");
                    let c = parseInt(args[1]==='add'||args[1]==='+'?args[2]:args[1]);
                    let add = args[1]==='add'||args[1]==='+';
                    if (isNaN(c)) return msg.reply("❌ Invalid.");
                    if (!s.participants[senderId]) s.participants[senderId] = { name: senderName, words: 0 };
                    if (add) { s.participants[senderId].words += c; await msg.reply(`➕ Added. Total: ${s.participants[senderId].words}`); }
                    else { s.participants[senderId].words = c; await msg.react('✅'); }
                }

                if (command === "!finish") {
                    const s = activeSprints[chatId];
                    if (!s) return msg.reply("❌ No sprint.");
                    const l = Object.entries(s.participants).map(([u, d]) => ({ ...d, uid: u })).sort((a, b) => b.words - a.words);
                    if (l.length === 0) { delete activeSprints[chatId]; return msg.reply("🏁 Ended. Empty."); }
                    let txt = `🏆 *RESULTS* 🏆\n\n`, men = [];
                    for (let i = 0; i < l.length; i++) {
                        let p = l[i]; men.push(p.uid);
                        txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} @${p.uid.split('@')[0]} : ${p.words} (${Math.round(p.words/s.duration)} WPM)\n`;
                        try {
                            await DailyStats.findOneAndUpdate({ userId: p.uid, groupId: chatId, date: todayStr }, { name: p.name, $inc: { words: p.words }, timestamp: new Date() }, { upsert: true });
                            const g = await PersonalGoal.findOne({ userId: p.uid, isActive: true });
                            if (g) { g.current += p.words; await g.save(); if (g.current >= g.target) { g.isActive = false; await g.save(); txt += `\n🎉 Goal Hit!`; } }
                        } catch (e) {}
                    }
                    delete activeSprints[chatId];
                    txt += "\nGreat job!";
                    await chat.sendMessage(txt, { mentions: men });
                }

                if (["!daily", "!weekly", "!monthly"].includes(command)) {
                    const d = command === "!daily";
                    const days = d ? 1 : command === "!weekly" ? 7 : 30;
                    let stats;
                    if (d) stats = await DailyStats.find({ groupId: chatId, date: todayStr }).sort({ words: -1 });
                    else {
                        const dt = new Date(); dt.setDate(dt.getDate() - days);
                        stats = await DailyStats.aggregate([{ $match: { groupId: chatId, timestamp: { $gte: dt } } }, { $group: { _id: "$userId", totalWords: { $sum: "$words" }, name: { $first: "$name" } } }, { $sort: { totalWords: -1 } }, { $limit: 15 }]);
                    }
                    if (stats.length === 0) return msg.reply("📉 No stats.");
                    let txt = `🏆 **LEADERBOARD**\n\n`;
                    stats.forEach((s, i) => { txt += `${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎖️'} ${s.name}: ${d ? s.words : s.totalWords}\n`; });
                    await chat.sendMessage(txt);
                }

                if (command === "!goal") {
                    const sub = args[1]?.toLowerCase();
                    if (sub === "set") {
                        const t = parseInt(args[2]);
                        if (isNaN(t)) return msg.reply("❌ Use: `!goal set 5000`");
                        await PersonalGoal.updateMany({ userId: senderId }, { isActive: false });
                        await PersonalGoal.create({ userId: senderId, name: senderName, target: t, current: 0 });
                        return msg.reply(`🎯 Goal set: ${t}`);
                    }
                    if (sub === "check") {
                        const g = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                        if (!g) return msg.reply("❌ No active goal.");
                        const p = ((g.current/g.target)*100).toFixed(1);
                        return msg.reply(`🎯 ${g.current}/${g.target} (${p}%)`);
                    }
                }

                if (command === "!cancel") {
                    if (activeSprints[chatId]) { delete activeSprints[chatId]; await msg.reply("🚫 Cancelled."); }
                }

            } catch (err) { console.error("Handler error:", err); }
        });

        client.initialize();
    })
    .catch(err => { console.error("❌ MongoDB error:", err); process.exit(1); });