// =======================
//       IMPORTS
// =======================
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require("mongoose");
const QRCode = require('qrcode');
const express = require('express');
const http = require('http'); // Required for Keep-Alive
require("dotenv").config();

// =======================
//   SERVER & WEB QR SETUP
// =======================
const app = express();
const PORT = process.env.PORT || 3000;

let qrCodeData = null;
let isConnected = false;

// Simple dashboard to keep Render happy and show QR
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

// =======================
// 🟢 KEEP-ALIVE (FIX FOR SLEEP)
// =======================
setInterval(() => {
    http.get(`http://localhost:${PORT}/`, (res) => {
        // Just pinging to keep awake
    }).on('error', (err) => {
        // Ignore errors during ping
    });
}, 5 * 60 * 1000); // Ping every 5 minutes

// =======================
//   DATABASE SCHEMAS
// =======================

// 1. Sprint Stats (Daily/Weekly/Monthly)
const dailyStatsSchema = new mongoose.Schema({
    userId: String,
    name: String,
    groupId: String,
    date: String, // String format YYYY-MM-DD
    words: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now } 
});
const DailyStats = mongoose.model("DailyStats", dailyStatsSchema);

// 2. Personal Goals
const goalSchema = new mongoose.Schema({
    userId: String,
    name: String,
    target: Number,
    current: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    startDate: { type: String, default: () => new Date().toISOString().split("T")[0] }
});
const PersonalGoal = mongoose.model("PersonalGoal", goalSchema);

// Connection Check
const MONGO_URI = process.env.MONGO_URI; 
if (!MONGO_URI) {
    console.error("❌ ERROR: MONGO_URI is missing in Environment Variables!");
    process.exit(1);
}

