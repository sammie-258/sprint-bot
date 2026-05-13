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
const { toSuperscript, getRank, getNextRank, getMaxFreezes, getDurationString, BADGE_DEFS } = require('./src/utils/helpers');

// =======================
//   CONFIG & SERVER SETUP
// =======================
const app    = express();
const PORT   = process.env.PORT || 3000;
const TIMEZONE = "Africa/Lagos";
const BASE_URL = process.env.RENDER_EXTERNAL_URL || "https://quillreads.com";
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

const updateGroupCache = async (force = false) => {
    if (!force) return;
    if (sock && isConnected) {
        try {
            const groups = await sock.groupFetchAllParticipating();
            for (const [jid, data] of Object.entries(groups)) {
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
    get qrCodeData() { return qrCodeData; },
    get maintenanceMode() { return maintenanceMode; },
    set maintenanceMode(v) { maintenanceMode = v; },
    get activeSprints() { return activeSprints; },
    get activeDuels() { return activeDuels; },
    get activePomodoros() { return activePomodoros; },
    get recentActivity() { return recentActivity; },
    updateGroupCache
}));

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));
setInterval(() => { http.get(`http://localhost:${PORT}/`, () => {}).on('error', () => {}); }, 5 * 60 * 1000);

// =======================
//   MAIN LOGIC
// =======================
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

    const getTodayDateGMT1 = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });

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
        activeSprints[chatId] = { duration, endsAt: endTime, participants: {} };
        await ActiveSprint.create({ groupId: chatId, duration, endsAt: endTime, participants: {} });
        await sock.sendMessage(chatId, { text: `🏃 *Writing Sprint Started!*\nDuration: *${duration} minutes*\n\nUse *!wc <number>* to log words.` });
        setTimeout(async () => {
            if (activeSprints[chatId]) {
                try { await sock.sendMessage(chatId, { text: `🛑 *TIME'S UP!*\n\nSubmit with *!wc [number]* now.\nType *!finish* to see results.` }); } catch (e) {}
            }
        }, duration * 60000);
        pushActivity('sprint', `Sprint started in ${groupCache[chatId]?.subject || chatId}`, '🏃');
        return true;
    };

    // =======================
    //   FINISH SPRINT (shared logic)
    // =======================
    const finishSprint = async (chatId, todayStr) => {
        const s = activeSprints[chatId];
        if (!s) return null;
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
            txt += `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🎖️'} @${p.uid.split('@')[0]}: ${p.words.toLocaleString()} words (${wpm} WPM)\n`;
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

    // =======================
    //   SCHEDULERS
    // =======================

    // Scheduled sprints checker
    setInterval(async () => {
        if (!isConnected) return;
        try {
            const due = await ScheduledSprint.find({ startTime: { $lte: new Date() } });
            for (const sprint of due) {
                const started = await startSprintSession(sprint.groupId, sprint.duration);
                if (started) {
                    await sock.sendMessage(sprint.groupId, { text: `(Scheduled by @${sprint.createdBy.split('@')[0]})`, mentions: [sprint.createdBy] });
                }
                await ScheduledSprint.deleteOne({ _id: sprint._id });
            }
        } catch (e) { console.error("Sprint scheduler:", e); }
    }, 60000);

    // Scheduled broadcasts checker
    setInterval(async () => {
        if (!isConnected) return;
        try {
            const due = await ScheduledBroadcast.find({ sent: false, sendAt: { $lte: new Date() } });
            for (const broadcast of due) {
                const groups = await sock.groupFetchAllParticipating();
                for (const gid of Object.keys(groups)) {
                    try {
                        if (broadcast.image) {
                            const buffer = Buffer.from(broadcast.image.split(",")[1], 'base64');
                            await sock.sendMessage(gid, { image: buffer, caption: broadcast.message || "" });
                        } else {
                            await sock.sendMessage(gid, { text: broadcast.message });
                        }
                        await new Promise(r => setTimeout(r, 500));
                    } catch (e) {}
                }
                broadcast.sent = true;
                await broadcast.save();
                pushActivity('broadcast', 'Scheduled broadcast delivered', '📢');
            }
        } catch (e) { console.error("Broadcast scheduler:", e); }
    }, 60000);

    // Nightly master scheduler (fires every 5s, acts on specific times)
    setInterval(async () => {
        if (!isConnected) return;
        try {
            const now       = new Date();
            const lagos     = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
            const h         = lagos.getHours();
            const m         = lagos.getMinutes();
            const s         = lagos.getSeconds();
            const today     = getTodayDateGMT1();
            const dayOfWeek = lagos.getDay(); // 0 = Sunday
            
            // Use groups from DB
            const groupsFromDB = await GroupMeta.find({}, 'groupId');
            const groupIds  = groupsFromDB.map(g => g.groupId);

            // ── 23:00 STREAK REMINDER ─────────────────────────────────────────────
            if (h === 23 && m === 0 && s < 10) {
                const yesterday = (() => { const d = new Date(lagos); d.setDate(d.getDate() - 1); return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); })();
                const activeYesterday = new Set(await DailyStats.distinct("userId", { date: yesterday }));
                const activeToday     = new Set(await DailyStats.distinct("userId", { date: today }));
                
                const atRiskUserIds = [...activeYesterday].filter(uid => !activeToday.has(uid));
                const atRiskProfiles = await UserProfile.find({ userId: { $in: atRiskUserIds } });

                for (const profile of atRiskProfiles) {
                    try {
                        const recent = await DailyStats.findOne({ userId: profile.userId }).sort({ timestamp: -1 });
                        if (!recent?.groupId || !groupIds.includes(recent.groupId)) continue;
                        await sock.sendMessage(recent.groupId, {
                            text: `⚠️ *Streak Alert!*\n\n@${profile.userId.split('@')[0]}, your streak is at risk! 🔥\n\nYou have ~1 hour before the day resets.\nType *!log 1* or start a *!sprint* to keep it alive!`,
                            mentions: [profile.userId]
                        });
                        await new Promise(r => setTimeout(r, 1000));
                    } catch (e) {}
                }
            }

            // ── 00:00 FREEZE PROCESSOR ────────────────────────────────────────────
            if (h === 0 && m === 0 && s < 10) {
                const yesterday = (() => { const d = new Date(lagos); d.setDate(d.getDate() - 1); return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); })();
                const allProfiles  = await UserProfile.find({ currentStreak: { $gt: 0 } });
                const activeYest   = new Set(await DailyStats.distinct("userId", { date: yesterday }));

                for (const profile of allProfiles) {
                    if (activeYest.has(profile.userId)) {
                        // Wrote yesterday — check if earned a freeze at this 7-day milestone
                        if (profile.currentStreak % 7 === 0) {
                            const rank      = getRank(profile.totalWordsAllTime);
                            const maxFreezes = getMaxFreezes(rank);
                            if (maxFreezes > 0) {
                                let freeze = await StreakFreeze.findOne({ userId: profile.userId });
                                if (!freeze) freeze = await StreakFreeze.create({ userId: profile.userId, freezesAvailable: 0 });
                                if (freeze.freezesAvailable < maxFreezes) {
                                    freeze.freezesAvailable += 1;
                                    freeze.lastEarnedDate = today;
                                    await freeze.save();
                                    try {
                                        const recent = await DailyStats.findOne({ userId: profile.userId }).sort({ timestamp: -1 });
                                        if (recent?.groupId && groupCache[recent.groupId]) {
                                            await sock.sendMessage(recent.groupId, {
                                                text: `🛡️ *STREAK FREEZE EARNED!*\n\n@${profile.userId.split('@')[0]} hit a *${profile.currentStreak}-day streak milestone!*\nYou now have *${freeze.freezesAvailable}/${maxFreezes}* freeze${freeze.freezesAvailable !== 1 ? 's' : ''}.\n\nUse *!streak freeze* on a missed day to protect your streak.`,
                                                mentions: [profile.userId]
                                            });
                                        }
                                    } catch (e) {}
                                }
                            }
                        }
                    } else {
                        // Missed yesterday — auto-burn a freeze if available
                        const freeze = await StreakFreeze.findOne({ userId: profile.userId });
                        if (freeze && freeze.freezesAvailable > 0) {
                            freeze.freezesAvailable -= 1;
                            await freeze.save();
                            profile.lastActiveDate = yesterday;
                            await profile.save();
                            try {
                                const recent = await DailyStats.findOne({ userId: profile.userId }).sort({ timestamp: -1 });
                                if (recent?.groupId && groupCache[recent.groupId]) {
                                    await sock.sendMessage(recent.groupId, {
                                        text: `🛡️ *FREEZE AUTO-USED!*\n\n@${profile.userId.split('@')[0]}, a freeze protected your *${profile.currentStreak}-day streak!*\n${freeze.freezesAvailable} freeze${freeze.freezesAvailable !== 1 ? 's' : ''} remaining.`,
                                        mentions: [profile.userId]
                                    });
                                }
                            } catch (e) {}
                        }
                    }
                }
            }

            // ── 23:55+ MVP ANNOUNCEMENTS ───────────────────────────────────────────
            if (h === 23 && m >= 55 && lastDailyRunDate !== today) {
                lastDailyRunDate = today; // Prevent duplicate runs

                // Daily MVP
                for (const gid of groupIds) {
                    try {
                        const top = await DailyStats.aggregate([
                            { $match: { groupId: gid, date: today } },
                            { $group: { _id: "$userId", total: { $sum: "$words" }, name: { $first: "$name" } } },
                            { $sort: { total: -1 } }, { $limit: 3 }
                        ]);
                        if (!top.length) continue;
                        let txt = `🌟 *DAILY MVP — ${today}*\n━━━━━━━━━━━━━━━━\n👑 @${top[0]._id.split('@')[0]}: *${top[0].total.toLocaleString()} words*\n`;
                        if (top.length > 1) txt += top.slice(1).map((w, i) => `${i === 0 ? '🥈' : '🥉'} @${w._id.split('@')[0]}: ${w.total.toLocaleString()} words`).join('\n');
                        txt += `\n\nKeep writing! See you tomorrow ✍️`;
                        await sock.sendMessage(gid, { text: txt, mentions: top.map(w => w._id) });
                        const mvpProfile = await UserProfile.findOne({ userId: top[0]._id });
                        if (mvpProfile) await awardBadge(mvpProfile, 'daily_first', gid);
                        await new Promise(r => setTimeout(r, 500));
                    } catch (e) {}
                }

                // Weekly MVP on Sunday
                if (dayOfWeek === 0) {
                    const dates = Array.from({ length: 7 }, (_, i) => { const d = new Date(lagos); d.setDate(d.getDate() - i); return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); });
                    for (const gid of groupIds) {
                        try {
                            const top = await DailyStats.aggregate([
                                { $match: { groupId: gid, date: { $in: dates } } },
                                { $group: { _id: "$userId", total: { $sum: "$words" }, name: { $first: "$name" } } },
                                { $sort: { total: -1 } }, { $limit: 3 }
                            ]);
                            if (!top.length) continue;
                            let txt = `🏆 *WEEKLY MVP*\n━━━━━━━━━━━━━━━━\n👑 @${top[0]._id.split('@')[0]}: *${top[0].total.toLocaleString()} words* this week!\n`;
                            if (top.length > 1) txt += top.slice(1).map((w, i) => `${i === 0 ? '🥈' : '🥉'} @${w._id.split('@')[0]}: ${w.total.toLocaleString()} words`).join('\n');
                            txt += `\n\nOutstanding week! 🚀`;
                            await sock.sendMessage(gid, { text: txt, mentions: top.map(w => w._id) });
                            await new Promise(r => setTimeout(r, 500));
                        } catch (e) {}
                    }
                    // Resolve expired weekly challenges
                    const expired = await WeeklyChallenge.find({ resolved: false, weekEnd: { $lte: new Date(lagos) } });
                    for (const wc of expired) {
                        if (wc.current < wc.target) {
                            const pct = Math.round((wc.current / wc.target) * 100);
                            try {
                                await sock.sendMessage(wc.groupId, {
                                    text: `😤 *WEEKLY BOSS SURVIVED!*\n━━━━━━━━━━━━━━━━\n👹 Boss needed *${wc.target.toLocaleString()}* words.\nYou reached *${wc.current.toLocaleString()}* (${pct}%).\n\nThe boss returns Monday — STRONGER. 💀`
                                });
                            } catch (e) {}
                        }
                        wc.resolved = true;
                        await wc.save();
                    }
                }

                // Monthly MVP on last day
                const tomorrow = new Date(lagos); tomorrow.setDate(tomorrow.getDate() + 1);
                if (tomorrow.getDate() === 1) {
                    const year = lagos.getFullYear(), month = lagos.getMonth();
                    const monthDates = Array.from({ length: lagos.getDate() }, (_, i) => new Date(year, month, i + 1).toLocaleDateString('en-CA', { timeZone: TIMEZONE }));
                    const monthStr   = lagos.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: TIMEZONE });
                    for (const gid of groupIds) {
                        try {
                            const top = await DailyStats.aggregate([
                                { $match: { groupId: gid, date: { $in: monthDates } } },
                                { $group: { _id: "$userId", total: { $sum: "$words" }, name: { $first: "$name" } } },
                                { $sort: { total: -1 } }, { $limit: 3 }
                            ]);
                            if (!top.length) continue;
                            let txt = `🎖️ *MONTHLY MVP — ${monthStr}*\n━━━━━━━━━━━━━━━━\n👑 @${top[0]._id.split('@')[0]}: *${top[0].total.toLocaleString()} words*!\n`;
                            if (top.length > 1) txt += top.slice(1).map((w, i) => `${i === 0 ? '🥈' : '🥉'} @${w._id.split('@')[0]}: ${w.total.toLocaleString()} words`).join('\n');
                            txt += `\nOnward to ${new Date(year, month + 1).toLocaleString('en-US', { month: 'long' })}! 📖`;
                            await sock.sendMessage(gid, { text: txt, mentions: top.map(w => w._id) });
                            await new Promise(r => setTimeout(r, 500));
                        } catch (e) {}
                    }
                }

                // Yearly MVP on Dec 31
                if (lagos.getDate() === 31 && lagos.getMonth() === 11) {
                    const year = lagos.getFullYear();
                    for (const gid of groupIds) {
                        try {
                            const top = await DailyStats.aggregate([
                                { $match: { groupId: gid, timestamp: { $gte: new Date(`${year}-01-01`), $lte: new Date(`${year}-12-31T23:59:59`) } } },
                                { $group: { _id: "$userId", total: { $sum: "$words" }, name: { $first: "$name" } } },
                                { $sort: { total: -1 } }, { $limit: 3 }
                            ]);
                            if (!top.length) continue;
                            let txt = `🎊 *WRITER OF THE YEAR — ${year}*\n━━━━━━━━━━━━━━━━\n👑 @${top[0]._id.split('@')[0]}: *${top[0].total.toLocaleString()} words*!\n`;
                            if (top.length > 1) txt += top.slice(1).map((w, i) => `${i === 0 ? '🥈' : '🥉'} @${w._id.split('@')[0]}: ${w.total.toLocaleString()} words`).join('\n');
                            txt += `\nSee you in ${year + 1}! 🥂✍️`;
                            await sock.sendMessage(gid, { text: txt, mentions: top.map(w => w._id) });
                            await new Promise(r => setTimeout(r, 500));
                        } catch (e) {}
                    }
                }
            }

            // ── Monday 00:01 — Spawn weekly challenge ─────────────────────────────
            if (h === 0 && m === 1 && s < 10 && dayOfWeek === 1) {
                for (const gid of groupIds) {
                    try {
                        const existing = await WeeklyChallenge.findOne({ groupId: gid, resolved: false });
                        if (existing) continue;
                        const lastWeekAgo = new Date(lagos); lastWeekAgo.setDate(lastWeekAgo.getDate() - 7);
                        const lastStat    = await DailyStats.aggregate([{ $match: { groupId: gid, timestamp: { $gte: lastWeekAgo } } }, { $group: { _id: null, total: { $sum: "$words" } } }]);
                        const target      = Math.max(1000, Math.round((lastStat[0]?.total || 0) * 1.1));
                        const weekEnd     = new Date(lagos); weekEnd.setDate(weekEnd.getDate() + 7);
                        await WeeklyChallenge.create({ groupId: gid, target, current: 0, contributors: {}, weekStart: new Date(lagos), weekEnd });
                        await sock.sendMessage(gid, {
                            text: `⚔️ *WEEKLY BOSS SPAWNED!* ⚔️\n━━━━━━━━━━━━━━━━\n👹 This week's target: *${target.toLocaleString()} words*\n📅 You have 7 days to defeat it!\n\nEvery *!log* and sprint counts. Let's go! 🔥`
                        });
                    } catch (e) {}
                }
            }

            // Auto weekly report DMs removed to prevent account restriction.

        } catch (e) { console.error("Nightly scheduler error:", e); }
    }, 5000);

    // =======================
    //   BAILEYS INIT
    // =======================
    const { state, saveCreds } = await useMultiFileAuthState('.auth_info_baileys');

    const initializeBot = async () => {
        const { version } = await fetchLatestBaileysVersion();
        sock = makeWASocket({
            version, auth: state, printQRInTerminal: true,
            browser: ['Sprint Bot', 'Chrome', '120.0'],
            msgRetryCounterMax: 15, defaultQueryTimeoutMs: 60000,
            shouldIgnoreJid: jid => !jid || jid === 'status@broadcast' || jid.includes('broadcast'),
            syncFullHistory: false, generateHighQualityLinkPreview: true,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { qrCodeData = qr; console.log('⚠️ New QR Code'); }
            if (connection === 'open') {
                isConnected = true; qrCodeData = null;
                updateGroupCache(true);
                console.log('✅ Bot Connected!');
                pushActivity('connect', 'Bot connected to WhatsApp', '✅');
            } else if (connection === 'close') {
                isConnected = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    console.log("🛑 Logged out. Delete .auth_info_baileys and restart.");
                } else {
                    console.log('🔄 Reconnecting...'); setTimeout(() => initializeBot(), 3000);
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
                        text: `👋 *Hey writers! Sprint Bot just joined the room!*\n\nI help you track writing sprints, word counts, streaks, and group challenges. Here's how to get started:\n\n📖 *!help* — Full command list\n✍️ *!log 500* — Log your words right now\n🏃 *!sprint 20* — Start a 20-minute sprint\n📊 *!wc 500* — Submit your word count during a sprint\n🎯 *!goal set 1000* — Set a personal writing target\n\nLet's write! 🚀`
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
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const msg = m.messages[0];
                if (!msg.message || msg.key.fromMe) return;

                const chatId   = msg.key.remoteJid;
                const isGroup  = chatId.endsWith('@g.us');
                const senderId = msg.key.participant || msg.key.remoteJid;

                // Silently ignore ALL private/DM messages — bot never responds to DMs
                if (!isGroup) return;

                if (await Blacklist.exists({ userId: senderId })) return;

                // Rate limit
                if (!checkRateLimit(senderId)) return;

                const isOwner = senderId.includes(OWNER_NUMBER);

                const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                if (!body.startsWith("!")) return;

                if (maintenanceMode && !isOwner) {
                    await sock.sendMessage(chatId, { text: "⚠️ Bot is in Maintenance Mode. Check back soon!" }, { quoted: msg });
                    return;
                }

                let senderName = senderId.split('@')[0];
                if (msg.pushName) senderName = msg.pushName;
                const savedProfile = await DailyStats.findOne({ userId: senderId }).sort({ timestamp: -1 });
                if (savedProfile?.name) senderName = savedProfile.name;

                const args    = body.trim().split(" ");
                const command = args[0].toLowerCase();
                const todayStr = getTodayDateGMT1();

                const getTargetId = (idx = 1) => {
                    const n = args[idx]?.replace(/\D/g, '');
                    return (n && n.length > 5) ? n + '@c.us' : null;
                };

                // ── OWNER COMMANDS ──────────────────────────────────────────────────
                if (isOwner) {
                    if (command === "!broadcast") {
                        const message = args.slice(1).join(" ");
                        if (!message) return sock.sendMessage(chatId, { text: "❌ Empty." }, { quoted: msg });
                        const gs = await sock.groupFetchAllParticipating();
                        let count = 0;
                        for (const gid of Object.keys(gs)) {
                            try { await sock.sendMessage(gid, { text: message }); count++; } catch(e) {}
                            await new Promise(r => setTimeout(r, 300));
                        }
                        return sock.sendMessage(chatId, { text: `✅ Sent to ${count} groups.` }, { quoted: msg });
                    }
                    if (command === "!ban") {
                        const t = getTargetId(1);
                        if (!t) return sock.sendMessage(chatId, { text: "❌ Tag user." }, { quoted: msg });
                        await Blacklist.create({ userId: t });
                        return sock.sendMessage(chatId, { text: `🚫 Banned.` }, { quoted: msg });
                    }
                    if (command === "!unban") {
                        const t = getTargetId(1);
                        if (!t) return sock.sendMessage(chatId, { text: "❌ Tag user." }, { quoted: msg });
                        await Blacklist.deleteMany({ userId: t });
                        return sock.sendMessage(chatId, { text: `✅ Unbanned.` }, { quoted: msg });
                    }
                    if (command === "!leave") {
                        await sock.sendMessage(chatId, { text: "👋 Bye!" });
                        await sock.groupLeave(chatId);
                        return;
                    }
                }

                // ── HELP ────────────────────────────────────────────────────────────
                if (command === "!help") {
                    return sock.sendMessage(chatId, { text:
`🤖 *SPRINT BOT COMMANDS*
━━━━━━━━━━━━━━━━━━

🍅 *Sprinting & Focus*
*!sprint 20* → Start 20 min sprint
*!pomo 25 5 4* → Pomodoro (Sprint/Break/Rounds)
*!wc 500* → Log words during sprint
*!time* → Check time remaining
*!finish* → End sprint & view results
*!cancel* → Stop current timer

⚔️ *Duels & Challenges*
*!duel @user 15* → 1v1 word battle (15 min)
*!challenge 5000* → Group boss battle
*!challenge check* → View boss HP
*!challenge stop* → Cancel manual challenge

📊 *Stats & Profile*
*!profile* → Your full stats
*!wpm* → Sprint speed history
*!daily* → Today's Leaderboard
*!weekly* → Last 7 days
*!monthly* → Last 30 days
*!top10* → All-Time Hall of Fame
*!myname Sam* → Set display name

🔥 *Streaks*
*!streak status* → Streak & freeze info
*!streak freeze* → Manually use a freeze

🎯 *Goals*
*!goal set 1000* → Set daily target
*!goal check* → View progress
*!goal history* → Past records

⚙️ *Utils*
*!log 500* → Add words manually
*!feedback [msg]* → Send a suggestion
*!schedule 20 in 60* → Plan a sprint
*!unschedule* → Cancel plans`
                    }, { quoted: msg });
                }

                // ── !LOG ────────────────────────────────────────────────────────────
                if (command === "!log") {
                    const count = parseInt(args[1]);
                    if (isNaN(count) || count <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!log 500`" }, { quoted: msg });
                    try {
                        await DailyStats.findOneAndUpdate(
                            { userId: senderId, groupId: chatId, date: todayStr },
                            { name: senderName, $inc: { words: count }, timestamp: new Date() },
                            { upsert: true, new: true }
                        );

                        // Goal with milestones
                        const goal = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                        if (goal) {
                            const prevPct = (goal.current / goal.target) * 100;
                            goal.current += count;
                            const newPct  = (goal.current / goal.target) * 100;
                            if (goal.current >= goal.target) {
                                goal.isActive = false; goal.completedAt = new Date();
                                await goal.save();
                                await sock.sendMessage(chatId, {
                                    text: `🎉 *GOAL ACHIEVED!* 🏆\n\n@${senderId.split('@')[0]} smashed *${goal.target.toLocaleString()} words*!\n⏱️ Completed in: ${getDurationString(goal.startedAt)}\n\nSet a new one with *!goal set [number]* 🎯`,
                                    mentions: [senderId]
                                });
                            } else {
                                await goal.save();
                                for (const mile of [25, 50, 75]) {
                                    if (prevPct < mile && newPct >= mile) {
                                        const e = { 25: '🌱', 50: '🔥', 75: '⚡' };
                                        await sock.sendMessage(chatId, {
                                            text: `${e[mile]} *${mile}% MILESTONE!*\n\n@${senderId.split('@')[0]} is ${mile}% of their goal!\n${goal.current.toLocaleString()} / ${goal.target.toLocaleString()} words 💪`,
                                            mentions: [senderId]
                                        });
                                    }
                                }
                            }
                        }

                        // Streak + badges
                        const { profile, rankUp, isNovelGod } = await updateStreak(senderId, senderName, count);
                        await checkAndAwardBadges(profile, chatId);
                        const streakIcon = profile.currentStreak > 2 ? `🔥 ${profile.currentStreak}` : `${profile.currentStreak}`;

                        // Both challenges
                        const cr = await updateChallenge(chatId, senderId, senderName, count);
                        const wr = await updateWeeklyChallenge(chatId, senderId, senderName, count);

                        let responseText = `✅ Logged *${count.toLocaleString()}* words.\n📈 Streak: ${streakIcon} days`;
                        if (rankUp && !isNovelGod) responseText += `\n\n🎓 *RANK UP!* You are now *${rankUp}*!`;

                        if (isNovelGod) {
                            responseText += `\n\n⚡ *1,000,000 WORDS! NOVEL GOD!*`;
                            try {
                                const allGs = await sock.groupFetchAllParticipating();
                                for (const gid of Object.keys(allGs)) {
                                    try {
                                        await sock.sendMessage(gid, { text: `🌍 *WORLDWIDE ANNOUNCEMENT* 🌍\n━━━━━━━━━━━━━━━━\n⚡ *${senderName}* just crossed *1,000,000 words* — *Novel God ⚡*!\n\nCongratulations @${senderId.split('@')[0]}! 🎉`, mentions: [senderId] });
                                    } catch (e) {}
                                    await new Promise(r => setTimeout(r, 500));
                                }
                            } catch (e) {}
                        }

                        if (cr?.completed) {
                            await sock.sendMessage(chatId, { text: cr.text, mentions: cr.mentions });
                            const mvp = await UserProfile.findOne({ userId: cr.mvpUserId });
                            if (mvp) await awardBadge(mvp, 'challenge_mvp', chatId);
                        }
                        if (wr?.completed) await sock.sendMessage(chatId, { text: wr.text, mentions: wr.mentions });

                        await sock.sendMessage(chatId, { text: responseText, mentions: rankUp ? [senderId] : [] }, { quoted: msg });
                        pushActivity('log', `${senderName} logged ${count.toLocaleString()} words`, '✍️');
                    } catch (e) { console.error(e); }
                }

                // ── !WPM ────────────────────────────────────────────────────────────
                if (command === "!wpm") {
                    try {
                        const profile = await UserProfile.findOne({ userId: senderId });
                        if (!profile || !profile.sprintCount) {
                            return sock.sendMessage(chatId, { text: "❌ No sprint data yet. Complete a sprint with *!finish* to track WPM." }, { quoted: msg });
                        }
                        const recent = await SprintRecord.find({ 'participants.userId': senderId }).sort({ timestamp: -1 }).limit(5);
                        let txt = `⚡ *WPM STATS — ${senderName}*\n━━━━━━━━━━━━━━━━\n`;
                        txt += `🏅 Best: *${profile.bestSprintWpm} WPM* (${profile.bestSprintWords.toLocaleString()} words)\n`;
                        txt += `📊 Sprints Completed: ${profile.sprintCount}\n`;
                        if (recent.length) {
                            txt += `\n*Last ${recent.length} Sprint${recent.length !== 1 ? 's' : ''}:*\n`;
                            recent.forEach((sr, i) => {
                                const p = sr.participants.find(x => x.userId === senderId);
                                if (p) txt += `${i + 1}. ${p.words.toLocaleString()} words @ *${p.wpm} WPM* (${sr.duration}min)\n`;
                            });
                        }
                        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
                    } catch (e) { console.error(e); }
                }

                // ── !STREAK ─────────────────────────────────────────────────────────
                if (command === "!streak") {
                    const sub = args[1]?.toLowerCase();

                    if (sub === "status") {
                        const profile  = await UserProfile.findOne({ userId: senderId });
                        const freeze   = await StreakFreeze.findOne({ userId: senderId });
                        const rank     = getRank(profile?.totalWordsAllTime || 0);
                        const maxFr    = getMaxFreezes(rank);
                        const avail    = freeze?.freezesAvailable || 0;
                        const nextIn   = profile?.currentStreak ? 7 - (profile.currentStreak % 7) : 7;
                        let txt = `🔥 *STREAK STATUS — ${senderName}*\n━━━━━━━━━━━━━━━━\n`;
                        txt += `📅 Current Streak: *${profile?.currentStreak || 0} days*\n`;
                        txt += `🏆 Best Streak: ${profile?.bestStreak || 0} days\n\n`;
                        txt += `🛡️ *Freezes:* ${avail} / ${maxFr}\n`;
                        if (maxFr === 0) txt += `_(Rank up to *Aspiring Author ✍️* to earn freezes)_`;
                        else if (avail < maxFr) txt += `_(Next freeze in *${nextIn} writing day${nextIn !== 1 ? 's' : ''}*)_`;
                        else txt += `_(Freeze cap reached for your rank)_`;
                        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
                    }

                    if (sub === "freeze") {
                        const profile = await UserProfile.findOne({ userId: senderId });
                        const rank    = getRank(profile?.totalWordsAllTime || 0);
                        const maxFr   = getMaxFreezes(rank);
                        if (maxFr === 0) return sock.sendMessage(chatId, { text: "❌ Rank up to *Aspiring Author ✍️* to earn streak freezes." }, { quoted: msg });
                        const freeze = await StreakFreeze.findOne({ userId: senderId });
                        if (!freeze || freeze.freezesAvailable <= 0) return sock.sendMessage(chatId, { text: "❌ No freezes available. Keep your streak going to earn one every 7 days!" }, { quoted: msg });
                        freeze.freezesAvailable -= 1;
                        await freeze.save();
                        if (profile) { profile.lastActiveDate = todayStr; await profile.save(); }
                        return sock.sendMessage(chatId, {
                            text: `🛡️ *FREEZE USED!*\n\nYour streak is protected for today, @${senderId.split('@')[0]}!\n${freeze.freezesAvailable} freeze${freeze.freezesAvailable !== 1 ? 's' : ''} remaining.`,
                            mentions: [senderId]
                        }, { quoted: msg });
                    }

                    return sock.sendMessage(chatId, { text: `Use *!streak status* or *!streak freeze*` }, { quoted: msg });
                }

                // ── !DUEL ───────────────────────────────────────────────────────────
                if (command === "!duel") {
                    const mentioned  = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
                    const opponentId = mentioned?.[0] || getTargetId(1);
                    const duration   = parseInt(args[2]) || parseInt(args[1]) || 15;

                    if (!opponentId)             return sock.sendMessage(chatId, { text: "❌ Tag your opponent: `!duel @user 15`" }, { quoted: msg });
                    if (opponentId === senderId) return sock.sendMessage(chatId, { text: "❌ You can't duel yourself!" }, { quoted: msg });
                    if (activeDuels[chatId])     return sock.sendMessage(chatId, { text: "⚠️ A duel is already active here!" }, { quoted: msg });
                    if (activeSprints[chatId])   return sock.sendMessage(chatId, { text: "⚠️ Can't start a duel during a sprint." }, { quoted: msg });
                    if (duration < 5 || duration > 60) return sock.sendMessage(chatId, { text: "❌ Duration must be 5–60 minutes." }, { quoted: msg });

                    const endsAt = Date.now() + duration * 60000;
                    activeDuels[chatId] = {
                        challenger: senderId, opponent: opponentId, duration, endsAt,
                        words: { [senderId]: 0, [opponentId]: 0 },
                        challengerName: senderName, opponentName: opponentId.split('@')[0],
                        isGracePeriod: false
                    };

                    await sock.sendMessage(chatId, {
                        text: `⚔️ *WORD DUEL!* ⚔️\n━━━━━━━━━━━━━━━━\n🔴 @${senderId.split('@')[0]} vs 🔵 @${opponentId.split('@')[0]}\n⏱️ Duration: *${duration} minutes*\n\nUse *!wc [number]* to log words!\nMay the best writer win! 📝`,
                        mentions: [senderId, opponentId]
                    });

                    setTimeout(async () => {
                        const duel = activeDuels[chatId];
                        if (!duel) return; // Might have been cancelled
                        
                        // Enter Grace Period
                        duel.isGracePeriod = true;
                        duel.endsAt = Date.now() + (2 * 60000); // Add 2 minutes to the clock for logging

                        await sock.sendMessage(chatId, { 
                            text: `🛑 *DUEL TIME'S UP!*\n\n@${duel.challenger.split('@')[0]} and @${duel.opponent.split('@')[0]}, put your pens down!\n\nYou have *2 minutes* to submit your final words using *!wc [number]*!`, 
                            mentions: [duel.challenger, duel.opponent] 
                        });

                        // Final resolution timer
                        setTimeout(async () => {
                            const finalDuel = activeDuels[chatId];
                            if (!finalDuel) return;
                            delete activeDuels[chatId];

                            const cW = finalDuel.words[finalDuel.challenger] || 0;
                            const oW = finalDuel.words[finalDuel.opponent]   || 0;
                            const draw     = cW === oW;
                            const winnerId = cW > oW ? finalDuel.challenger : finalDuel.opponent;
                            const loserId  = cW > oW ? finalDuel.opponent   : finalDuel.challenger;

                            let txt = `⚔️ *DUEL OVER!* ⚔️\n━━━━━━━━━━━━━━━━\n`;
                            if (draw) {
                                txt += `🤝 *IT'S A DRAW!*\nBoth: *${cW.toLocaleString()} words*\n\nHonour among wordsmiths! 🙏`;
                            } else {
                                txt += `🏆 *WINNER:* @${winnerId.split('@')[0]} — *${Math.max(cW, oW).toLocaleString()} words*\n💀 *LOSER:* @${loserId.split('@')[0]} — ${Math.min(cW, oW).toLocaleString()} words\n\nBetter luck next time! 😤`;
                                try {
                                    const winProf = await UserProfile.findOne({ userId: winnerId });
                                    if (winProf) await awardBadge(winProf, 'duel_win', chatId);
                                } catch (e) {}
                            }

                            // Log words to daily stats for both
                            for (const [uid, words] of Object.entries(finalDuel.words)) {
                                if (words > 0) {
                                    const name = uid === finalDuel.challenger ? finalDuel.challengerName : finalDuel.opponentName;
                                    await DailyStats.findOneAndUpdate({ userId: uid, groupId: chatId, date: todayStr }, { name, $inc: { words }, timestamp: new Date() }, { upsert: true });
                                    await updateStreak(uid, name, words);
                                }
                            }

                            await sock.sendMessage(chatId, { text: txt, mentions: [finalDuel.challenger, finalDuel.opponent] });
                            pushActivity('duel', `Duel ended in ${groupCache[chatId]?.subject || chatId}`, '⚔️');
                        }, 2 * 60000); // 2 minutes later
                        
                    }, duration * 60000);
                }

                // ── !WC ─────────────────────────────────────────────────────────────
                if (command === "!wc") {
                    const duel   = activeDuels[chatId];
                    const sprint = activeSprints[chatId];

                    if (!sprint && !duel) return sock.sendMessage(chatId, { text: "❌ *No Active Sprint or Duel*\n\nStart one with `!sprint 20` or `!duel @user 15`\nOr log manually: `!log 500`" }, { quoted: msg });

                    const isAdd  = args[1] === 'add' || args[1] === '+';
                    const rawNum = isAdd ? args[2] : args[1];
                    const c      = parseInt(rawNum);
                    if (isNaN(c) || c <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!wc 500`" }, { quoted: msg });

                    if (duel && !sprint) {
                        if (senderId !== duel.challenger && senderId !== duel.opponent) {
                            return sock.sendMessage(chatId, { text: "❌ Only duel participants can log here." }, { quoted: msg });
                        }
                        if (isAdd) duel.words[senderId] = (duel.words[senderId] || 0) + c;
                        else duel.words[senderId] = c;
                        const left = Math.ceil((duel.endsAt - Date.now()) / 60000);
                        return sock.sendMessage(chatId, { text: `✅ Duel: *${duel.words[senderId].toLocaleString()} words* | ${left}m left` }, { quoted: msg });
                    }

                    if (!sprint.participants[senderId]) sprint.participants[senderId] = { name: senderName, words: 0 };
                    if (isAdd) { sprint.participants[senderId].words += c; await sock.sendMessage(chatId, { text: `➕ Added. Total: ${sprint.participants[senderId].words.toLocaleString()}` }, { quoted: msg }); }
                    else { sprint.participants[senderId].words = c; await sock.sendMessage(chatId, { text: `✅` }, { quoted: msg }); }
                    await ActiveSprint.updateOne({ groupId: chatId }, { $set: { participants: sprint.participants } });
                }

                // ── !FINISH ─────────────────────────────────────────────────────────
                if (command === "!finish") {
                    if (!activeSprints[chatId]) return sock.sendMessage(chatId, { text: "❌ No active sprint." }, { quoted: msg });
                    const result = await finishSprint(chatId, todayStr);
                    if (result && activePomodoros[chatId]) {
                        const pomo = activePomodoros[chatId];
                        pomo.roundsLeft     -= 1;
                        pomo.lastParticipants = result.participants.map(p => p.uid);
                        if (pomo.roundsLeft <= 0) {
                            delete activePomodoros[chatId];
                            await sock.sendMessage(chatId, { text: `🍅 *POMODORO COMPLETE!*\n\nYou survived ${pomo.totalRounds} rounds. Amazing focus! 🔥` });
                        } else {
                            const round = pomo.totalRounds - pomo.roundsLeft + 1;
                            await sock.sendMessage(chatId, { text: `☕ *Break Time!* ${pomo.breakTime} minutes.\nRound ${round}/${pomo.totalRounds} starts after.` });
                            setTimeout(async () => {
                                if (activePomodoros[chatId]) {
                                    await sock.sendMessage(chatId, {
                                        text: `🍅 *Break Over!* Round ${round}/${pomo.totalRounds} starting NOW! ${pomo.lastParticipants.map(id => '@' + id.split('@')[0]).join(' ')}`,
                                        mentions: pomo.lastParticipants
                                    });
                                    await startSprintSession(chatId, pomo.sprintTime);
                                }
                            }, pomo.breakTime * 60000);
                        }
                    }
                }

                // ── !TOP10 ──────────────────────────────────────────────────────────
                if (command === "!top10" || command === "!top") {
                    const top = await DailyStats.aggregate([
                        { $group: { _id: "$name", total: { $sum: "$words" } } },
                        { $sort: { total: -1 } }, { $limit: 10 }
                    ]);
                    if (!top.length) return sock.sendMessage(chatId, { text: "📉 No data." }, { quoted: msg });
                    let txt = `🌎 *ALL-TIME HALL OF FAME*\n\n`;
                    top.forEach((w, i) => { txt += `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🎖️'} ${w._id}: ${w.total.toLocaleString()} words\n`; });
                    await sock.sendMessage(chatId, { text: txt });
                }

                // ── !MYNAME ─────────────────────────────────────────────────────────
                if (command === "!myname") {
                    const n = args.slice(1).join(" ");
                    if (!n) return sock.sendMessage(chatId, { text: "❌ Use: `!myname Sam`" }, { quoted: msg });
                    await DailyStats.updateMany({ userId: senderId }, { name: n });
                    await PersonalGoal.updateMany({ userId: senderId }, { name: n });
                    return sock.sendMessage(chatId, { text: `✅ Name updated to: *${n}*` }, { quoted: msg });
                }

                // ── !PROFILE ────────────────────────────────────────────────────────
                if (command === "!profile") {
                    const histAgg = await DailyStats.aggregate([{ $match: { userId: senderId } }, { $group: { _id: null, total: { $sum: "$words" } } }]);
                    const trueTotal = histAgg[0]?.total || 0;
                    let profile = await UserProfile.findOne({ userId: senderId });
                    if (!profile) profile = await UserProfile.create({ userId: senderId, name: senderName, currentStreak: 0, bestStreak: 0, lastActiveDate: "", totalWordsAllTime: trueTotal });
                    else if (profile.totalWordsAllTime < trueTotal) { profile.totalWordsAllTime = trueTotal; await profile.save(); }

                    const todayAgg   = await DailyStats.aggregate([{ $match: { userId: senderId, date: todayStr } }, { $group: { _id: null, total: { $sum: "$words" } } }]);
                    const dailyWords = todayAgg[0]?.total || 0;
                    const goal       = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                    const freeze     = await StreakFreeze.findOne({ userId: senderId });
                    const rank       = getRank(profile.totalWordsAllTime);
                    const nextRank   = getNextRank(profile.totalWordsAllTime);
                    const profileLink = `${BASE_URL}/profile/${senderId.split('@')[0]}`;

                    let txt = `👤 *WRITER PROFILE*\n━━━━━━━━━━━━━━\n📛 *${profile.name}*\n🎖️ Rank: ${rank}\n`;
                    if (nextRank) {
                        const pct = Math.min(100, (profile.totalWordsAllTime / nextRank.threshold) * 100).toFixed(1);
                        txt += `📈 Next: ${nextRank.name} (${pct}%)\n`;
                    }
                    txt += `\n🔥 Streak: *${profile.currentStreak} days*\n`;
                    txt += `🏆 Best: ${profile.bestStreak} days\n`;
                    txt += `🛡️ Freezes: ${freeze?.freezesAvailable || 0}\n`;
                    txt += `📅 Today: *${dailyWords.toLocaleString()}* words\n`;
                    txt += `📚 All-Time: ${profile.totalWordsAllTime.toLocaleString()} words\n`;
                    if (profile.bestSprintWords > 0) txt += `⚡ Best Sprint: ${profile.bestSprintWords.toLocaleString()} words @ ${profile.bestSprintWpm} WPM\n`;
                    if (profile.badges?.length) {
                        const icons = profile.badges.map(b => BADGE_DEFS.find(d => d.key === b)?.icon || '🏅').join(' ');
                        txt += `🏅 Badges: ${icons}\n`;
                    }
                    txt += `\n🔗 *Card:* ${profileLink}`;

                    if (goal) {
                        const pct = Math.min(100, Math.max(0, (goal.current / goal.target) * 100));
                        const bar = "🟩".repeat(Math.round(pct / 10)) + "⬜".repeat(10 - Math.round(pct / 10));
                        txt += `\n\n🎯 *Goal:* \`${goal.current.toLocaleString()} / ${goal.target.toLocaleString()}\` (${pct.toFixed(1)}%)\n${bar}`;
                    }
                    return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
                }

                // ── !CHALLENGE ──────────────────────────────────────────────────────
                if (command === "!challenge") {
                    const sub    = args[1];
                    const active = await GroupChallenge.findOne({ groupId: chatId });
                    const weekly = await WeeklyChallenge.findOne({ groupId: chatId, resolved: false, weekEnd: { $gte: new Date() } });

                    if (sub === "status" || sub === "check") {
                        if (!active && !weekly) return sock.sendMessage(chatId, { text: "💤 No active challenges. Start one with `!challenge 5000`" }, { quoted: msg });
                        let txt = '';
                        if (active) {
                            const pct = ((active.current / active.target) * 100).toFixed(1);
                            const bar = "🟩".repeat(Math.round(pct / 10)) + "⬜".repeat(10 - Math.round(pct / 10));
                            txt += `⚔️ *Manual Boss*\n🎯 ${active.target.toLocaleString()} | 📊 ${active.current.toLocaleString()} (${pct}%)\n${bar}\n⏱️ Running ${getDurationString(active.startedAt)}\n\n`;
                        }
                        if (weekly) {
                            const pct      = ((weekly.current / weekly.target) * 100).toFixed(1);
                            const bar      = "🟩".repeat(Math.round(pct / 10)) + "⬜".repeat(10 - Math.round(pct / 10));
                            const daysLeft = Math.ceil((new Date(weekly.weekEnd) - new Date()) / 86400000);
                            txt += `📅 *Weekly Boss*\n🎯 ${weekly.target.toLocaleString()} | 📊 ${weekly.current.toLocaleString()} (${pct}%)\n${bar}\n⏳ ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`;
                        }
                        return sock.sendMessage(chatId, { text: txt.trim() }, { quoted: msg });
                    }
                    if (sub === "stop" || sub === "cancel") {
                        if (!active) return sock.sendMessage(chatId, { text: "❌ No manual challenge active." }, { quoted: msg });
                        await GroupChallenge.deleteOne({ groupId: chatId });
                        return sock.sendMessage(chatId, { text: "🚫 Manual challenge cancelled." }, { quoted: msg });
                    }
                    const target = parseInt(sub);
                    if (isNaN(target) || target <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!challenge 5000`" }, { quoted: msg });
                    if (active) return sock.sendMessage(chatId, { text: `⚠️ Challenge active (${active.current.toLocaleString()}/${active.target.toLocaleString()}). Use \`!challenge stop\` first.` }, { quoted: msg });
                    await GroupChallenge.create({ groupId: chatId, target, current: 0, contributors: {}, createdBy: senderId });
                    return sock.sendMessage(chatId, {
                        text: `⚔️ *NEW CHALLENGE STARTED!* ⚔️\n\n🎯 Target: *${target.toLocaleString()} words*\n\nEvery \`!log\` and sprint counts. Let's go! 🔥${weekly ? `\n\n_(Weekly Boss also running: ${weekly.current.toLocaleString()}/${weekly.target.toLocaleString()})_` : ''}`
                    }, { quoted: msg });
                }

                // ── !DAILY / !WEEKLY / !MONTHLY ─────────────────────────────────────
                if (["!daily", "!weekly", "!monthly"].includes(command)) {
                    const isDaily = command === "!daily";
                    const days  = isDaily ? 1 : command === "!weekly" ? 7 : 30;
                    const title = isDaily ? `Daily (${todayStr})` : command === "!weekly" ? "Weekly (7 days)" : "Monthly (30 days)";
                    let stats;
                    if (isDaily) {
                        stats = await DailyStats.aggregate([
                            { $match: { date: todayStr } },
                            { $group: { _id: "$userId", totalWords: { $sum: "$words" }, name: { $first: "$name" } } },
                            { $sort: { totalWords: -1 } }, { $limit: 15 }
                        ]);
                    } else {
                        const dt = new Date(); dt.setDate(dt.getDate() - days);
                        stats = await DailyStats.aggregate([
                            { $match: { timestamp: { $gte: dt } } },
                            { $group: { _id: "$userId", totalWords: { $sum: "$words" }, name: { $first: "$name" } } },
                            { $sort: { totalWords: -1 } }, { $limit: 15 }
                        ]);
                    }
                    if (!stats.length) return sock.sendMessage(chatId, { text: "📉 No stats yet." }, { quoted: msg });
                    let txt = `🏆 *${title}*\n\n`;
                    for (let i = 0; i < stats.length; i++) {
                        const s = stats[i];
                        const p = await UserProfile.findOne({ userId: s._id });
                        const fire = (p && p.currentStreak > 2) ? `🔥${toSuperscript(p.currentStreak)}` : "";
                        txt += `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🎖️'} ${s.name} ${fire}: ${s.totalWords.toLocaleString()} words\n`;
                    }
                    await sock.sendMessage(chatId, { text: txt });
                }

                // ── !GOAL ────────────────────────────────────────────────────────────
                if (command === "!goal") {
                    const sub = args[1]?.toLowerCase();
                    if (sub === "set") {
                        const t = parseInt(args[2]);
                        if (isNaN(t)) return sock.sendMessage(chatId, { text: "❌ Use: `!goal set 5000`" }, { quoted: msg });
                        await PersonalGoal.updateMany({ userId: senderId }, { isActive: false });
                        await PersonalGoal.create({ userId: senderId, name: senderName, target: t, current: 0 });
                        return sock.sendMessage(chatId, { text: `🎯 Goal set: *${t.toLocaleString()} words*\nYou've got this! 💪` }, { quoted: msg });
                    }
                    if (sub === "history") {
                        const history = await PersonalGoal.find({ userId: senderId, isActive: false }).sort({ _id: -1 }).limit(5);
                        if (!history.length) return sock.sendMessage(chatId, { text: "📜 No past goals." }, { quoted: msg });
                        let txt = `📜 *GOAL HISTORY*\n━━━━━━━━━━━━━━\n`;
                        history.forEach(g => {
                            const pct = Math.min(100, (g.current / g.target) * 100).toFixed(1);
                            const win = g.current >= g.target;
                            const dur = g.completedAt ? getDurationString(g.startedAt, g.completedAt) : null;
                            txt += `\n${win ? '✅' : '❌'} ${g.startDate} | ${g.target.toLocaleString()} words\n   ${g.current.toLocaleString()} (${pct}%)${win && dur ? ` — ${dur}` : ''}\n`;
                        });
                        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
                    }
                    const g = await PersonalGoal.findOne({ userId: senderId, isActive: true });
                    if (!g) return sock.sendMessage(chatId, { text: "❌ No active goal. Use `!goal set [number]`" }, { quoted: msg });
                    const rawPct = (g.current / g.target) * 100;
                    const pct    = Math.min(100, Math.max(0, rawPct));
                    const bar    = "🟩".repeat(Math.round(pct / 10)) + "⬜".repeat(10 - Math.round(pct / 10));
                    return sock.sendMessage(chatId, {
                        text: `🎯 *Goal Progress*\n👤 ${g.name}\n\`${g.current.toLocaleString()} / ${g.target.toLocaleString()}\`\n${bar} (${rawPct.toFixed(1)}%)\n📅 Started: ${g.startDate}\n⏱️ Running for: ${getDurationString(g.startedAt)}`
                    }, { quoted: msg });
                }

                // ── !REPORT ─────────────────────────────────────────────────────────
                if (command === "!report") {
                    try {
                        const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                        const [weekStats, profile, freeze] = await Promise.all([
                            DailyStats.aggregate([{ $match: { userId: senderId, timestamp: { $gte: sevenDaysAgo } } }, { $group: { _id: null, total: { $sum: "$words" }, days: { $addToSet: "$date" } } }]),
                            UserProfile.findOne({ userId: senderId }),
                            StreakFreeze.findOne({ userId: senderId })
                        ]);
                        const thisWeek   = weekStats[0]?.total || 0;
                        const activeDays = weekStats[0]?.days?.length || 0;
                        const rank       = getRank(profile?.totalWordsAllTime || 0);
                        const txt = `📊 *YOUR WEEKLY REPORT*\n━━━━━━━━━━━━━━━━\n👤 ${senderName} | ${rank}\n\n📝 This Week: *${thisWeek.toLocaleString()} words*\n📅 Active Days: ${activeDays}/7\n🔥 Streak: *${profile?.currentStreak || 0} days*\n🏅 Best: ${profile?.bestStreak || 0} days\n🛡️ Freezes: ${freeze?.freezesAvailable || 0}\n📚 All-Time: ${profile?.totalWordsAllTime?.toLocaleString() || 0} words\n${profile?.bestSprintWords > 0 ? `⚡ Best Sprint: ${profile.bestSprintWords.toLocaleString()} words @ ${profile.bestSprintWpm} WPM\n` : ''}`;
                        try {
                            const dmJid = senderId.includes('@s.whatsapp.net') ? senderId : senderId.replace('@lid', '@s.whatsapp.net');
                            await sock.sendMessage(dmJid, { text: txt });
                            await sock.sendMessage(chatId, { text: `📬 Report sent to your DM, @${senderId.split('@')[0]}!`, mentions: [senderId] }, { quoted: msg });
                        } catch (e) {
                            await sock.sendMessage(chatId, { text: `⚠️ Couldn't send to your DM (you may need to send me a private message first).\n\n${txt}` }, { quoted: msg });
                        }
                    } catch (e) { console.error(e); }
                }

                // ── !FEEDBACK ───────────────────────────────────────────────────────
                if (command === "!feedback") {
                    const message = args.slice(1).join(" ");
                    if (!message) return sock.sendMessage(chatId, { text: "❌ Use: `!feedback [your message]`\nExample: `!feedback Add a group leaderboard`" }, { quoted: msg });
                    await Feedback.create({ userId: senderId, name: senderName, groupId: chatId, message });
                    return sock.sendMessage(chatId, { text: `💌 *Feedback received!* Thanks ${senderName}, the admin will review it 👀` }, { quoted: msg });
                }

                // ── !SPRINT ─────────────────────────────────────────────────────────
                if (command === "!sprint") {
                    const mins = parseInt(args[1]);
                    if (isNaN(mins) || mins <= 0 || mins > 180) return sock.sendMessage(chatId, { text: "❌ Use: `!sprint 20`" }, { quoted: msg });
                    if (activeSprints[chatId]) {
                        const left = Math.ceil((activeSprints[chatId].endsAt - Date.now()) / 60000);
                        return sock.sendMessage(chatId, { text: `⚠️ Sprint running! *${left}m* left. Use \`!wc [number]\` to join.` }, { quoted: msg });
                    }
                    await startSprintSession(chatId, mins);
                }

                // ── !POMO ───────────────────────────────────────────────────────────
                if (command === "!pomo") {
                    const sprintTime = parseInt(args[1]) || 25;
                    const breakTime  = parseInt(args[2]) || 5;
                    const rounds     = parseInt(args[3]) || 4;
                    if (activeSprints[chatId]) return sock.sendMessage(chatId, { text: "⚠️ Sprint already running!" }, { quoted: msg });
                    if (activePomodoros[chatId]) return sock.sendMessage(chatId, { text: "⚠️ Pomodoro already active!" }, { quoted: msg });
                    activePomodoros[chatId] = { sprintTime, breakTime, roundsLeft: rounds, totalRounds: rounds, lastParticipants: [] };
                    await sock.sendMessage(chatId, { text: `🍅 *POMODORO STARTED!*\n\n🔄 Rounds: ${rounds}\n🏃 Sprint: ${sprintTime}m\n☕ Break: ${breakTime}m\n\n*Round 1/${rounds} starting NOW!*` }, { quoted: msg });
                    await startSprintSession(chatId, sprintTime);
                }

                // ── !SCHEDULE ───────────────────────────────────────────────────────
                if (command === "!schedule") {
                    if (args[2] !== 'in') return sock.sendMessage(chatId, { text: "❌ Use: `!schedule 20 in 60`" }, { quoted: msg });
                    const dur  = parseInt(args[1]), wait = parseInt(args[3]);
                    if (isNaN(dur) || isNaN(wait)) return sock.sendMessage(chatId, { text: "❌ Invalid numbers." }, { quoted: msg });
                    const startAt = new Date(Date.now() + wait * 60000);
                    await ScheduledSprint.create({ groupId: chatId, startTime: startAt, duration: dur, createdBy: senderId });
                    const timeStr = startAt.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
                    return sock.sendMessage(chatId, { text: `📅 *Sprint Scheduled!*\nDuration: ${dur} mins\nStart: In ${wait} mins (~${timeStr} GMT+1)` }, { quoted: msg });
                }

                // ── !UNSCHEDULE ─────────────────────────────────────────────────────
                if (command === "!unschedule") {
                    const r = await ScheduledSprint.deleteMany({ groupId: chatId });
                    return sock.sendMessage(chatId, { text: r.deletedCount > 0 ? `✅ Scheduled sprint cancelled.` : "🤷 None found." }, { quoted: msg });
                }

                // ── !TIME ───────────────────────────────────────────────────────────
                if (command === "!time") {
                    const sprint = activeSprints[chatId];
                    const duel   = activeDuels[chatId];
                    if (!sprint && !duel) return sock.sendMessage(chatId, { text: "❌ No active sprint or duel." }, { quoted: msg });
                    const target = sprint || duel;
                    const r      = target.endsAt - Date.now();
                    if (r <= 0) return sock.sendMessage(chatId, { text: "🛑 Time's up!" }, { quoted: msg });
                    const label  = sprint ? "Sprint" : (duel.isGracePeriod ? "Duel (Grace Period)" : "Duel");
                    return sock.sendMessage(chatId, { text: `⏳ *${label}:* ${Math.floor(r / 60000)}m ${Math.floor((r / 1000) % 60)}s remaining` }, { quoted: msg });
                }

                // ── !CANCEL ─────────────────────────────────────────────────────────
                if (command === "!cancel" || command === "!stop") {
                    let txt = "";
                    if (activeSprints[chatId])   { delete activeSprints[chatId]; await ActiveSprint.deleteOne({ groupId: chatId }); txt += "🚫 Sprint cancelled.\n"; }
                    if (activePomodoros[chatId]) { delete activePomodoros[chatId]; txt += "🚫 Pomodoro cancelled.\n"; }
                    if (activeDuels[chatId])     { delete activeDuels[chatId]; txt += "🚫 Duel cancelled."; }
                    if (!txt) txt = "💤 Nothing to cancel.";
                    await sock.sendMessage(chatId, { text: txt.trim() }, { quoted: msg });
                }

            } catch (err) { console.error("Handler error:", err); }
        });
    };

    initializeBot();

}).catch(err => { console.error("❌ MongoDB error:", err); process.exit(1); });

process.on('unhandledRejection', reason => console.log('⚠️ Unhandled:', reason));
process.on('uncaughtException',  err    => console.log('⚠️ Exception:', err));