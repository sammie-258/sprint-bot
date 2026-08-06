// =======================
//       IMPORTS
// =======================
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");
const express = require('express');
const http = require('http');
const os = require('os');
const QR = require('qrcode');
const fs = require('fs');
const path = require('path');
require("dotenv").config();

// =======================
//   HELPER FUNCTIONS
// =======================
const { toSuperscript, getRank, getNextRank, getMaxFreezes, getDurationString, getLagosDateString, getLagosMonthName, BADGE_DEFS } = require('./src/utils/helpers');

// =======================
//   CONFIG & SERVER SETUP
// =======================
const app    = express();
const PORT   = process.env.PORT || 3000;
const TIMEZONE = "Africa/Lagos";
const BASE_URL = process.env.RENDER_EXTERNAL_URL || "https://sprint-bot-9bll.onrender.com";
const OWNER_NUMBER   = '223733486772376@lid';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, x-admin-password");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const requireAdmin = (req, res, next) => {
    if (req.headers['x-admin-password'] === ADMIN_PASSWORD) return next();
    res.status(403).json({ error: "Unauthorized" });
};

let qrCodeData    = null;
let isConnected   = false;
let sock          = null;
let maintenanceMode = false;
let groupCache    = {};
let lastCacheUpdate = 0;
let lastDailyRunDate = "";

// In-memory stores
let activeSprints    = {};
let activePomodoros  = {};
let activeDuels      = {}; // chatId -> { challenger, opponent, duration, endsAt, words:{uid:n}, challengerName, opponentName, isGracePeriod }

// Rolling 20-event activity log for admin overview
const recentActivity = [];
const pushActivity = (type, text, icon = '📝') => {
    recentActivity.unshift({ type, text, icon, at: new Date() });
    if (recentActivity.length > 20) recentActivity.pop();
};

// Rate limiter: 10 commands per 60s, then 2-min cooldown
const rateLimiter = new Map();
const checkRateLimit = (userId) => {
    const now    = Date.now();
    const WINDOW  = 60000;
    const MAX     = 10;
    const COOLDOWN = 120000;
    if (!rateLimiter.has(userId)) rateLimiter.set(userId, []);
    const times = rateLimiter.get(userId).filter(t => now - t < WINDOW);
    if (times.length >= MAX) {
        if (now - times[0] < COOLDOWN) return false;
        rateLimiter.set(userId, [now]);
        return true;
    }
    times.push(now);
    rateLimiter.set(userId, times);
    return true;
};

// Periodically clean up stale rateLimiter entries every 10 minutes
setInterval(() => {
    const now = Date.now();
    const WINDOW = 60000;
    for (const [userId, times] of rateLimiter.entries()) {
        const valid = times.filter(t => now - t < WINDOW);
        if (valid.length === 0) rateLimiter.delete(userId);
        else rateLimiter.set(userId, valid);
    }
}, 10 * 60 * 1000);

const updateGroupCache = async (force = false) => {
    // Always reload from DB into local cache
    try {
        const dbGroups = await GroupMeta.find({});
        dbGroups.forEach(g => { groupCache[g.groupId] = { subject: g.subject, size: g.size }; });
    } catch (e) { console.log('⚠️ GroupCache DB read failed:', e.message); }
    
    // If forced (e.g. on connect), also sync from WhatsApp API into DB
    if (force && sock && isConnected) {
        try {
            const groups = await sock.groupFetchAllParticipating();
            for (const [jid, data] of Object.entries(groups)) {
                groupCache[jid] = { subject: data.subject, size: data.participants?.length || 0 };
                await GroupMeta.updateOne(
                    { groupId: jid },
                    { $set: { subject: data.subject, size: data.participants?.length || 0, lastActive: Date.now() } },
                    { upsert: true }
                );
            }
            console.log(`✅ Synced ${Object.keys(groups).length} groups to DB.`);
        } catch (e) { console.log("⚠️ Cache update paused:", e.message); }
    }
};

// =======================
//   DATABASE SCHEMAS
// =======================
const GroupMeta = require('./src/models/GroupMeta');
const DailyStats = require('./src/models/DailyStats');
const PersonalGoal = require('./src/models/PersonalGoal');
const ScheduledSprint = require('./src/models/ScheduledSprint');
const Blacklist = require('./src/models/Blacklist');
const ActiveSprint = require('./src/models/ActiveSprint');
const UserProfile = require('./src/models/UserProfile');
const GroupChallenge = require('./src/models/GroupChallenge');
const WeeklyChallenge = require('./src/models/WeeklyChallenge');
const SprintRecord = require('./src/models/SprintRecord');
const StreakFreeze = require('./src/models/StreakFreeze');
const Feedback = require('./src/models/Feedback');
const ScheduledBroadcast = require('./src/models/ScheduledBroadcast');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("❌ MONGO_URI missing"); process.exit(1); }