// In-memory storage for active sprints
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
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-accelerated-2d-canvas",
                    "--no-first-run",
                    "--no-zygote",
                    "--single-process",
                    "--disable-gpu"
                ]
            }
        });

        // --- CLIENT EVENTS ---

        client.on("qr", qr => {
            qrCodeData = qr;
            console.log("New QR Code generated");
        });

        client.on("ready", () => {
            isConnected = true;
            console.log("Client is ready!");
        });

        // --- MESSAGE HANDLER ---

        client.on("message", async msg => {
            try {
                const chat = await msg.getChat();
                if (!chat.isGroup) return; // Ignore private messages

                const chatId = chat.id._serialized;

                // --- 🛡️ NAME SAFETY NET ---
                let senderId = msg.author || msg.from;
                let senderName = "Writer"; 
                
                try {
                    const contact = await msg.getContact();
                    senderId = contact.id._serialized;
                    senderName = contact.pushname || contact.name || contact.number;
                } catch (err) {
                    if (msg._data && msg._data.notifyName) {
                        senderName = msg._data.notifyName;
                    } else {
                        senderName = senderId.split('@')[0];
                    }
                }

                if (!msg.body.startsWith("!")) return;

                const args = msg.body.trim().split(" ");
                const command = args[0].toLowerCase();

                // Helper: Get YYYY-MM-DD
                const todayString = () => new Date().toISOString().split("T")[0];

                // ---------------------------
                //  COMMAND: HELP
                // ---------------------------
                if (command === "!help") {
                    return msg.reply(
                        `🤖 **SPRINT BOT COMMANDS**\n\n` +
                        `🏃 **!sprint 15** → Start 15 min sprint\n` +
                        `⏱️ **!time** → Check time remaining\n` +
                        `📝 **!wc 500** → Log words for sprint\n` +
                        `🏁 **!finish** → End sprint & save stats\n` +
                        `🚫 **!cancel** → Cancel current sprint\n\n` +
                        `📊 **STATS**\n` +
                        `📅 **!daily** → Today's leaderboard\n` +
                        `🗓️ **!weekly** → Last 7 days\n` +
                        `🏆 **!monthly** → Last 30 days\n\n` +
                        `🎯 **PERSONAL GOALS**\n` +
                        `🆕 **!goal set 50000** → Set new goal\n` +
                        `👀 **!goal check** → View progress`
                    );
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

                    const endTime = Date.now() + minutes * 60000;
                    
                    // DEBUG LOGGING
                    console.log(`Starting sprint. Duration: ${minutes}m. Ends at: ${new Date(endTime).toLocaleTimeString()}`);

                    activeSprints[chatId] = {
                        duration: minutes, 
                        endsAt: endTime,
                        participants: {}
                    };

                    await chat.sendMessage(
                        `🏁 *Writing Sprint Started!*\nDuration: *${minutes} minutes*\n\nUse *!wc <number>* to log words.`
                    );

                    // --- 🛡️ FIX: Try/Catch inside Timeout ---
                    setTimeout(async () => {
                        // Check if sprint still exists (wasn't cancelled)
                        if (activeSprints[chatId]) {
                            try {
                                console.log(`Sprint finished for chat: ${chatId}`); // Log for debugging
                                await chat.sendMessage(`🛑 **TIME'S UP!**\n\nReply with *!wc [number]* now.\nType *!finish* to end.`);
                            } catch (e) {
                                console.log("Failed to send timeout message (connection likely lost temporarily).", e);
                            }
                        }
                    }, minutes * 60000);
                    return;
                }

                // ---------------------------
                //  COMMAND: TIME (NEW!)
                // ---------------------------
                if (command === "!time") {
                    const sprint = activeSprints[chatId];
                    if (!sprint) {
                        return msg.reply("❌ No active sprint.");
                    }

                    const remainingMs = sprint.endsAt - Date.now();
                    
                    if (remainingMs <= 0) {
                        return msg.reply("🛑 Time is up! Type `!finish` to end.");
                    }

                    const mins = Math.floor((remainingMs / 1000) / 60);
                    const secs = Math.floor((remainingMs / 1000) % 60);

                    return msg.reply(`⏳ Time remaining: *${mins}m ${secs}s*`);
                }

                // ---------------------------
                //  COMMAND: WC (Word Count)
                // ---------------------------
                if (command === "!wc") {
                    const sprint = activeSprints[chatId];
                    if (!sprint) return msg.reply("❌ No active sprint. Start one: `!sprint 20`");

                    let count = 0;
                    let isAdding = false;

                    // Handle "!wc add 200" or "!wc + 200"
                    if (args[1] === 'add' || args[1] === '+') {
                        count = parseInt(args[2]);
                        isAdding = true;
                    } else {
                        count = parseInt(args[1]);
                    }

                    if (isNaN(count) || count < 0) return msg.reply("❌ Invalid number.");

                    // Init user if not present
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

                    // Process results
                    for (let i = 0; i < leaderboardArray.length; i++) {
                        let p = leaderboardArray[i];
                        
                        // Medal Logic
                        let medal = "🎖️";
                        if (i === 0) medal = "🥇";
                        if (i === 1) medal = "🥈";
                        if (i === 2) medal = "🥉";

                        // WPM Logic
                        const wpm = Math.round(p.words / sprint.duration);

                        // Format: 🥇 name : 50 words (2 WPM)
                        leaderboardText += `${medal} ${p.name} : ${p.words} words (${wpm} WPM)\n`;

                        // 1. Save to DailyStats
                        try {
                            await DailyStats.findOneAndUpdate(
                                { userId: p.uid, groupId: chatId, date },
                                { 
                                    name: p.name, 
                                    $inc: { words: p.words },
                                    timestamp: new Date()
                                },
                                { upsert: true, new: true }
                            );

                            // 2. Update Personal Goal (If Active)
                            const goal = await PersonalGoal.findOne({ userId: p.uid, isActive: true });
                            if (goal) {
                                goal.current += p.words;
                                await goal.save();

                                // Check if just completed
                                if (goal.current >= goal.target) {
                                    goalUpdateText += `\n🎉 @${p.uid.split('@')[0]} just COMPLETED their goal of ${goal.target} words!`;
                                    goal.isActive = false; // Mark finished
                                    await goal.save();
                                }
                            }

                        } catch (err) {
                            console.error("DB Save Error", err);
                        }
                    }

                    delete activeSprints[chatId];

                    leaderboardText += "\nGreat job everyone! Type !sprint to go again.";
                    
                    // Mention logic for goal completion
                    if (goalUpdateText) {
                         await chat.sendMessage(leaderboardText + "\n" + goalUpdateText, { 
                             mentions: leaderboardArray
                                .filter(p => goalUpdateText.includes(p.uid.split('@')[0]))
                                .map(p => p.uid) 
                         });
                    } else {
                        await chat.sendMessage(leaderboardText);
                    }
                    return;
                }

                // ---------------------------
                //  COMMAND: DAILY STATS
                // ---------------------------
                if (command === "!daily") {
                    const date = todayString();
                    const stats = await DailyStats.find({ groupId: chatId, date }).sort({ words: -1 });

                    if (stats.length === 0) return msg.reply("📅 No stats recorded today.");

                    let text = `📅 **Daily Leaderboard (${date})**\n\n`;
                    stats.forEach((s, i) => {
                        let medal = "🎖️";
                        if (i === 0) medal = "🥇";
                        if (i === 1) medal = "🥈";
                        if (i === 2) medal = "🥉";
                        text += `${medal} ${s.name}: ${s.words}\n`;
                    });
                    await chat.sendMessage(text);
                }

                // ---------------------------
                //  COMMAND: WEEKLY & MONTHLY
                // ---------------------------
                if (command === "!weekly" || command === "!monthly") {
                    const days = command === "!weekly" ? 7 : 30;
                    const title = command === "!weekly" ? "Weekly" : "Monthly";
                    
                    const cutoffDate = new Date();
                    cutoffDate.setDate(cutoffDate.getDate() - days);

                    // Aggregation Pipeline
                    const stats = await DailyStats.aggregate([
                        { 
                            $match: { 
                                groupId: chatId, 
                                timestamp: { $gte: cutoffDate } 
                            } 
                        },
                        { 
                            $group: { 
                                _id: "$userId", 
                                totalWords: { $sum: "$words" }, 
                                name: { $first: "$name" } 
                            } 
                        },
                        { $sort: { totalWords: -1 } },
                        { $limit: 15 } // Top 15 to prevent spam
                    ]);

                    if (stats.length === 0) return msg.reply(`📉 No stats found for the last ${days} days.`);

                    let text = `🏆 **${title} Leaderboard**\n\n`;
                    stats.forEach((s, i) => {
                        let medal = "🎖️";
                        if (i === 0) medal = "🥇";
                        if (i === 1) medal = "🥈";
                        if (i === 2) medal = "🥉";
                        text += `${medal} ${s.name}: ${s.totalWords}\n`;
                    });
                    await chat.sendMessage(text);
                }

                // ---------------------------
                //  COMMAND: GOAL SETTING
                // ---------------------------
                if (command === "!goal") {
                    const subCmd = args[1]?.toLowerCase();

                    // !goal set 50000
                    if (subCmd === "set") {
                        const target = parseInt(args[2]);
                        if (isNaN(target) || target <= 0) return msg.reply("❌ Use: `!goal set 50000`");

                        // Deactivate old goals
                        await PersonalGoal.updateMany({ userId: senderId }, { isActive: false });

                        await PersonalGoal.create({
                            userId: senderId,
                            name: senderName,
                            target: target,
                            current: 0,
                            isActive: true
                        });

                        return msg.reply(`🎯 Personal goal set to **${target}** words!\nJoin sprints to add to this total.`);
                    }

                    // !goal check
                    if (subCmd === "check" || subCmd === "status") {
                        const goal = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                        if (!goal) return msg.reply("❌ You don't have an active goal.\nSet one: `!goal set 50000`");

                        const percent = ((goal.current / goal.target) * 100).toFixed(1);
                        const progressBar = generateProgressBar(goal.current, goal.target);

                        return msg.reply(
                            `🎯 **Personal Goal Progress**\n` +
                            `👤 ${goal.name}\n` +
                            `📊 ${goal.current} / ${goal.target} words\n` +
                            `${progressBar} (${percent}%)\n` +
                            `📅 Started: ${goal.startDate}`
                        );
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

// =======================
//   HELPER FUNCTIONS
// =======================
function generateProgressBar(current, target) {
    const totalBars = 10;
    const progress = Math.min(current / target, 1);
    const filledBars = Math.round(progress * totalBars);
    const emptyBars = totalBars - filledBars;
    return "🟩".repeat(filledBars) + "⬜".repeat(emptyBars);
}