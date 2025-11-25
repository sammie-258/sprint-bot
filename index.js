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
//   SERVER & WEB QR SETUP
// =======================
const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = "Africa/Lagos"; // GMT+1

let qrCodeData = null;
let isConnected = false;

app.get('/', async (req, res) => {
    if (isConnected) {
        res.send('<h1>✅ Sprint Bot is Connected!</h1>');
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

        const client = new Client({
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
            // Returns YYYY-MM-DD in GMT+1
            return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        };

        const formatTimeGMT1 = (dateObj) => {
            return dateObj.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
        };

        // --- SHARED SPRINT START FUNCTION ---
        const startSprintSession = async (chatId, duration) => {
            if (activeSprints[chatId]) return false; // Already running

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

        // --- SCHEDULER WATCHER (Runs every 60s) ---
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
                
                // Use GMT+1 for daily stats
                const todayString = getTodayDateGMT1; 

                // ---------------------------
                //  COMMAND: HELP
                // ---------------------------
                if (command === "!help") {
                    return msg.reply(
                        `🤖 **SPRINT BOT COMMANDS**\n\n` +
                        `🏃 **!sprint 15** → Start 15 min sprint\n` +
                        `📅 **!schedule 20 in 60** → 20 min sprint in 60 mins\n` +
                        `🚫 **!unschedule** → Cancel pending sprints\n` +
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
                //  COMMAND: SPRINT (MANUAL)
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
                //  COMMAND: SCHEDULE (UPDATED)
                // ---------------------------
                if (command === "!schedule") {
                    if (args[2]?.toLowerCase() !== 'in') {
                        return msg.reply("❌ Format: `!schedule <duration> in <minutes>`\nExample: `!schedule 20 in 60` (20 min sprint starting in 1 hour)");
                    }

                    const durationMins = parseInt(args[1]);
                    const delayMins = parseInt(args[3]);

                    if (isNaN(durationMins) || isNaN(delayMins) || durationMins <= 0 || delayMins <= 0) {
                        return msg.reply("❌ Invalid numbers. Please use format: `!schedule 20 in 60`");
                    }

                    const startTime = new Date(Date.now() + delayMins * 60000);

                    await ScheduledSprint.create({
                        groupId: chatId,
                        startTime: startTime,
                        duration: durationMins,
                        createdBy: senderId
                    });

                    // Format time for display in GMT+1
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
                    const leaderboardArray = Object.entries(sprint.participants)
                        .map(([uid, data]) => ({ ...data, uid }))
                        .sort((a, b) => b.words - a.words);

                    if (leaderboardArray.length === 0) {
                        delete activeSprints[chatId];
                        return msg.reply("🏁 Sprint ended! No entries recorded.");
                    }

                    let leaderboardText = `🏆 *SPRINT RESULTS* 🏆\n\n`;
                    let goalUpdateText = "";

                    for (let i = 0; i < leaderboardArray.length; i++) {
                        let p = leaderboardArray[i];
                        let medal = "🎖️";
                        if (i === 0) medal = "🥇";
                        if (i === 1) medal = "🥈";
                        if (i === 2) medal = "🥉";
                        const wpm = Math.round(p.words / sprint.duration);
                        leaderboardText += `${medal} ${p.name} : ${p.words} words (${wpm} WPM)\n`;

                        try {
                            await DailyStats.findOneAndUpdate(
                                { userId: p.uid, groupId: chatId, date },
                                { name: p.name, $inc: { words: p.words }, timestamp: new Date() },
                                { upsert: true, new: true }
                            );
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
                        } catch (err) { console.error("DB Save Error", err); }
                    }

                    delete activeSprints[chatId];
                    leaderboardText += "\nGreat job everyone! Type !sprint to go again.";
                    
                    if (goalUpdateText) {
                         await chat.sendMessage(leaderboardText + "\n" + goalUpdateText, { 
                             mentions: leaderboardArray.filter(p => goalUpdateText.includes(p.uid.split('@')[0])).map(p => p.uid) 
                         });
                    } else {
                        await chat.sendMessage(leaderboardText);
                    }
                    return;
                }

                // ---------------------------
                //  COMMAND: DAILY / WEEKLY / MONTHLY
                // ---------------------------
                if (["!daily", "!weekly", "!monthly"].includes(command)) {
                    const isDaily = command === "!daily";
                    const days = isDaily ? 1 : (command === "!weekly" ? 7 : 30);
                    
                    // Use helper for formatted title
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