// =======================
//   WEB API ENDPOINTS
// =======================
const apiRoutes = require('./src/routes/api');
app.use('/', apiRoutes({
    get sock() { return sock; },
    get isConnected() { return isConnected; },
    set isConnected(v) { isConnected = v; },
    get qrCodeData() { return qrCodeData; },
    set qrCodeData(v) { qrCodeData = v; },
    get maintenanceMode() { return maintenanceMode; },
    set maintenanceMode(v) { maintenanceMode = v; },
    get activeSprints() { return activeSprints; },
    get activeDuels() { return activeDuels; },
    get activePomodoros() { return activePomodoros; },
    get recentActivity() { return recentActivity; },
    get groupCache() { return groupCache; },
    pushActivity,
    updateGroupCache
}));

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));
setInterval(() => { http.get(`http://localhost:${PORT}/`, () => {}).on('error', () => {}); }, 5 * 60 * 1000);

// =======================
//   MAIN LOGIC
// =======================
mongoose.connection.on('error', err => console.error('⚠️ MongoDB runtime error:', err));
mongoose.connection.on('disconnected', () => console.log('⚠️ MongoDB disconnected!'));
mongoose.connection.on('reconnected', () => console.log('✅ MongoDB reconnected!'));

mongoose.connect(MONGO_URI).then(async () => {
    console.log("✅ MongoDB connected");

    // Restore active sprints after crash
    const restoredSprints = await ActiveSprint.find({});
    restoredSprints.forEach(doc => {
        if (doc.endsAt > Date.now()) {
            activeSprints[doc.groupId] = { duration: doc.duration, endsAt: doc.endsAt, participants: doc.participants };
            const remaining = doc.endsAt - Date.now();
            setTimeout(async () => {
                if (activeSprints[doc.groupId] && sock && isConnected) {
                    try { await sock.sendMessage(doc.groupId, { text: `🛑 *TIME'S UP!* (Restored)\n\nReply with *!wc [number]* now.\nType *!finish* to end.` }); } catch (e) {}
                }
            }, remaining);
        } else {
            ActiveSprint.deleteOne({ _id: doc._id }).exec();
        }
    });

    const getTodayDateGMT1 = () => getLagosDateString();

    // =======================
    //   BADGE SYSTEM
    // =======================
    const awardBadge = async (profile, badgeKey, groupId) => {
        if (profile.badges.includes(badgeKey)) return false;
        profile.badges.push(badgeKey);
        await profile.save();
        const def = BADGE_DEFS.find(b => b.key === badgeKey);
        if (def && groupId && sock && isConnected) {
            try {
                await sock.sendMessage(groupId, {
                    text: `🏅 *BADGE UNLOCKED!*\n\n${def.icon} *${def.label}*\n@${profile.userId.split('@')[0]} — ${def.desc}`,
                    mentions: [profile.userId]
                });
            } catch (e) {}
        }
        return true;
    };

    const checkAndAwardBadges = async (profile, groupId) => {
        const t = profile.totalWordsAllTime;
        const s = profile.currentStreak;
        if (t > 0)       await awardBadge(profile, 'first_log',  groupId);
        if (s >= 7)      await awardBadge(profile, 'streak_7',   groupId);
        if (s >= 30)     await awardBadge(profile, 'streak_30',  groupId);
        if (s >= 100)    await awardBadge(profile, 'streak_100', groupId);
        if (t >= 10000)  await awardBadge(profile, 'words_10k',  groupId);
        if (t >= 100000) await awardBadge(profile, 'words_100k', groupId);
        if (t >= 250000) await awardBadge(profile, 'words_250k', groupId);
        if (t >= 500000) await awardBadge(profile, 'words_500k', groupId);
        if (t >= 1000000) await awardBadge(profile, 'novel_god', groupId);
        if (t >= 5000000)  await awardBadge(profile, 'words_5m',  groupId);
        if (t >= 10000000) await awardBadge(profile, 'words_10m', groupId);
        if (t >= 20000000) await awardBadge(profile, 'words_20m', groupId);

        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        if (profile.joinedAt && profile.joinedAt <= oneYearAgo) {
            await awardBadge(profile, 'bot_anniversary', groupId);
        }
    };

    // =======================
    //   STREAK MANAGER
    // =======================
    const updateStreak = async (userId, name, wordsToAdd) => {
        const today = getTodayDateGMT1();
        const d = new Date(); d.setDate(d.getDate() - 1);
        const yesterday = d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

        let profile = await UserProfile.findOne({ userId });
        if (!profile) {
            profile = await UserProfile.create({ userId, name, currentStreak: 1, bestStreak: 1, lastActiveDate: today, totalWordsAllTime: wordsToAdd });
            return { profile, status: 'new', rankUp: null, isNovelGod: false };
        }

        const oldRank = getRank(profile.totalWordsAllTime);
        profile.name = name;
        profile.totalWordsAllTime += wordsToAdd;
        const newRank = getRank(profile.totalWordsAllTime);
        const rankUp    = oldRank !== newRank ? newRank : null;
        const isNovelGod = rankUp === "Novel God ⚡";

        if (profile.lastActiveDate === today) {
            // no change
        } else if (profile.lastActiveDate === yesterday) {
            profile.currentStreak += 1;
            if (profile.currentStreak > profile.bestStreak) profile.bestStreak = profile.currentStreak;
            profile.lastActiveDate = today;
        } else {
            profile.currentStreak = 1;
            profile.lastActiveDate = today;
        }

        // Update 35-day activity bitmask (shift left, prepend today=1)
        let log = (profile.activityLog || '0'.repeat(35)).split('');
        log.unshift('1');
        if (log.length > 35) log.pop();
        profile.activityLog = log.join('');

        await profile.save();
        return { profile, status: 'updated', rankUp, isNovelGod };
    };

    // =======================
    //   CHALLENGE MANAGERS
    // =======================
    const updateChallenge = async (groupId, userId, name, wordsToAdd) => {
        const challenge = await GroupChallenge.findOne({ groupId });
        if (!challenge) return null;

        challenge.current += wordsToAdd;
        if (!challenge.contributors[userId]) challenge.contributors[userId] = { name, words: 0 };
        challenge.contributors[userId].words += wordsToAdd;
        challenge.contributors[userId].name = name;

        if (challenge.current >= challenge.target) {
            const leaderboard = Object.values(challenge.contributors).sort((a, b) => b.words - a.words);
            const top      = leaderboard[0];
            const mentions = Object.keys(challenge.contributors);
            const duration = getDurationString(challenge.startedAt);
            const list     = leaderboard.map((c, i) => {
                const uid = Object.keys(challenge.contributors).find(k => challenge.contributors[k].name === c.name);
                return `${i + 1}. ${uid ? '@' + uid.split('@')[0] : c.name}: ${c.words.toLocaleString()} words`;
            }).join('\n');
            const txt = `🎉 *CHALLENGE DESTROYED!* 🎉\n━━━━━━━━━━━━━━━━\n🎯 Target: *${challenge.target.toLocaleString()}*\n⚡ Total: ${challenge.current.toLocaleString()}\n⏱️ Completed in: *${duration}*\n\n👑 *MVP:* ${top.name} (${top.words.toLocaleString()})\n\n📜 *Contributors:*\n${list}`;
            const mvpUserId = Object.keys(challenge.contributors).find(k => challenge.contributors[k].name === top.name);
            await GroupChallenge.deleteOne({ _id: challenge._id });
            pushActivity('challenge', `Manual challenge destroyed in ${groupCache[groupId]?.subject || groupId}`, '🎉');
            return { completed: true, text: txt, mentions, mvpUserId };
        }
        await GroupChallenge.updateOne({ _id: challenge._id }, { current: challenge.current, contributors: challenge.contributors });
        return { completed: false };
    };

    const updateWeeklyChallenge = async (groupId, userId, name, wordsToAdd) => {
        const weekly = await WeeklyChallenge.findOne({ groupId, resolved: false, weekEnd: { $gte: new Date() } });
        if (!weekly) return null;

        weekly.current += wordsToAdd;
        if (!weekly.contributors[userId]) weekly.contributors[userId] = { name, words: 0 };
        weekly.contributors[userId].words += wordsToAdd;
        weekly.contributors[userId].name = name;

        if (weekly.current >= weekly.target) {
            const leaderboard = Object.values(weekly.contributors).sort((a, b) => b.words - a.words);
            const top      = leaderboard[0];
            const mentions = Object.keys(weekly.contributors);
            const txt = `🏆 *WEEKLY BOSS DEFEATED!* 🏆\n━━━━━━━━━━━━━━━━\n📅 Weekly Target: *${weekly.target.toLocaleString()}*\n⚡ You wrote: ${weekly.current.toLocaleString()} words!\n\n👑 *Top Contributor:* ${top.name} (${top.words.toLocaleString()})\n\nAmazing effort! 🎉`;
            weekly.resolved = true;
            weekly.markModified('contributors');
            await weekly.save();
            pushActivity('weekly', `Weekly challenge crushed in ${groupCache[groupId]?.subject || groupId}`, '🏆');
            return { completed: true, text: txt, mentions };
        }
        await WeeklyChallenge.updateOne({ _id: weekly._id }, { current: weekly.current, contributors: weekly.contributors });
        return { completed: false };
    };

    // =======================
    //   SPRINT SESSION
    // =======================
    const startSprintSession = async (chatId, duration) => {
        if (activeSprints[chatId]) return false;
        const endTime = Date.now() + duration * 60000;
        
        let warningTimer = null;
        if (duration > 5) {
            warningTimer = setTimeout(async () => {
                if (activeSprints[chatId]) { // Only send if sprint is still active
                    try { await sock.sendMessage(chatId, { text: `⏰ *5 MINUTES LEFT!*\n\nWrap up your thoughts — the sprint ends soon!\nGet ready to submit with *!wc [number]* 🖊️` }); } catch (e) {}
                }
            }, (duration - 5) * 60000);
        }

        const endTimer = setTimeout(async () => {
            if (activeSprints[chatId]) {
                try { await sock.sendMessage(chatId, { text: `🛑 *TIME'S UP!*\n\nSubmit with *!wc [number]* now.\nType *!finish* to see results.` }); } catch (e) {}
            }
        }, duration * 60000);

        activeSprints[chatId] = { duration, endsAt: endTime, participants: {}, warningTimer, endTimer };
        await ActiveSprint.create({ groupId: chatId, duration, endsAt: endTime, participants: {} });
        await sock.sendMessage(chatId, { text: `🏃 *Writing Sprint Started!*\nDuration: *${duration} minutes*\n\nUse *!wc <number>* to log words.` });
        
        pushActivity('sprint', `Sprint started in ${groupCache[chatId]?.subject || chatId}`, '🏃');
        return true;
    };

    // =======================
    //   FINISH SPRINT (shared logic)
    // =======================
    const finishSprint = async (chatId, todayStr) => {
        const s = activeSprints[chatId];
        if (!s) return null;

        if (s.warningTimer) clearTimeout(s.warningTimer);
        if (s.endTimer) clearTimeout(s.endTimer);

        const l = Object.entries(s.participants).map(([u, d]) => ({ ...d, uid: u })).sort((a, b) => b.words - a.words);
        delete activeSprints[chatId];
        await ActiveSprint.deleteOne({ groupId: chatId });

        if (l.length === 0) {
            await sock.sendMessage(chatId, { text: `🏃 *Sprint Finished*\n\nNo words logged. Type \`!sprint 15\` to try again!` });
            return { participants: [] };
        }

        let txt = `🏆 *SPRINT RESULTS* 🏆\n\n`;
        let mentions = [];
        const sprintParticipants = [];

        for (let i = 0; i < l.length; i++) {
            const p   = l[i];
            const wpm = Math.round(p.words / s.duration);
            mentions.push(p.uid);
            txt += `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.'} @${p.uid.split('@')[0]}: ${p.words.toLocaleString()} words (${wpm} WPM)\n`;
            sprintParticipants.push({ userId: p.uid, name: p.name, words: p.words, wpm });

            try {
                await DailyStats.findOneAndUpdate({ userId: p.uid, groupId: chatId, date: todayStr }, { name: p.name, $inc: { words: p.words }, timestamp: new Date() }, { upsert: true });
                const { rankUp, isNovelGod } = await updateStreak(p.uid, p.name, p.words);

                // Update sprint stats
                const sp = await UserProfile.findOne({ userId: p.uid });
                if (sp) {
                    sp.sprintCount      = (sp.sprintCount || 0) + 1;
                    sp.totalSprintWords = (sp.totalSprintWords || 0) + p.words;
                    if (p.words > sp.bestSprintWords) { sp.bestSprintWords = p.words; sp.bestSprintWpm = wpm; }
                    await sp.save();
                    await checkAndAwardBadges(sp, chatId);
                    if (p.words >= 500) await awardBadge(sp, 'sprint_500', chatId);
                }

                if (rankUp && !isNovelGod) txt += `   └─ 🎓 *RANK UP!* Now: *${rankUp}*!\n`;
                if (isNovelGod) {
                    txt += `   └─ ⚡ *NOVEL GOD! 1,000,000 words!*\n`;
                    try {
                        const allGroups = await sock.groupFetchAllParticipating();
                        for (const gid of Object.keys(allGroups)) {
                            try { await sock.sendMessage(gid, { text: `🌍 *WORLDWIDE ANNOUNCEMENT*\n⚡ *${p.name}* just hit 1,000,000 words — *Novel God ⚡*!\nCongratulations @${p.uid.split('@')[0]}! 🎉`, mentions: [p.uid] }); } catch (e) {}
                            await new Promise(r => setTimeout(r, 500));
                        }
                    } catch (e) {}
                }

                // Goals with milestones
                const g = await PersonalGoal.findOne({ userId: p.uid, isActive: true });
                if (g) {
                    const prevPct = (g.current / g.target) * 100;
                    g.current += p.words;
                    const newPct = (g.current / g.target) * 100;
                    if (g.current >= g.target) {
                        g.isActive = false; g.completedAt = new Date(); await g.save();
                        txt += `   └─ 🎉 *GOAL HIT!* (${getDurationString(g.startedAt)})\n`;
                    } else {
                        await g.save();
                        for (const m of [25, 50, 75]) {
                            if (prevPct < m && newPct >= m) {
                                const e = { 25: '🌱', 50: '🔥', 75: '⚡' };
                                await sock.sendMessage(chatId, { text: `${e[m]} *${m}% MILESTONE!* @${p.uid.split('@')[0]} is ${m}% of their goal! 💪`, mentions: [p.uid] });
                            }
                        }
                    }
                }

                // Both challenges
                const cr = await updateChallenge(chatId, p.uid, p.name, p.words);
                const wr = await updateWeeklyChallenge(chatId, p.uid, p.name, p.words);
                if (cr?.completed) {
                    await sock.sendMessage(chatId, { text: cr.text, mentions: cr.mentions });
                    const mvp = await UserProfile.findOne({ userId: cr.mvpUserId });
                    if (mvp) await awardBadge(mvp, 'challenge_mvp', chatId);
                }
                if (wr?.completed) await sock.sendMessage(chatId, { text: wr.text, mentions: wr.mentions });

            } catch (e) { console.error(e); }
        }

        await SprintRecord.create({ groupId: chatId, duration: s.duration, participants: sprintParticipants });
        txt += `\nGreat work! Type \`!sprint 15\` to go again!`;
        await sock.sendMessage(chatId, { text: txt, mentions });
        pushActivity('sprint', `Sprint finished in ${groupCache[chatId]?.subject || chatId}`, '🏁');
        return { participants: l };
    };

    // Periodically sweep and clean up zombie sprints past their end time
    setInterval(async () => {
        const now = Date.now();
        for (const [chatId, sprint] of Object.entries(activeSprints)) {
            if (sprint.endsAt && now > sprint.endsAt + (30 * 60000)) { // 30 minutes past end time
                console.log(`🧹 Auto-cleaning zombie sprint in ${chatId}`);
                if (sprint.warningTimer) clearTimeout(sprint.warningTimer);
                if (sprint.endTimer) clearTimeout(sprint.endTimer);
                delete activeSprints[chatId];
                try { await ActiveSprint.deleteOne({ groupId: chatId }); } catch (e) {}
            }
        }
    }, 15 * 60 * 1000);

    // =======================
    require('./src/jobs/scheduler')({
        get sock() { return sock; },
        get isConnected() { return isConnected; },
        get groupCache() { return groupCache; },
        getTodayDateGMT1,
        awardBadge,
        startSprintSession,
        TIMEZONE,
        pushActivity
    });
    // =======================
    //   BAILEYS INIT
    // =======================
    const { state, saveCreds } = await useMultiFileAuthState('.auth_info_baileys');

    let isInitializing = false;
    const initializeBot = async () => {
        if (isInitializing) return;
        isInitializing = true;
        try {
            if (sock) {
                console.log('🔄 Cleaning up previous socket instance...');
                try {
                    sock.ev.removeAllListeners('connection.update');
                    sock.ev.removeAllListeners('messages.upsert');
                    sock.ev.removeAllListeners('creds.update');
                    sock.ev.removeAllListeners('groups.upsert');
                    sock.end(undefined);
                } catch (e) {
                    console.log('⚠️ Error closing old socket:', e.message);
                }
            }

            const { version } = await fetchLatestBaileysVersion();
            sock = makeWASocket({
                version, auth: state, printQRInTerminal: true,
                browser: ['Sprint Bot', 'Chrome', '120.0'],
                msgRetryCounterMax: 5, defaultQueryTimeoutMs: 60000,
                shouldIgnoreJid: jid => !jid || jid === 'status@broadcast' || jid.includes('broadcast'),
                syncFullHistory: false, generateHighQualityLinkPreview: false,
            });

            isInitializing = false; // Reset initialization lock once socket is spawned
            let reconnectAttempts = 0;

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                if (qr) {
                    qrCodeData = qr;
                    console.log('⚠️ New QR Code');
                }
                if (connection === 'open') {
                    isConnected = true;
                    qrCodeData = null;
                    reconnectAttempts = 0;
                    updateGroupCache(true);
                    console.log('✅ Bot Connected!');
                    pushActivity('connect', 'Bot connected to WhatsApp', '✅');
                } else if (connection === 'close') {
                    isConnected = false;
                    const code = lastDisconnect?.error?.output?.statusCode;
                    console.log(`⚠️ Connection closed with status code: ${code}`);

                    if (code === DisconnectReason.loggedOut) {
                        console.log("🛑 Logged out. Delete .auth_info_baileys and restart.");
                    } else if (code === DisconnectReason.connectionReplaced || code === 440) {
                        console.log("🛑 Connection replaced! Another session was opened. Stopping auto-reconnect.");
                    } else {
                        reconnectAttempts++;
                        const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempts - 1), 30000);
                        console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
                        setTimeout(() => {
                            isInitializing = false;
                            initializeBot();
                        }, delay);
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

        // Welcome message when bot joins a new group
        sock.ev.on('groups.upsert', async (newGroups) => {
            for (const group of newGroups) {
                try {
                    await new Promise(r => setTimeout(r, 2000));
                    await sock.sendMessage(group.id, {
                        text: `👋 *Hey writers! Sprint Bot just joined the room!*\n\nI help you track writing sprints, word counts, streaks, and group challenges. Here's how to get started:\n\n📋 *!menu* — Interactive popup menu\n📖 *!help* — Full command list\n✍️ *!log 500* — Log your words right now\n🏃 *!sprint 20* — Start a 20-minute sprint\n📊 *!wc 500* — Submit your word count during a sprint\n🎯 *!goal set 1000* — Set a personal writing target\n\nLet's write! 🚀`
                    });
                    await GroupMeta.updateOne(
                        { groupId: group.id },
                        { $set: { subject: group.subject, size: group.participants?.length || 0, lastActive: Date.now() } },
                        { upsert: true }
                    );
                    pushActivity('join', `Joined group: ${group.subject}`, '👥');
                } catch (e) { console.error("Welcome msg error:", e); }
            }
        });

        // =======================
        //   MESSAGE HANDLER
        // =======================
        const messageHandler = require('./src/handlers/messageHandler');
        sock.ev.on('messages.upsert', async (m) => {
            await messageHandler(m, {
                get sock() { return sock; },
                get isConnected() { return isConnected; },
                get groupCache() { return groupCache; },
                get maintenanceMode() { return maintenanceMode; },
                get activeSprints() { return activeSprints; },
                get activePomodoros() { return activePomodoros; },
                get activeDuels() { return activeDuels; },
                checkRateLimit, getTodayDateGMT1, awardBadge, checkAndAwardBadges,
                updateStreak, updateChallenge, updateWeeklyChallenge,
                startSprintSession, finishSprint, pushActivity
            });
        });
        } catch (e) {
            console.error('🔄 Connection initialization failed:', e.message);
            setTimeout(() => {
                isInitializing = false;
                initializeBot();
            }, 5000);
            return;
        }
        isInitializing = false;
    };

    initializeBot();

}).catch(err => { console.error("❌ MongoDB error:", err); process.exit(1); });

process.on('unhandledRejection', reason => console.log('⚠️ Unhandled:', reason));
process.on('uncaughtException',  err    => console.log('⚠️ Exception:', err));