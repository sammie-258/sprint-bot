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
//   SERVER & API SETUP
// =======================
const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = "Africa/Lagos"; // GMT+1

// 🟢 CORS: Allow external websites (like your cPanel site)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); 
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

let qrCodeData = null;
let isConnected = false;
let client = null; // Global client variable for API access

// Root Route
app.get('/', async (req, res) => {
    if (isConnected) {
        res.send('<h1>✅ Sprint Bot is Online</h1><p>API is active at /api/stats</p>');
    } else if (qrCodeData) {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`
            <div style="text-align:center; font-family: sans-serif; padding-top: 50px;">
                <h1>Scan with WhatsApp</h1>
                <img src="${qrImage}" style="border:1px solid #ccc; width:300px;">
                <p>Refresh page if code expires.</p>
            </div>
        `);
    } else {
        res.send('<h1>⏳ Booting up... refresh in 10s.</h1>');
    }
});

// 🟢 API ENDPOINT (Dashboard Data)
app.get('/api/stats', async (req, res) => {
    try {
        let qrImage = null;
        if (!isConnected && qrCodeData) {
            qrImage = await QRCode.toDataURL(qrCodeData);
        }

        // 1. Fetch Top 10 All-Time
        const topWritersRaw = await DailyStats.aggregate([
            { $group: { _id: "$userId", name: { $first: "$name" }, total: { $sum: "$words" } } },
            { $sort: { total: -1 } },
            { $limit: 10 }
        ]);
        const topWriters = topWritersRaw.map(w => ({ name: w.name, words: w.total }));

        // 2. Fetch Today's Top 10
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const todayWritersRaw = await DailyStats.find({ date: todayStr }).sort({ words: -1 }).limit(10);
        const todayWriters = todayWritersRaw.map(w => ({ name: w.name, words: w.words }));

        // 3. Totals
        const totalWordsAgg = await DailyStats.aggregate([{ $group: { _id: null, total: { $sum: "$words" } } }]);
        const totalWords = totalWordsAgg[0]?.total || 0;
        
        const totalWritersAgg = await DailyStats.distinct("userId");
        const totalWriters = totalWritersAgg.length;

        const totalGroupsAgg = await DailyStats.distinct("groupId");
        const totalGroups = totalGroupsAgg.length;

        // 4. Top Groups Leaderboard
        const topGroupsRaw = await DailyStats.aggregate([
            { $group: { _id: "$groupId", total: { $sum: "$words" } } },
            { $sort: { total: -1 } },
            { $limit: 10 }
        ]);

        // Fetch Group Names (Safe Check)
        const topGroups = await Promise.all(topGroupsRaw.map(async (g) => {
            let groupName = "Unknown Group";
            // Only attempt fetch if client is fully ready
            if (client && isConnected) {
                try {
                    const chat = await client.getChatById(g._id);
                    if (chat && chat.name) groupName = chat.name;
                } catch (e) {
                    // Ignore errors if group not found in cache
                }
            }
            return { name: groupName, words: g.total };
        }));

        // 5. Last 7 Days Activity (Chart Data)
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
            totalGroups, 
            topGroups, 
            chartData 
        });

    } catch (e) {
        console.error("API Error:", e);
        res.status(500).json({ error: "Server Error" });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

// 🟢 KEEP-ALIVE
setInterval(() => {
    http.get(`http://localhost:${PORT}/`, (res) => {}).on('error', (err) => {});
}, 5 * 60 * 1000); 

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

const MONGO_URI = process.env.MONGO_URI; 
if (!MONGO_URI) {
    console.error("❌ ERROR: MONGO_URI is missing!");
    process.exit(1);
}

// In-memory active sprints
let activeSprints = {}; 

// =======================
//   MAIN LOGIC
// =======================
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB connected successfully");

        const store = new MongoStore({ mongoose: mongoose });

        // Assign to global variable 'client'
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
        const getCurrentTimeGMT1 = () => {
            return new Date().toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour12: false });
        };

        const getTodayDateGMT1 = () => {
            return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        };

        const formatTimeGMT1 = (dateObj) => {
            return dateObj.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
        };

        // --- SHARED SPRINT START FUNCTION ---
        const startSprintSession = async (chatId, duration) => {
            if (activeSprints[chatId]) return false; 

            const endTime = Date.now() + duration * 60000;
            const endTimeStr = new Date(endTime).toLocaleTimeString('en-GB', { timeZone: TIMEZONE });
            
            console.log(`[${getCurrentTimeGMT1()}] Starting sprint in ${chatId}. Duration: ${duration}m. Ends: ${endTimeStr}`);

            activeSprints[chatId] = {
                duration: duration, 
                endsAt: endTime,
                participants: {}
            };

            const chat = await client.getChatById(chatId);
            await chat.sendMessage(`🏁 *Writing Sprint Started!*\nDuration: *${duration} minutes*\n\nUse *!wc <number>* to log words.`);

            // End Timer
            setTimeout(async () => {
                if (activeSprints[chatId]) {
                    try {
                        console.log(`[${getCurrentTimeGMT1()}] Sprint finished for chat: ${chatId}`);
                        await chat.sendMessage(`🛑 **TIME'S UP!**\n\nReply with *!wc [number]* now.\nType *!finish* to end.`);
                    } catch (e) {
                        console.log("Failed to send timeout message.", e);
                    }
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
                        await chat.sendMessage(`(This sprint was scheduled by @${sprint.createdBy.split('@')[0]})`, {
                            mentions: [sprint.createdBy]
                        });
                    }
                    await ScheduledSprint.deleteOne({ _id: sprint._id });
                }
            } catch (e) {
                console.error("Scheduler Error:", e);
            }
        }, 60000); 

        // --- CLIENT EVENTS ---

        client.on("qr", qr => {
            qrCodeData = qr;
            console.log(`[${getCurrentTimeGMT1()}] New QR Code generated`);
        });

        client.on("ready", () => {
            isConnected = true;
            console.log(`[${getCurrentTimeGMT1()}] Client is ready!`);
        });

        // --- MESSAGE HANDLER ---

        client.on("message", async msg => {
            try {
                const chat = await msg.getChat();
                if (!chat.isGroup) return; 

                const chatId = chat.id._serialized;
                let senderId = msg.author || msg.from;
                let senderName = "Writer"; 
                
                try {
                    const contact = await msg.getContact();
                    senderId = contact.id._serialized;
                    senderName = contact.pushname || contact.name || contact.number;
                } catch (err) {
                    senderName = msg._data?.notifyName || senderId.split('@')[0];
                }

                if (!msg.body.startsWith("!")) return;

                const args = msg.body.trim().split(" ");
                const command = args[0].toLowerCase();
                const todayString = getTodayDateGMT1; 

                // ---------------------------
                //  COMMAND: HELP
                // ---------------------------
                if (command === "!help") {
                    return msg.reply(
                        `🤖 **SPRINT BOT COMMANDS**\n\n` +
                        `🏃 **!sprint 15** → Start 15 min sprint\n` +
                        `📅 **!schedule 20 in 60** → Schedule sprint\n` +
                        `🏆 **!top10** → Global Hall of Fame\n` +
                        `⏱️ **!time** → Check time remaining\n` +
                        `📝 **!wc 500** → Log words\n` +
                        `🏁 **!finish** → End sprint\n` +
                        `🚫 **!cancel** → Cancel active sprint\n\n` +
                        `📊 **STATS**\n` +
                        `📅 **!daily** | 🗓️ **!weekly** | 🏆 **!monthly**\n\n` +
                        `🎯 **GOALS**\n` +
                        `🆕 **!goal set 50000** | 👀 **!goal check**`
                    );
                }

                // ---------------------------
                //  COMMAND: TOP10 (Global)
                // ---------------------------
                if (command === "!top10" || command === "!top") {
                    const top = await DailyStats.aggregate([
                        { $group: { _id: "$userId", name: { $first: "$name" }, total: { $sum: "$words" } } },
                        { $sort: { total: -1 } },
                        { $limit: 10 }
                    ]);

                    if (top.length === 0) return msg.reply("📉 No data yet.");

                    let text = `🌍 **ALL-TIME HALL OF FAME** 🌍\n(Top 10 Across All Groups)\n\n`;
                    top.forEach((w, i) => {
                        let medal = i === 0 ? "🥇" : (i === 1 ? "🥈" : (i === 2 ? "🥉" : "🎖️"));
                        text += `${medal} ${w.name}: **${w.total.toLocaleString()}**\n`;
                    });
                    
                    // Add footer (Optional: put your dashboard link here if you want)
                    text += `\n👉 Keep writing to climb the ranks!`;
                    await chat.sendMessage(text);
                }

                // ---------------------------
                //  COMMAND: SPRINT
                // ---------------------------
                if (command === "!sprint") {
                    let minutes = parseInt(args[1]);
                    if (isNaN(minutes) || minutes <= 0 || minutes > 180) {
                        return msg.reply("❌ Invalid time. Use: `!sprint 20`");
                    }
                    if (activeSprints[chatId]) {
                        return msg.reply("⚠️ A sprint is already running.");
                    }
                    
                    await startSprintSession(chatId, minutes);
                    return;
                }

                // ---------------------------
                //  COMMAND: SCHEDULE
                // ---------------------------
                if (command === "!schedule") {
                    if (args[2]?.toLowerCase() !== 'in') {
                        return msg.reply("❌ Format: `!schedule <duration> in <minutes>`\nExample: `!schedule 20 in 60`");
                    }

                    const durationMins = parseInt(args[1]);
                    const delayMins = parseInt(args[3]);

                    if (isNaN(durationMins) || isNaN(delayMins) || durationMins <= 0 || delayMins <= 0) {
                        return msg.reply("❌ Invalid numbers.");
                    }

                    const startTime = new Date(Date.now() + delayMins * 60000);

                    await ScheduledSprint.create({
                        groupId: chatId,
                        startTime: startTime,
                        duration: durationMins,
                        createdBy: senderId
                    });

                    const timeString = formatTimeGMT1(startTime);
                    return msg.reply(`📅 **Sprint Scheduled!**\n\nDuration: ${durationMins} mins\nStart: In ${delayMins} mins (approx ${timeString} GMT+1)`);
                }

                // ---------------------------
                //  COMMAND: UNSCHEDULE
                // ---------------------------
                if (command === "!unschedule") {
                    const result = await ScheduledSprint.deleteMany({ groupId: chatId });
                    if (result.deletedCount > 0) {
                        return msg.reply(`✅ Cancelled ${result.deletedCount} scheduled sprint(s).`);
                    } else {
                        return msg.reply("🤷 No upcoming sprints found.");
                    }
                }

                // ---------------------------
                //  COMMAND: TIME
                // ---------------------------
                if (command === "!time") {
                    const sprint = activeSprints[chatId];
                    if (!sprint) return msg.reply("❌ No active sprint.");
                    const remainingMs = sprint.endsAt - Date.now();
                    if (remainingMs <= 0) return msg.reply("🛑 Time is up! Type `!finish` to end.");
                    const mins = Math.floor((remainingMs / 1000) / 60);
                    const secs = Math.floor((remainingMs / 1000) % 60);
                    return msg.reply(`⏳ Time remaining: *${mins}m ${secs}s*`);
                }

                // ---------------------------
                //  COMMAND: WC
                // ---------------------------
                if (command === "!wc") {
                    const sprint = activeSprints[chatId];
                    if (!sprint) return msg.reply("❌ No active sprint.");

                    let count = 0;
                    let isAdding = false;
                    if (args[1] === 'add' || args[1] === '+') {
                        count = parseInt(args[2]);
                        isAdding = true;
                    } else {
                        count = parseInt(args[1]);
                    }

                    if (isNaN(count) || count < 0) return msg.reply("❌ Invalid number.");

                    if (!sprint.participants[senderId]) {
                        sprint.participants[senderId] = { name: senderName, words: 0 };
                    }

                    if (isAdding) {
                        sprint.participants[senderId].words += count;
                        await msg.reply(`➕ Added. Total: *${sprint.participants[senderId].words}*`);
                    } else {
                        sprint.participants[senderId].words = count;
                        await msg.react('✅');
                    }
                    return;
                }

                // ---------------------------
                //  COMMAND: FINISH
                // ---------------------------
                if (command === "!finish") {
                    const sprint = activeSprints[chatId];
                    if (!sprint) return msg.reply("❌ No active sprint running.");

                    const date = todayString();
                    
                    // Sort logic expanded for readability
                    const leaderboardArray = Object.entries(sprint.participants)
                        .map(([uid, data]) => ({ ...data, uid }))
                        .sort((a, b) => b.words - a.words);

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

                        let medal = "🎖️";
                        if (i === 0) medal = "🥇";
                        if (i === 1) medal = "🥈";
                        if (i === 2) medal = "🥉";
                        
                        const wpm = Math.round(p.words / sprint.duration);
                        leaderboardText += `${medal} @${p.uid.split('@')[0]} : ${p.words} words (${wpm} WPM)\n`;

                        // DB Saving Logic
                        try {
                            await DailyStats.findOneAndUpdate(
                                { userId: p.uid, groupId: chatId, date },
                                { name: p.name, $inc: { words: p.words }, timestamp: new Date() },
                                { upsert: true, new: true }
                            );

                            // Goal Check
                            const goal = await PersonalGoal.findOne({ userId: p.uid, isActive: true });
                            if (goal) {
                                goal.current += p.words;
                                await goal.save();
                                if (goal.current >= goal.target) {
                                    goalUpdateText += `\n🎉 @${p.uid.split('@')[0]} just COMPLETED their goal of ${goal.target} words!`;
                                    goal.isActive = false; 
                                    await goal.save();
                                }
                            }
                        } catch (err) {
                            console.error("DB Save Error", err);
                        }
                    }

                    delete activeSprints[chatId];
                    leaderboardText += "\nGreat job everyone! Type !sprint to go again.";
                    
                    if (goalUpdateText) {
                         leaderboardText += "\n" + goalUpdateText;
                    }

                    await chat.sendMessage(leaderboardText, { mentions: mentionsList });
                    return;
                }

                // ---------------------------
                //  COMMAND: LEADERBOARDS
                // ---------------------------
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

                // ---------------------------
                //  COMMAND: GOAL
                // ---------------------------
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

                // ---------------------------
                //  COMMAND: CANCEL
                // ---------------------------
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