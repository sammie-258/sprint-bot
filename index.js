const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const express = require('express');

// --- 1. SETUP SERVER & DATABASE ---
const app = express();
const port = process.env.PORT || 3000;

// Website to display QR Code
let qrCodeData = null;
let isConnected = false;

app.get('/', async (req, res) => {
    if (isConnected) {
        res.send('<h1>✅ Sprint Bot is Connected & Running!</h1>');
    } else if (qrCodeData) {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`<div style="text-align:center;"><h1>Scan with WhatsApp</h1><img src="${qrImage}" style="border:1px solid #ccc;"></div>`);
    } else {
        res.send('<h1>⏳ Booting up... refresh in 10s.</h1>');
    }
});

app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));

// --- 2. DEFINE DATABASE SCHEMAS ---
// We need a schema to save the Daily Stats
const dailyStatsSchema = new mongoose.Schema({
    userId: String,
    name: String,
    groupId: String,
    date: String, // Format: YYYY-MM-DD
    words: Number
});
const DailyStats = mongoose.model('DailyStats', dailyStatsSchema);


// --- 3. BOT LOGIC ---
const MONGO_URI = process.env.MONGO_URI; 

mongoose.connect(MONGO_URI).then(() => {
    const store = new MongoStore({ mongoose: mongoose });
    const client = new Client({
        authStrategy: new RemoteAuth({ store: store, backupSyncIntervalMs: 300000 }),
        puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    // In-Memory Storage for current sprint (clears on restart, which is fine for short sprints)
    const sprintData = new Map();

    client.on('qr', (qr) => { qrCodeData = qr; console.log('New QR Code generated'); });
    client.on('ready', () => { isConnected = true; console.log('Client is ready!'); });

    client.on('message', async msg => {
        const chat = await msg.getChat();
        if (!chat.isGroup) return; // Only work in groups

        const chatId = chat.id._serialized;
        const message = msg.body.toLowerCase().trim();
        const contact = await msg.getContact();
        const senderId = contact.id._serialized;
        const senderName = contact.pushname || contact.number;

        // Initialize group data
        if (!sprintData.has(chatId)) {
            sprintData.set(chatId, { active: false, collecting: false, participants: new Map() });
        }
        const currentSprint = sprintData.get(chatId);

        // --- COMMAND: !SPRINT [MINUTES] ---
        if (message.startsWith('!sprint')) {
            if (currentSprint.active || currentSprint.collecting) {
                return msg.reply('⚠️ Sprint already in progress!');
            }

            const args = message.split(' ');
            let duration = parseInt(args[1]) || 15;
            if (duration > 180) duration = 180; // Cap at 3 hours

            currentSprint.active = true;
            currentSprint.collecting = false;
            currentSprint.duration = duration;
            currentSprint.participants.clear();
            currentSprint.startTime = Date.now();
            currentSprint.endTime = Date.now() + (duration * 60 * 1000);

            await chat.sendMessage(`🚀 **SPRINT STARTED!**\n\n⏱️ **${duration} Minutes** on the clock.\n🏁 Go write!`);

            // Timer to end sprint
            setTimeout(async () => {
                if (!currentSprint.active) return; // If cancelled
                currentSprint.active = false;
                currentSprint.collecting = true;
                
                await chat.sendMessage(
                    `🛑 **TIME'S UP! Pencils down!**\n\n` +
                    `Reply with your word count like this:\n` +
                    `*!wc 500* (to set score)\n` +
                    `*!wc add 200* (to add to score)\n\n` +
                    `Type *!finish* to end.`
                );
            }, duration * 60 * 1000);
        }

        // --- COMMAND: !TIME (Check Remaining Time) ---
        if (message === '!time' || message === '!timer') {
            if (!currentSprint.active) return msg.reply('❌ No sprint is running.');
            
            const remainingMs = currentSprint.endTime - Date.now();
            const minutes = Math.floor((remainingMs / 1000) / 60);
            const seconds = Math.floor((remainingMs / 1000) % 60);
            
            await msg.reply(`⏳ **Time Remaining:** ${minutes}m ${seconds}s`);
        }

        // --- COMMAND: !WC (Submit/Add Word Count) ---
        if (message.startsWith('!wc')) {
            if (!currentSprint.active && !currentSprint.collecting) return; // Ignore if idle

            const args = message.split(' ');
            let countInput = 0;
            let isAdditive = false;

            // Handle "!wc add 500" or "!wc +500"
            if (args[1] === 'add' || args[1] === '+') {
                countInput = parseInt(args[2]);
                isAdditive = true;
            } else {
                countInput = parseInt(args[1]);
            }

            if (isNaN(countInput)) return;

            // Get existing data or create new
            let userData = currentSprint.participants.get(senderId) || { name: senderName, count: 0, contactObj: contact };
            
            let previousCount = userData.count;
            if (isAdditive) {
                userData.count += countInput;
                await msg.reply(`➕ Added ${countInput}. Total: *${userData.count}*`);
            } else {
                userData.count = countInput;
                if (currentSprint.collecting) await msg.react('✅'); // Only react in collection phase
            }

            // Save back to map
            currentSprint.participants.set(senderId, userData);
        }

        // --- COMMAND: !FINISH (Leaderboard + Save to DB) ---
        if (message === '!finish' || message === '!results') {
            if (!currentSprint.collecting && !currentSprint.active) return;
            
            if (currentSprint.participants.size === 0) {
                currentSprint.active = false;
                currentSprint.collecting = false;
                return msg.reply('❌ Sprint ended. No one wrote anything!');
            }

            // 1. Generate Leaderboard
            const sortedResults = Array.from(currentSprint.participants.values()).sort((a, b) => b.count - a.count);
            let leaderboard = `🏆 **SPRINT RESULTS** 🏆\n\n`;
            const mentions = [];
            const todayDate = new Date().toISOString().split('T')[0]; // 2025-11-24

            // 2. Loop through users and Save to DB
            for (let i = 0; i < sortedResults.length; i++) {
                const p = sortedResults[i];
                const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '🎖️'));
                
                // Calculate WPM
                const minutes = currentSprint.duration;
                const wpm = Math.round(p.count / minutes);

                leaderboard += `${medal} @${p.contactObj.id.user} : *${p.count}* (${wpm} wpm)\n`;
                mentions.push(p.contactObj);

                // DATABASE SAVE: Find today's entry and add words, or create new
                try {
                    await DailyStats.findOneAndUpdate(
                        { userId: p.contactObj.id._serialized, groupId: chatId, date: todayDate },
                        { 
                            $inc: { words: p.count }, // Increment words
                            $setOnInsert: { name: p.name } // Set name only if creating new
                        },
                        { upsert: true, new: true }
                    );
                } catch (err) {
                    console.error("DB Error:", err);
                }
            }

            leaderboard += `\nStats saved to Daily Leaderboard! ✅`;
            await chat.sendMessage(leaderboard, { mentions: mentions });

            // Reset
            currentSprint.collecting = false;
            currentSprint.active = false;
        }

        // --- COMMAND: !DAILY (View Daily Stats) ---
        if (message === '!daily') {
            const todayDate = new Date().toISOString().split('T')[0];
            
            // Find all stats for THIS group and THIS date
            const stats = await DailyStats.find({ groupId: chatId, date: todayDate }).sort({ words: -1 });

            if (stats.length === 0) {
                return msg.reply('📅 No stats recorded for today yet.');
            }

            let response = `📅 **DAILY LEADERBOARD (${todayDate})**\n\n`;
            stats.forEach((s, index) => {
                response += `${index + 1}. ${s.name}: *${s.words} words*\n`;
            });

            await chat.sendMessage(response);
        }

        // --- COMMAND: !CANCEL ---
        if (message === '!cancel') {
            if (currentSprint.active || currentSprint.collecting) {
                currentSprint.active = false;
                currentSprint.collecting = false;
                await msg.reply('🚫 Sprint cancelled.');
            }
        }
    });

    client.initialize();
}).catch(err => console.error("MongoDB connection error:", err));