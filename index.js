const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const express = require('express');

// --- 1. SETUP SERVER ---
const app = express();
const port = process.env.PORT || 3000;

let qrCodeData = null;
let isConnected = false;

app.get('/', async (req, res) => {
    if (isConnected) {
        res.send('<h1>✅ Sprint Bot is Connected!</h1>');
    } else if (qrCodeData) {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`<div style="text-align:center;"><h1>Scan with WhatsApp</h1><img src="${qrImage}" style="border:1px solid #ccc;"></div>`);
    } else {
        res.send('<h1>⏳ Booting up... refresh in 10s.</h1>');
    }
});

app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));

// --- 2. DATABASE SCHEMA ---
const dailyStatsSchema = new mongoose.Schema({
    userId: String,
    name: String,
    groupId: String,
    date: String,
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

    const sprintData = new Map();

    client.on('qr', (qr) => { qrCodeData = qr; console.log('New QR Code generated'); });
    client.on('ready', () => { isConnected = true; console.log('Client is ready!'); });

    client.on('message', async msg => {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;

        const chatId = chat.id._serialized;
        const message = msg.body.toLowerCase().trim();
        const contact = await msg.getContact();
        const senderId = contact.id._serialized;
        const senderName = contact.pushname || contact.number;

        if (!sprintData.has(chatId)) {
            sprintData.set(chatId, { active: false, collecting: false, participants: new Map() });
        }
        const currentSprint = sprintData.get(chatId);

        // --- COMMAND: !HELP ---
        if (message === '!help' || message === '!commands') {
            await msg.reply(
                `🤖 **SPRINT BOT COMMANDS**\n\n` +
                `🏃 **!sprint 15** → Start a 15 min sprint\n` +
                `⏳ **!time** → Check remaining time\n` +
                `📝 **!wc 500** → Log 500 words\n` +
                `➕ **!wc add 200** → Add 200 to your score\n` +
                `🏁 **!finish** → End sprint & show results\n` +
                `📅 **!daily** → Show today's leaderboard\n` +
                `🚫 **!cancel** → Cancel current sprint`
            );
        }

        // --- COMMAND: !SPRINT ---
        if (message.startsWith('!sprint')) {
            if (currentSprint.active || currentSprint.collecting) {
                return msg.reply('⚠️ Sprint already in progress!');
            }

            const args = message.split(' ');
            let duration = parseInt(args[1]) || 15;
            if (duration > 180) duration = 180;

            currentSprint.active = true;
            currentSprint.collecting = false;
            currentSprint.duration = duration;
            currentSprint.participants.clear();
            currentSprint.startTime = Date.now();
            currentSprint.endTime = Date.now() + (duration * 60 * 1000);

            await chat.sendMessage(`🚀 **SPRINT STARTED!**\n\n⏱️ **${duration} Minutes** on the clock.\n🏁 Go write!`);

            setTimeout(async () => {
                if (!currentSprint.active) return;
                currentSprint.active = false;
                currentSprint.collecting = true;
                
                await chat.sendMessage(
                    `🛑 **TIME'S UP!**\n\n` +
                    `Reply with *!wc [number]* to log your words.\n` +
                    `Type *!finish* to see the leaderboard.`
                );
            }, duration * 60 * 1000);
        }

        // --- COMMAND: !TIME ---
        if (message === '!time') {
            if (!currentSprint.active) return msg.reply('❌ No sprint running.');
            const remainingMs = currentSprint.endTime - Date.now();
            const minutes = Math.floor((remainingMs / 1000) / 60);
            const seconds = Math.floor((remainingMs / 1000) % 60);
            await msg.reply(`⏳ **Time Remaining:** ${minutes}m ${seconds}s`);
        }

        // --- COMMAND: !WC (Fixed to work during sprint) ---
        if (message.startsWith('!wc')) {
            // Allow if active OR collecting
            if (!currentSprint.active && !currentSprint.collecting) return;

            const args = message.split(' ');
            let countInput = 0;
            let isAdditive = false;

            if (args[1] === 'add' || args[1] === '+') {
                countInput = parseInt(args[2]);
                isAdditive = true;
            } else {
                countInput = parseInt(args[1]);
            }

            if (isNaN(countInput)) return;

            let userData = currentSprint.participants.get(senderId) || { name: senderName, count: 0, contactObj: contact };
            
            if (isAdditive) {
                userData.count += countInput;
                // Only reply with text if we are in collection mode (to avoid spam during sprint)
                if(currentSprint.collecting) await msg.reply(`➕ Added ${countInput}. Total: *${userData.count}*`);
                else await msg.react('✍️'); 
            } else {
                userData.count = countInput;
                if(currentSprint.collecting) await msg.react('✅');
                else await msg.react('✍️'); // React with writing hand during sprint
            }

            currentSprint.participants.set(senderId, userData);
        }

        // --- COMMAND: !FINISH ---
        if (message === '!finish') {
            if (!currentSprint.collecting && !currentSprint.active) return;
            
            if (currentSprint.participants.size === 0) {
                currentSprint.active = false;
                currentSprint.collecting = false;
                return msg.reply('❌ Sprint ended. No words logged.');
            }

            const sortedResults = Array.from(currentSprint.participants.values()).sort((a, b) => b.count - a.count);
            let leaderboard = `🏆 **SPRINT RESULTS** 🏆\n\n`;
            const mentions = [];
            const todayDate = new Date().toISOString().split('T')[0];

            for (let i = 0; i < sortedResults.length; i++) {
                const p = sortedResults[i];
                const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '🎖️'));
                const wpm = Math.round(p.count / currentSprint.duration);

                leaderboard += `${medal} @${p.contactObj.id.user} : *${p.count}* (${wpm} wpm)\n`;
                mentions.push(p.contactObj);

                try {
                    await DailyStats.findOneAndUpdate(
                        { userId: p.contactObj.id._serialized, groupId: chatId, date: todayDate },
                        { $inc: { words: p.count }, $setOnInsert: { name: p.name } },
                        { upsert: true, new: true }
                    );
                } catch (err) { console.error("DB Error:", err); }
            }

            leaderboard += `\nStats saved to Daily Leaderboard! ✅`;
            leaderboard += `\n\nGreat job everyone! Type *!sprint* to go again.`;
            
            await chat.sendMessage(leaderboard, { mentions: mentions });

            currentSprint.collecting = false;
            currentSprint.active = false;
        }

        // --- COMMAND: !DAILY ---
        if (message === '!daily') {
            const todayDate = new Date().toISOString().split('T')[0];
            const stats = await DailyStats.find({ groupId: chatId, date: todayDate }).sort({ words: -1 });

            if (stats.length === 0) return msg.reply('📅 No stats recorded today.');

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