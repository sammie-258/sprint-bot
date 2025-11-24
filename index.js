// =======================
//      IMPORTS
// =======================
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const mongoose = require("mongoose");
require("dotenv").config();

// =======================
//   DATABASE MODELS
// =======================

// Daily stats schema
const dailyStatsSchema = new mongoose.Schema({
    userId: String,
    name: String,
    groupId: String,
    date: String,
    words: { type: Number, default: 0 }
});
const DailyStats = mongoose.model("DailyStats", dailyStatsSchema);

// =======================
//   MONGOOSE CONNECTION
// =======================

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("MongoDB connected"))
    .catch(err => console.error("MongoDB connection error:", err));


// =======================
//   WHATSAPP CLIENT
// =======================

const client = new Client({
    authStrategy: new LocalAuth(),
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

client.on("qr", qr => qrcode.generate(qr, { small: true }));
client.on("ready", () => console.log("Client is ready!"));

// =======================
//   SPRINT DATA STORE
// =======================

let activeSprints = {}; // groupId → sprint data

// =======================
//     HELPERS
// =======================

// Clean WhatsApp user IDs
function normalizeId(id) {
    if (!id) return null;
    return id.includes("@") ? id : `${id}@c.us`;
}

// Get today in YYYY-MM-DD
function todayString() {
    return new Date().toISOString().split("T")[0];
}

// =======================
//     MESSAGE HANDLER
// =======================

client.on("message", async msg => {
    try {
        const chat = await msg.getChat();
        const sender = await msg.getContact();

        const chatId = chat.id._serialized;
        const senderId = sender.id._serialized;
        const senderName = sender.pushname || sender.name || "Unknown";

        // =======================
        //   COMMAND HANDLING
        // =======================
        if (!msg.body.startsWith("!")) return;

        const args = msg.body.trim().split(" ");
        const command = args[0].toLowerCase();

        // =======================
        //   START SPRINT
        // =======================
        if (command === "!sprint") {
            let minutes = parseInt(args[1]);
            if (isNaN(minutes) || minutes <= 0 || minutes > 180) {
                return msg.reply("❌ Invalid time. Use: `!sprint 20`");
            }

            if (activeSprints[chatId]) {
                return msg.reply("⚠️ A sprint is already running in this chat.");
            }

            activeSprints[chatId] = {
                endsAt: Date.now() + minutes * 60000,
                participants: {} // userId → { name, words }
            };

            return msg.reply(
                `🏁 *Writing Sprint Started!*\nDuration: *${minutes} minutes*\n\nUse *!wc <number>* when you're done!`
            );
        }

        // =======================
        //   SUBMIT WORD COUNT
        // =======================
        if (command === "!wc") {
            const sprint = activeSprints[chatId];
            if (!sprint) {
                return msg.reply("❌ No active sprint.\nStart one with: `!sprint 20`");
            }

            if (Date.now() > sprint.endsAt) {
                return msg.reply("⏳ Sprint already ended. Use `!finish`.");
            }

            let count = parseInt(args[1]);
            if (isNaN(count) || count < 0) {
                return msg.reply("❌ Invalid number.\nUse: `!wc 456`");
            }

            if (!sprint.participants[senderId]) {
                sprint.participants[senderId] = { name: senderName, words: 0 };
            }

            sprint.participants[senderId].words += count;

            return msg.reply(
                `✅ *${senderName}* added *${count} words!*\nTotal: *${sprint.participants[senderId].words}*`
            );
        }

        // =======================
        //      FINISH SPRINT
        // =======================
        if (command === "!finish") {
            const sprint = activeSprints[chatId];
            if (!sprint) {
                return msg.reply("❌ No active sprint running.");
            }

            const date = todayString();
            const leaderboardArray = Object.entries(sprint.participants)
                .map(([uid, data]) => data)
                .sort((a, b) => b.words - a.words);

            if (leaderboardArray.length === 0) {
                delete activeSprints[chatId];
                return msg.reply("🏁 Sprint ended! No entries recorded.");
            }

            let leaderboardText = `🏁 *Sprint Finished!*\n📅 Date: ${date}\n\n*Leaderboard:*\n`;
            let mentionIds = [];

            for (let i = 0; i < leaderboardArray.length; i++) {
                let p = leaderboardArray[i];
                leaderboardText += `${i + 1}. *${p.name}* — ${p.words} words\n`;
                mentionIds.push(normalizeId(Object.keys(sprint.participants)[i]));

                // Save to DB
                await DailyStats.findOneAndUpdate(
                    { userId: mentionIds[i], groupId: chatId, date },
                    { name: p.name, $inc: { words: p.words } },
                    { upsert: true }
                );
            }

            delete activeSprints[chatId];

            await chat.sendMessage(leaderboardText, { mentions: mentionIds });

            return;
        }
    } catch (err) {
        console.error("Message handler error:", err);
    }
});

// =======================
//       START SERVER
// =======================

client.initialize();

const PORT = process.env.PORT || 10000;
require("http").createServer((req, res) => {
    res.end("Sprint bot running.");
}).listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
