/**
 * index.js
 * Cleaner, safer Sprint Bot (whatsapp-web.js) — optimized for Render.
 *
 * Key fixes:
 * - Validate and normalize chat / contact IDs before sending to WhatsApp.
 * - Save correct userId for each participant when writing DB.
 * - Build mentions array of sanitized serialized IDs to avoid `.match` TypeErrors.
 * - Improved error handling and logging.
 */

const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const express = require('express');

// --- 1. SERVER SETUP ---
const app = express();
const port = process.env.PORT || 3000;

let qrCodeData = null;
let isConnected = false;

app.get('/', async (req, res) => {
    try {
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
    } catch (err) {
        console.error("Error rendering root:", err);
        res.status(500).send('Server error');
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

if (!MONGO_URI) {
    console.error("MONGO_URI not set. Exiting.");
    process.exit(1);
}

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => {
        const store = new MongoStore({ mongoose: mongoose });

        const client = new Client({
            authStrategy: new RemoteAuth({
                store: store,
                backupSyncIntervalMs: 300000
            }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ]
            }
        });

        // In-memory storage for active sprints
        const sprintData = new Map();

        // --- Helper functions ---
        const normalizeId = (id) => {
            // Ensure the id is a string and ends with the correct suffix (@c.us or @g.us)
            if (!id) return null;
            let s = String(id).trim();

            // If user passed in full serialized id, return it
            if (s.includes('@')) return s;

            // If it's digits only, assume a regular chat id (client expects country + number)
            s = s.replace(/\D/g, '');
            if (s.length === 0) return null;

            // Default to individual chat id
            return `${s}@c.us`;
        };

        const safeSerialized = (maybeObjOrString) => {
            // Return a guaranteed string for id._serialized if possible
            if (!maybeObjOrString) return null;

            // If it's an object with id._serialized
            if (typeof maybeObjOrString === 'object') {
                if (maybeObjOrString.id && maybeObjOrString.id._serialized) return String(maybeObjOrString.id._serialized);
                if (maybeObjOrString._serialized) return String(maybeObjOrString._serialized);
            }

            // If it's a string already
            if (typeof maybeObjOrString === 'string') return maybeObjOrString;

            // Fallback stringify
            try { return String(maybeObjOrString); } catch { return null; }
        };

        client.on('qr', (qr) => {
            qrCodeData = qr;
            console.log('New QR Code generated');
        });

        client.on('ready', () => {
            isConnected = true;
            console.log('Client is ready!');
        });

        client.on('auth_failure', (msg) => {
            console.error('AUTH FAILURE:', msg);
        });

        client.on('disconnected', (reason) => {
            isConnected = false;
            console.warn('Client disconnected:', reason);
        });

        client.on('message', async (msg) => {
            try {
                const chat = await msg.getChat();
                if (!chat) return;

                // Only operate in groups
                if (!chat.isGroup) return;

                // Normalize group chat id
                const chatIdRaw = chat.id && chat.id._serialized ? chat.id._serialized : (chat.id ? String(chat.id) : null);
                const chatId = normalizeId(chatIdRaw);
                if (!chatId) {
                    console.warn("Invalid chat id, skipping message");
                    return;
                }

                // Prepare message text lowercased for commands
                const message = (msg.body || '').toLowerCase().trim();

                // --- SMART CONTACT RECOVERY ---
                // We'll attempt to get the contact from the library; if that fails we'll build minimal safe data.
                let senderSerialized = null;
                let senderName = "Writer";
                let contactObj = null;

                try {
                    // Prefer official API
                    const contact = await msg.getContact();
                    if (contact && contact.id && contact.id._serialized) {
                        senderSerialized = String(contact.id._serialized);
                        senderName = contact.pushname || contact.number || senderSerialized.split('@')[0];
                        contactObj = contact;
                    }
                } catch (err) {
                    // msg.getContact() can fail for older messages; try fallbacks
                    if (msg.author) senderSerialized = String(msg.author);
                    else if (msg.from) senderSerialized = String(msg.from);

                    if (!senderSerialized && msg._data && msg._data.participant) senderSerialized = String(msg._data.participant);
                    if (!senderSerialized && msg._data && msg._data.notifyName) {
                        senderName = msg._data.notifyName;
                    }

                    if (senderSerialized) {
                        // sanitize
                        senderSerialized = normalizeId(senderSerialized) || senderSerialized;
                    }

                    // Build minimal safe contactObj (only fields whatsapp-web.js internals access)
                    contactObj = {
                        id: { _serialized: senderSerialized || 'unknown@c.us' },
                        pushname: senderName,
                        number: senderSerialized ? senderSerialized.split('@')[0] : 'unknown',
                        isMyContact: false
                    };
                }

                if (!senderSerialized) {
                    senderSerialized = safeSerialized(contactObj && contactObj.id && contactObj.id._serialized) || 'unknown@c.us';
                }

                // Ensure sprintData initialized for this group
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
                    return;
                }

                // --- COMMAND: !SPRINT ---
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

                    // Timer to switch to collecting state
                    setTimeout(async () => {
                        try {
                            if (!currentSprint.active) return;
                            currentSprint.active = false;
                            currentSprint.collecting = true;

                            await chat.sendMessage(
                                `🛑 **TIME'S UP!**\n\n` +
                                `Reply with *!wc [number]* to log your words.\n` +
                                `Type *!finish* to see the leaderboard.`
                            );
                        } catch (err) {
                            console.error("Error when ending sprint timer:", err);
                        }
                    }, duration * 60 * 1000);

                    return;
                }

                // --- COMMAND: !TIME ---
                if (message === '!time') {
                    if (!currentSprint.active) return msg.reply('❌ No sprint running.');
                    const remainingMs = Math.max(0, currentSprint.endTime - Date.now());
                    const minutes = Math.floor((remainingMs / 1000) / 60);
                    const seconds = Math.floor((remainingMs / 1000) % 60);
                    await msg.reply(`⏳ **Time Remaining:** ${minutes}m ${seconds}s`);
                    return;
                }

                // --- COMMAND: !WC ---
                if (message.startsWith('!wc')) {
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

                    if (isNaN(countInput)) return; // ignore invalid numbers

                    // Use participant key as senderSerialized (guaranteed normalized earlier)
                    const participantKey = senderSerialized || 'unknown@c.us';

                    let userData = currentSprint.participants.get(participantKey) || {
                        name: contactObj.pushname || contactObj.number || participantKey.split('@')[0],
                        count: 0,
                        contactObj: contactObj
                    };

                    if (isAdditive) {
                        userData.count += countInput;
                        if (currentSprint.collecting) await msg.reply(`➕ Added ${countInput}. Total: *${userData.count}*`);
                        else await msg.react('✍️');
                    } else {
                        userData.count = countInput;
                        if (currentSprint.collecting) await msg.react('✅');
                        else await msg.react('✍️');
                    }

                    // ensure contactObj stored is safe and has serialized id string
                    if (!userData.contactObj || !safeSerialized(userData.contactObj.id && userData.contactObj.id._serialized)) {
                        userData.contactObj = { id: { _serialized: participantKey }, pushname: userData.name, number: participantKey.split('@')[0] };
                    } else {
                        // keep the original, but ensure id._serialized is string
                        userData.contactObj.id._serialized = safeSerialized(userData.contactObj.id._serialized);
                    }

                    currentSprint.participants.set(participantKey, userData);
                    return;
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
                        const wpm = currentSprint.duration && currentSprint.duration > 0 ? Math.round(p.count / currentSprint.duration) : 0;

                        const username = p.contactObj && p.contactObj.id && p.contactObj.id._serialized
                            ? p.contactObj.id._serialized.split('@')[0]
                            : (p.name || 'unknown');

                        leaderboard += `${medal} @${username} : *${p.count}* (${wpm} wpm)\n`;

                        // Build mention array as safe serialized id strings (guaranteed string)
                        const serialized = safeSerialized(p.contactObj && p.contactObj.id && p.contactObj.id._serialized) || safeSerialized(p.contactObj);
                        const normalizedSerialized = normalizeId(serialized);
                        if (normalizedSerialized) {
                            mentions.push({ id: { _serialized: normalizedSerialized } });
                        }

                        // Save to Database with correct participant ID (not the last sender)
                        try {
                            const participantUserId = normalizedSerialized || username;
                            await DailyStats.findOneAndUpdate(
                                { userId: participantUserId, groupId: chatId, date: todayDate },
                                { $inc: { words: p.count }, $setOnInsert: { name: p.name || username } },
                                { upsert: true, new: true }
                            );
                        } catch (err) {
                            console.error("DB Error while saving participant stats:", err);
                        }
                    }

                    leaderboard += `\nStats saved to Daily Leaderboard! ✅`;
                    leaderboard += `\n\nGreat job everyone! Type *!sprint* to go again.`;

                    // Send leaderboard with sanitized mentions
                    try {
                        // whatsapp-web.js expects mentions as an array of Contact objects
                        // We'll pass simple objects with id._serialized strings (works and avoids .match failures)
                        await chat.sendMessage(leaderboard, { mentions: mentions });
                    } catch (err) {
                        console.error("Error sending leaderboard with mentions:", err);
                        // Fallback: Send without mentions so users still get results
                        await chat.sendMessage(leaderboard);
                    }

                    currentSprint.collecting = false;
                    currentSprint.active = false;
                    return;
                }

                // --- COMMAND: !DAILY ---
                if (message === '!daily') {
                    const todayDate = new Date().toISOString().split('T')[0];
                    try {
                        const stats = await DailyStats.find({ groupId: chatId, date: todayDate }).sort({ words: -1 });
                        if (!stats || stats.length === 0) return msg.reply('📅 No stats recorded today.');

                        let response = `📅 **DAILY LEADERBOARD (${todayDate})**\n\n`;
                        stats.forEach((s, index) => {
                            response += `${index + 1}. ${s.name}: *${s.words} words*\n`;
                        });
                        await chat.sendMessage(response);
                    } catch (err) {
                        console.error("DB Error getting daily stats:", err);
                        await msg.reply('Error fetching daily leaderboard.');
                    }
                    return;
                }

                // --- COMMAND: !CANCEL ---
                if (message === '!cancel') {
                    if (currentSprint.active || currentSprint.collecting) {
                        currentSprint.active = false;
                        currentSprint.collecting = false;
                        await msg.reply('🚫 Sprint cancelled.');
                    }
                    return;
                }

            } catch (err) {
                console.error("Error handling message:", err);
            }
        });

        client.initialize();
    })
    .catch(err => {
        console.error("MongoDB connection error:", err);
        process.exit(1);
    });
