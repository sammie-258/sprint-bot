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

// Website to display QR Code and Status
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
    
    // MEMORY OPTIMIZATION SETTINGS (Prevents crashes on Render Free Tier)
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

    client.on('qr', (qr) => { qrCodeData = qr; console.log('New QR Code generated'); });
    client.on('ready', () => { isConnected = true; console.log('Client is ready!'); });

    client.on('message', async msg => {
        const chat = await msg.getChat();
        if (!chat.isGroup) return; // Only work in groups

        const chatId = chat.id._serialized;
        const message = msg.body.toLowerCase().trim();

        // --- SMART CONTACT RECOVERY (The MacGyver Fix) ---
        // Tries to get the official contact, but falls back to raw data if it fails
        let senderId = msg.author || msg.from;
        let senderName = "Writer"; 
        let contactObj;

        try {
            // 1. Try the official way
            const contact = await msg.getContact();
            senderId = contact.id._serialized;
            senderName = contact.pushname || contact.number;
            contactObj = contact;
        } catch (err) {
            // 2. If official way fails, use raw message data
            // console.log("Using fallback name logic");
            if (msg._data && msg._data.notifyName) {
                senderName = msg._data.notifyName;
            } else {
                senderName = senderId.split('@')[0]; 
            }
            
            // Create a manual contact object so mentions still work
            contactObj = { 
                id: { user: senderId.split('@')[0], _serialized: senderId }, 
                pushname: senderName,
                number: senderId.split('@')[0],
                isMyContact: false
            };
        }
        // ----------------------------------------------------

        // Initialize group data if missing
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
            if (duration > 180) duration = 180; // Cap at 3 hours

            currentSprint