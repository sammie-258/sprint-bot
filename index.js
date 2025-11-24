const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// CONFIGURATION: Change this to true if running on Termux/Phone
const IS_MOBILE = false; 

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: IS_MOBILE ? {
        executablePath: '/data/data/com.termux/files/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    } : {}
});

// Store sprint data per group
// Key: GroupId
// Value: { active: bool, collecting: bool, duration: number, endTime: number, participants: Map(userId -> {count, name, contactObj}) }
const sprintData = new Map();

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Scan this QR code!');
});

client.on('ready', () => {
    console.log('Sprint Bot is Ready & Listening!');
});

client.on('message', async msg => {
    const chat = await msg.getChat();
    if (!chat.isGroup) return;

    const chatId = chat.id._serialized;
    const message = msg.body.toLowerCase().trim();
    const contact = await msg.getContact();

    // Initialize group data if not exists
    if (!sprintData.has(chatId)) {
        sprintData.set(chatId, { active: false, collecting: false, participants: new Map() });
    }
    const currentSprint = sprintData.get(chatId);

    // --- COMMAND: !SPRINT [MINUTES] ---
    if (message.startsWith('!sprint')) {
        if (currentSprint.active || currentSprint.collecting) {
            await msg.reply('⚠️ A sprint or collection phase is already active!');
            return;
        }

        // Parse time
        const args = message.split(' ');
        let duration = parseInt(args[1]) || 15; // Default 15
        if (duration > 120) duration = 120; // Cap at 2 hours

        // Reset and Start
        currentSprint.active = true;
        currentSprint.collecting = false;
        currentSprint.duration = duration;
        currentSprint.participants.clear(); // Clear previous scores
        currentSprint.endTime = Date.now() + (duration * 60 * 1000);

        await chat.sendMessage(`🚀 **SPRINT STARTED!**\n\n⏱️ **${duration} Minutes** on the clock.\n🏁 Go write! I will ping you when time is up.`);

        // Set Timer
        setTimeout(async () => {
            // Time is up! Switch to collection mode
            currentSprint.active = false;
            currentSprint.collecting = true;
            
            await chat.sendMessage(
                `🛑 **TIME'S UP! Pencils down!**\n\n` +
                `Reply with your word count like this:\n` +
                `Example: *!wc 500*\n\n` +
                `Type *!finish* when everyone is done to see the leaderboard.`
            );
        }, duration * 60 * 1000);
    }

    // --- COMMAND: !WC [NUMBER] (Submit Word Count) ---
    if (message.startsWith('!wc')) {
        if (!currentSprint.collecting) {
            // Only allow this if we are in collection mode
             return; 
        }

        const args = message.split(' ');
        const count = parseInt(args[1]);

        if (isNaN(count)) {
            await msg.reply('⚠️ Please type a number. Example: *!wc 450*');
            return;
        }

        // Calculate WPM
        const wpm = Math.round(count / currentSprint.duration);

        // Save data
        currentSprint.participants.set(contact.id._serialized, {
            name: contact.pushname || contact.number,
            count: count,
            wpm: wpm,
            contactObj: contact
        });

        await msg.react('✅'); // React to confirm receipt
    }

    // --- COMMAND: !FINISH (End Collection & Show Leaderboard) ---
    if (message === '!finish' || message === '!results') {
        if (!currentSprint.collecting) {
            await msg.reply('No results to show right now.');
            return;
        }

        if (currentSprint.participants.size === 0) {
            await msg.reply('❌ No one submitted any word counts!');
            currentSprint.collecting = false; // Reset
            return;
        }

        // Sort results: High to Low
        const sortedResults = Array.from(currentSprint.participants.values())
            .sort((a, b) => b.count - a.count);

        // Build the Leaderboard Message
        let leaderboard = `🏆 **SPRINT RESULTS** 🏆\n\n`;
        const mentions = [];

        sortedResults.forEach((p, index) => {
            let medal = '';
            if (index === 0) medal = '🥇';
            if (index === 1) medal = '🥈';
            if (index === 2) medal = '🥉';
            if (index > 2) medal = '🎖️';

            leaderboard += `${medal} @${p.contactObj.id.user} : *${p.count} words* (${p.wpm} WPM)\n`;
            mentions.push(p.contactObj);
        });

        leaderboard += `\nGreat job everyone! Type *!sprint* to go again.`;

        await chat.sendMessage(leaderboard, { mentions: mentions });

        // Reset State fully
        currentSprint.collecting = false;
        currentSprint.active = false;
    }

    // --- COMMAND: !CANCEL ---
    if (message === '!cancel') {
        if (currentSprint.active || currentSprint.collecting) {
            currentSprint.active = false;
            currentSprint.collecting = false;
            await msg.reply('🚫 Sprint cancelled and reset.');
        }
    }
});

client.initialize();