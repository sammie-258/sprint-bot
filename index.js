// =======================
//       IMPORTS
// =======================
const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require("mongoose");
const QRCode = require('qrcode');
const express = require('express');
require("dotenv").config();

// =======================
//   SERVER & WEB QR SETUP
// =======================
const app = express();
const PORT = process.env.PORT || 3000;

let qrCodeData = null;
let isConnected = false;

// Web page to display QR Code
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
//   DATABASE & MONGOOSE
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

// Connection Check
const MONGO_URI = process.env.MONGO_URI; 
if (!MONGO_URI) {
    console.error("❌ ERROR: MONGO_URI is missing in Render Environment Variables!");
    process.exit(1);
}

// In-memory storage for active sprints
let activeSprints = {}; 

// =======================
//   MAIN LOGIC WRAPPER
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

        // =======================
        //   CLIENT EVENT LISTENERS
        // =======================

        client.on("qr", qr => {
            qrCodeData = qr; 
            console.log("New QR Code generated");
        });

        client.on("ready", () => {
            isConnected = true;
            console.log("Client is ready!");
        });

        // =======================
        //     MESSAGE HANDLER
        // =======================

        client.on("message", async msg => {
            try {
                const chat = await msg.getChat();
                if (!chat.isGroup) return; 

                const chatId = chat.id._serialized;

                // --- 🛡️ SAFETY NET: SMART NAME RECOVERY ---
                let senderId = msg.author || msg.from;
                let senderName = "Writer"; 
                let realContactObj = null; // Store the REAL object if we find it
                
                try {
                    const contact = await msg.getContact();
                    senderId = contact.id._serialized;
                    senderName = contact.pushname || contact.name || contact.number;
                    // SAVE THIS! This is the only object safe to tag
                    realContactObj = contact; 
                } catch (err) {
                    // Fallback to raw data
                    if (msg._data && msg._data.notifyName) {
                        senderName = msg._data.notifyName;
                    } else {
                        senderName = senderId.split('@')[0];
                    }
                }

                if (!msg.body.startsWith("!")) return;

                const args = msg.body.trim().split(" ");
                const command = args[0].toLowerCase();

                // --- HELPER: Today String ---
                const todayString = () => new Date().toISOString().split("T")[0];

                // --- HELP COMMAND ---
                if (command === "!help") {
                    return msg.reply(
                        `🤖 **SPRINT BOT COMMANDS**\n\n` +
                        `🏃 **!sprint 15** → Start 15 min sprint\n` +
                        `📝 **!wc 500** → Log 500 words\n` +
                        `➕ **!wc add 200** → Add 200 words\n` +
                        `🏁 **!finish** → End & show results\n` +
                        `📅 **!daily** → Today's stats\n` +
                        `🚫 **!cancel** → Cancel sprint`
                    );
                }

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
                        participants: {} 
                    };

                    await chat.sendMessage(
                        `🏁 *Writing Sprint Started!*\nDuration: *${minutes} minutes*\n\nUse *!wc <number>* to log words.`
                    );

                    // Auto-ping when time is up
                    setTimeout(async () => {
                        if (activeSprints[chatId]) {
                            await chat.sendMessage(`🛑 **TIME'S UP!**\n\nReply with *!wc [number]* now.\nType *!finish* to end.`);
                        }
                    }, minutes * 60000);
                    return;
                }

                // =======================
                //   SUBMIT WORD COUNT
                // =======================
                if (command === "!wc") {
                    const sprint = activeSprints[chatId];
                    if (!sprint) {
                        return msg.reply("❌ No active sprint.\nStart one with: `!sprint 20`");
                    }

                    let count = 0;
                    let isAdding = false;

                    if (args[1] === 'add' || args[1] === '+') {
                        count = parseInt(args[2]);
                        isAdding = true;
                    } else {
                        count = parseInt(args[1]);
                    }

                    if (isNaN(count) || count < 0) {
                        return msg.reply("❌ Invalid number.\nUse: `!wc 456`");
                    }

                    // Initialize or Update User
                    // We save 'realContactObj' here so we can use it later for tagging
                    if (!sprint.participants[senderId]) {
                        sprint.participants[senderId] = { 
                            name: senderName, 
                            words: 0,
                            contact: realContactObj 
                        };
                    } else {
                        // If we didn't have the contact object before but we do now, update it
                        if (realContactObj) {
                            sprint.participants[senderId].contact = realContactObj;
                        }
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
                        .map(([uid, data]) => ({ ...data, uid })) 
                        .sort((a, b) => b.words - a.words);

                    if (leaderboardArray.length === 0) {
                        delete activeSprints[chatId];
                        return msg.reply("🏁 Sprint ended! No entries recorded.");
                    }

                    let leaderboardText = `🏁 *Sprint Finished!*\n📅 Date: ${date}\n\n*Leaderboard:*\n`;
                    let mentions = [];
                    
                    for (let i = 0; i < leaderboardArray.length; i++) {
                        let p = leaderboardArray[i];
                        
                        // --- MANUAL TAGGING LOGIC ---
                        // We extract the number directly from the ID (e.g. "23480...@c.us" -> "23480...")
                        const userId = p.uid;
                        const userNumber = userId.split('@')[0];

                        // 1. Build the text string with the @ symbol
                        leaderboardText += `${i + 1}. @${userNumber} — ${p.words} words\n`;
                        
                        // 2. Build a "Fake" Contact object that satisfies WhatsApp's requirements
                        // This bypasses the broken "getContact()" function entirely
                        mentions.push({ 
                            id: { 
                                _serialized: userId 
                            } 
                        });

                        // Save to DB
                        try {
                            await DailyStats.findOneAndUpdate(
                                { userId: p.uid, groupId: chatId, date },
                                { name: p.name, $inc: { words: p.words } },
                                { upsert: true, new: true }
                            );
                        } catch (err) {
                            console.error("DB Save Error", err);
                        }
                    }

                    delete activeSprints[chatId];
                    
                    // Send with our manually constructed mentions
                    await chat.sendMessage(leaderboardText, { mentions: mentions });
                    return;
                }
                
                // =======================
                //      DAILY STATS
                // =======================
                if (command === "!daily") {
                    const date = todayString();
                    const stats = await DailyStats.find({ groupId: chatId, date }).sort({ words: -1 });

                    if (stats.length === 0) return msg.reply("📅 No stats recorded today.");

                    let text = `📅 **Daily Leaderboard (${date})**\n\n`;
                    stats.forEach((s, i) => {
                        text += `${i+1}. ${s.name}: ${s.words}\n`;
                    });
                    await chat.sendMessage(text);
                }

                // =======================
                //      CANCEL SPRINT
                // =======================
                if (command === "!cancel") {
                    if (activeSprints[chatId]) {
                        delete activeSprints[chatId];
                        await msg.reply("🚫 Sprint cancelled.");
                    }
                }

            } catch (err) {
                console.error("Message handler error:", err);
            }
        });

        // Start the bot NOW that DB is ready
        client.initialize();
    })
    .catch(err => {
        console.error("❌ MongoDB connection error:", err);
        process.exit(1);
    });