const os             = require('os');
const DailyStats     = require('../models/DailyStats');
const UserProfile    = require('../models/UserProfile');
const PersonalGoal   = require('../models/PersonalGoal');
const ScheduledSprint = require('../models/ScheduledSprint');
const GroupChallenge = require('../models/GroupChallenge');
const WeeklyChallenge = require('../models/WeeklyChallenge');
const Blacklist      = require('../models/Blacklist');
const Feedback       = require('../models/Feedback');
const SprintRecord   = require('../models/SprintRecord');
const StreakFreeze   = require('../models/StreakFreeze');
const ActiveSprint   = require('../models/ActiveSprint');
const { getDurationString, getNextRank, getRank, getMaxFreezes, toSuperscript, BADGE_DEFS, getLagosDateString, getLagosMonthName, checkAndUpdateGoals, getActiveGoalsProgress } = require('../utils/helpers');

const BASE_URL     = process.env.BASE_URL || 'https://sprint-bot-9bll.onrender.com';
const TIMEZONE     = 'Africa/Lagos';
const OWNER_NUMBER = process.env.OWNER_NUMBER || '2349019671229';

const MONTH_MAP = {
    jan: { num: '01', name: 'January' },
    feb: { num: '02', name: 'February' },
    mar: { num: '03', name: 'March' },
    apr: { num: '04', name: 'April' },
    may: { num: '05', name: 'May' },
    jun: { num: '06', name: 'June' },
    jul: { num: '07', name: 'July' },
    aug: { num: '08', name: 'August' },
    sep: { num: '09', name: 'September' },
    oct: { num: '10', name: 'October' },
    nov: { num: '11', name: 'November' },
    dec: { num: '12', name: 'December' }
};

const processedMessages = new Set();

module.exports = async function(m, appState) {
    const { 
        sock, isConnected, groupCache, maintenanceMode, activeSprints, activePomodoros, activeDuels,
        pendingFish, fishCooldowns,
        checkRateLimit, getTodayDateGMT1, awardBadge, checkAndAwardBadges, updateStreak,
        updateChallenge, updateWeeklyChallenge, startSprintSession, finishSprint, pushActivity
    } = appState;

            try {
                if (!m.messages || !m.messages.length) return;
                const msg = m.messages[0];
                if (!msg || !msg.message || msg.key.fromMe) return;

                // 1. Deduplicate by message ID
                const msgId = msg.key.id;
                if (processedMessages.has(msgId)) return;
                processedMessages.add(msgId);
                if (processedMessages.size > 1000) {
                    while (processedMessages.size > 1000) {
                        const firstKey = processedMessages.keys().next().value;
                        if (!firstKey) break;
                        processedMessages.delete(firstKey);
                    }
                }

                // 2. Ignore messages older than 2 minutes (120 seconds) to prevent replay/history processing on reconnect
                let timestampSec = msg.messageTimestamp;
                if (timestampSec && typeof timestampSec === 'object' && 'low' in timestampSec) {
                    timestampSec = timestampSec.low;
                }
                timestampSec = Number(timestampSec);
                if (timestampSec && (Date.now() / 1000 - timestampSec > 120)) {
                    return;
                }

                const chatId   = msg.key.remoteJid;
                const isGroup  = chatId.endsWith('@g.us');
                const senderId = msg.key.participant || msg.key.remoteJid;

                // Silently ignore ALL private/DM messages — bot never responds to DMs
                if (!isGroup) return;

                const ban = await Blacklist.findOne({ userId: senderId });
                if (ban) {
                    if (ban.expiresAt && new Date(ban.expiresAt) <= new Date()) {
                        await Blacklist.deleteOne({ _id: ban._id }).catch(() => {});
                    } else {
                        return;
                    }
                }

                const senderProfile = await UserProfile.findOne({ userId: senderId });
                if (senderProfile && senderProfile.isArchived) return;

                // Rate limit
                if (!checkRateLimit(senderId)) return;

                const isOwner = senderId.includes(OWNER_NUMBER);

                // Unwrap ephemeral/viewOnce/interactive message wrappers
                const rawMsg = msg.message.ephemeralMessage?.message 
                    || msg.message.viewOnceMessage?.message 
                    || msg.message.documentWithCaptionMessage?.message
                    || msg.message;
                let body = rawMsg.conversation 
                    || rawMsg.extendedTextMessage?.text 
                    || rawMsg.imageMessage?.caption 
                    || rawMsg.videoMessage?.caption 
                    || rawMsg.listResponseMessage?.singleSelectReply?.selectedRowId
                    || rawMsg.listResponseMessage?.singleSelectReply?.id
                    || rawMsg.listResponseMessage?.title
                    || rawMsg.buttonsResponseMessage?.selectedButtonId
                    || rawMsg.templateButtonReplyMessage?.selectedId
                    || '';

                if (!body && rawMsg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
                    try {
                        const params = JSON.parse(rawMsg.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
                        body = params.id || params.row_id || params.selectedRowId || '';
                    } catch (e) {}
                }

                if (!body || !body.startsWith("!")) return;

                if (maintenanceMode && !isOwner) {
                    await sock.sendMessage(chatId, { text: "⚠️ Bot is in Maintenance Mode. Check back soon!" }, { quoted: msg });
                    return;
                }

                let senderName = senderId.split('@')[0];
                if (msg.pushName) senderName = msg.pushName;
                const savedProfile = await DailyStats.findOne({ userId: senderId }).sort({ timestamp: -1 });
                if (savedProfile?.name) senderName = savedProfile.name;

                const args    = body.trim().split(/\s+/);
                const command = args[0].toLowerCase();
                const todayStr = getTodayDateGMT1();

                const getTargetId = (idx = 1) => {
                    const n = args[idx]?.replace(/\D/g, '');
                    return (n && n.length > 5) ? n + '@c.us' : null;
                };

                // ── OWNER COMMANDS ──────────────────────────────────────────────────
                if (isOwner) {
                    if (command === "!ping") {
                        let msgTime = msg.messageTimestamp;
                        if (msgTime && typeof msgTime === 'object' && 'low' in msgTime) msgTime = msgTime.low;
                        const timeDiff = msgTime ? Math.max(0, Date.now() - Number(msgTime) * 1000) : 0;
                        return sock.sendMessage(chatId, { 
                            text: `🏓 *PONG!*\n\n⚡ Latency: *${timeDiff} ms*\n🟢 WhatsApp: *Connected*\n⚙️ Maintenance: *${maintenanceMode ? "ENABLED ⚠️" : "DISABLED ✅"}*` 
                        }, { quoted: msg });
                    }
                    if (command === "!sys" || command === "!system") {
                        const uptimeSec = process.uptime();
                        const days = Math.floor(uptimeSec / 86400);
                        const hours = Math.floor((uptimeSec % 86400) / 3600);
                        const mins = Math.floor((uptimeSec % 3600) / 60);
                        const secs = Math.floor(uptimeSec % 60);
                        const uptimeStr = `${days ? days + 'd ' : ''}${hours ? hours + 'h ' : ''}${mins}m ${secs}s`;

                        const mem = process.memoryUsage();
                        const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
                        const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
                        const rssMB = Math.round(mem.rss / 1024 / 1024);
                        const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
                        const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);

                        const activeSprintsCount = Object.keys(activeSprints || {}).length;
                        const activeDuelsCount = Object.keys(activeDuels || {}).length;
                        const activePomosCount = Object.keys(activePomodoros || {}).length;
                        const groupCount = Object.keys(groupCache || {}).length;

                        let txt = `🖥️ *SYSTEM HEALTH & METRICS*\n━━━━━━━━━━━━━━━━\n`;
                        txt += `⏱️ *Uptime:* ${uptimeStr}\n`;
                        txt += `💾 *Heap RAM:* ${heapUsedMB} MB / ${heapTotalMB} MB\n`;
                        txt += `📦 *RSS RAM:* ${rssMB} MB\n`;
                        txt += `🖥️ *System Memory:* ${freeMemMB} MB free / ${totalMemMB} MB\n`;
                        txt += `🐧 *Platform:* ${os.platform()} (${os.arch()})\n\n`;
                        txt += `📊 *Active Sessions:*\n`;
                        txt += `• 🏃 Sprints: ${activeSprintsCount}\n`;
                        txt += `• ⚔️ Duels: ${activeDuelsCount}\n`;
                        txt += `• 🍅 Pomodoros: ${activePomosCount}\n`;
                        txt += `• 👥 Cached Groups: ${groupCount}\n\n`;
                        txt += `⚙️ *Maintenance Mode:* ${maintenanceMode ? "ENABLED ⚠️" : "DISABLED ✅"}`;

                        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
                    }
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

⚔️ *Duels & Fishing*
*!duel @user 15* → 1v1 word battle (15 min)
*!fish [mins]* → Hook a random writer into a duel!
*!bite* → Accept fish hook (150+ words = 🪙 scale)
*!challenge 5000* → Group boss battle
*!challenge check* → View boss HP
*!challenge stop* → Cancel manual challenge

📊 *Stats & Profile*
*!profile* → Your full stats
*!wpm* → Sprint speed history
*!daily [all]* → Today's Leaderboard
*!yesterday [all]* → Yesterday's Leaderboard
*!weekly [all]* → Last 7 days
*!monthly [all]* → Last 30 days
*!yearly [all]* → This year's Leaderboard
*!sep26 [all]* → Specific month stats
*!top10 [all]* → All-Time Hall of Fame
*!myname Sam* → Set display name

🔥 *Streaks & Freezes*
*!streak status* → Streak, freezes & Fish Scales
*!streak freeze* → Manually use a freeze

🎯 *Goals*
*!goal day 1000* → Daily recurring target
*!goal week 5000* → Weekly recurring target
*!goal month 20000* → Monthly recurring target
*!goal set 50000* → Open-ended milestone
*!goal cancel [type]* → Stop goal (day/week/month/open/all)
*!goal check* → View goal progress
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

                    // Troll or impossible attempt (> 150,000 words) -> Auto-suspend 24 hours without revealing limits
                    if (count > 150000) {
                        const banUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
                        await Blacklist.findOneAndUpdate(
                            { userId: senderId },
                            { userId: senderId, reason: `Invalid log attempt (${count.toLocaleString()} words)`, bannedAt: new Date(), expiresAt: banUntil },
                            { upsert: true }
                        );
                        pushActivity('ban', `${senderName} suspended 24h (invalid log attempt)`, '🚫');
                        return sock.sendMessage(chatId, {
                            text: `🚫 @${senderId.split('@')[0]} has been suspended for *24 hours* for submitting an invalid word count.`,
                            mentions: [senderId]
                        });
                    }

                    try {
                        await DailyStats.findOneAndUpdate(
                            { userId: senderId, groupId: chatId, date: todayStr },
                            { name: senderName, $inc: { words: count }, timestamp: new Date() },
                            { upsert: true, new: true }
                        );

                        // Goal progress and milestone tracking (appended to response without group spam)
                        let goalResult = { logMessages: [] };
                        try {
                            goalResult = await checkAndUpdateGoals(senderId, count, senderName, todayStr);
                        } catch (e) {
                            console.error("Goal update error:", e);
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
                        if (goalResult?.logMessages?.length) {
                            responseText += `\n\n` + goalResult.logMessages.join('\n');
                        }

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
                        const scales   = freeze?.fishScales || 0;
                        const nextIn   = profile?.currentStreak ? 7 - (profile.currentStreak % 7) : 7;
                        let txt = `🔥 *STREAK STATUS — ${senderName}*\n━━━━━━━━━━━━━━━━\n`;
                        txt += `📅 Current Streak: *${profile?.currentStreak || 0} days*\n`;
                        txt += `🏆 Best Streak: ${profile?.bestStreak || 0} days\n\n`;
                        txt += `🛡️ *Freezes:* ${avail} / ${maxFr}\n`;
                        txt += `🪙 *Fish Scales:* ${scales} / 3\n`;
                        if (maxFr === 0) txt += `_(Rank up to *Aspiring Author ✍️* to earn weekly freezes or forge via *!fish*)_\n`;
                        else if (avail < maxFr) txt += `_(Next weekly freeze in *${nextIn} writing day${nextIn !== 1 ? 's' : ''}*)_\n`;
                        else txt += `_(Freeze cap reached for your rank)_\n`;
                        return sock.sendMessage(chatId, { text: txt.trim() }, { quoted: msg });
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

                // ── FISHING / DUEL HELPER FUNCTIONS ──────────────────────────────────
                const awardFishScale = async (userId) => {
                    let freeze = await StreakFreeze.findOne({ userId });
                    if (!freeze) freeze = await StreakFreeze.create({ userId, freezesAvailable: 0, fishScales: 0 });

                    const profile = await UserProfile.findOne({ userId });
                    const rank = getRank(profile?.totalWordsAllTime || 0);
                    const maxFr = Math.max(1, getMaxFreezes(rank)); // Allows at least 1 freeze holding capacity for fishing

                    let scales = (freeze.fishScales || 0) + 1;
                    let forged = false;

                    if (scales >= 3) {
                        if (freeze.freezesAvailable < maxFr) {
                            scales -= 3;
                            freeze.freezesAvailable = (freeze.freezesAvailable || 0) + 1;
                            forged = true;
                        } else {
                            // Cap reached; bank at 3 scales so nothing is lost
                            scales = 3;
                        }
                    }

                    freeze.fishScales = scales;
                    await freeze.save();

                    return {
                        scales,
                        freezes: freeze.freezesAvailable,
                        maxFreezes: maxFr,
                        forged,
                        atCap: !forged && scales >= 3 && freeze.freezesAvailable >= maxFr
                    };
                };

                const startDuelSession = async ({ chatId, challenger, opponent, challengerName, opponentName, duration, isFish = false }) => {
                    const endsAt = Date.now() + duration * 60000;
                    activeDuels[chatId] = {
                        challenger, opponent, duration, endsAt,
                        words: { [challenger]: 0, [opponent]: 0 },
                        challengerName, opponentName,
                        isGracePeriod: false,
                        isFish
                    };

                    if (isFish) {
                        await sock.sendMessage(chatId, {
                            text: `🐟 *THE FISH BIT THE HOOK!* 🎣\n━━━━━━━━━━━━━━━━\n⚔️ *FISHING DUEL COMMENCED!*\n\n🎣 Caster: @${challenger.split('@')[0]}\n🐟 Catch: @${opponent.split('@')[0]}\n⏱️ Duration: *${duration} minutes*\n\n📝 Both of you grab your pens and write! Use *!wc [number]* to log words.\n🎯 *150+ words* needed to claim a Fish Scale 🪙!\n\nMay the swiftest pen triumph! 🚀`,
                            mentions: [challenger, opponent]
                        });
                        pushActivity('duel', `Fishing duel started: ${challengerName} vs ${opponentName}`, '🎣');
                    } else {
                        await sock.sendMessage(chatId, {
                            text: `⚔️ *WORD DUEL!* ⚔️\n━━━━━━━━━━━━━━━━\n🔴 @${challenger.split('@')[0]} vs 🔵 @${opponent.split('@')[0]}\n⏱️ Duration: *${duration} minutes*\n\nUse *!wc [number]* to log words!\nMay the best writer win! 📝`,
                            mentions: [challenger, opponent]
                        });
                        pushActivity('duel', `Duel started by @${challengerName}`, '⚔️');
                    }

                    const timer = setTimeout(async () => {
                        try {
                            const duel = activeDuels[chatId];
                            if (!duel) return;
                            
                            duel.isGracePeriod = true;
                            duel.endsAt = Date.now() + (5 * 60000);

                            const prefix = duel.isFish ? "🛑 *FISHING DUEL TIME'S UP!*" : "🛑 *DUEL TIME'S UP!*";
                            await sock.sendMessage(chatId, { 
                                text: `${prefix}\n\n@${duel.challenger.split('@')[0]} and @${duel.opponent.split('@')[0]}, put your pens down!\n\nYou have *5 minutes* to submit your final words using *!wc [number]*!`, 
                                mentions: [duel.challenger, duel.opponent] 
                            });

                            const graceTimer = setTimeout(async () => {
                                try {
                                    const finalDuel = activeDuels[chatId];
                                    if (!finalDuel) return;
                                    delete activeDuels[chatId];

                                    const cW = finalDuel.words[finalDuel.challenger] || 0;
                                    const oW = finalDuel.words[finalDuel.opponent]   || 0;
                                    const draw     = cW === oW;
                                    const winnerId = cW > oW ? finalDuel.challenger : finalDuel.opponent;
                                    const loserId  = cW > oW ? finalDuel.opponent   : finalDuel.challenger;
                                    const winWords = Math.max(cW, oW);
                                    const loseWords = Math.min(cW, oW);

                                    let txt = "";

                                    if (finalDuel.isFish) {
                                        txt += `🎣 *FISHING DUEL FINISHED!* 🎣\n━━━━━━━━━━━━━━━━\n`;
                                        if (draw) {
                                            txt += `🤝 *DEAD HEAT DRAW!*\nBoth writers: *${cW.toLocaleString()} words*\n`;
                                            if (cW >= 150) {
                                                const r1 = await awardFishScale(finalDuel.challenger);
                                                const r2 = await awardFishScale(finalDuel.opponent);
                                                txt += `\n🪙 Both reeled in *1 Fish Scale* (150+ words hit)!`;
                                                if (r1.forged) txt += `\n✨ @${finalDuel.challenger.split('@')[0]} forged a *Streak Freeze* 🛡️! (Total: ${r1.freezes})`;
                                                else if (r1.atCap) txt += `\n(@${finalDuel.challenger.split('@')[0]}: Freeze cap reached, banked 3/3 scales 🪙)`;
                                                else txt += `\n(@${finalDuel.challenger.split('@')[0]}: ${r1.scales}/3 scales 🪙)`;

                                                if (r2.forged) txt += `\n✨ @${finalDuel.opponent.split('@')[0]} forged a *Streak Freeze* 🛡️! (Total: ${r2.freezes})`;
                                                else if (r2.atCap) txt += `\n(@${finalDuel.opponent.split('@')[0]}: Freeze cap reached, banked 3/3 scales 🪙)`;
                                                else txt += `\n(@${finalDuel.opponent.split('@')[0]}: ${r2.scales}/3 scales 🪙)`;
                                            } else {
                                                txt += `\n⚠️ Neither reached the 150-word threshold for Fish Scales! Keep casting!`;
                                            }
                                        } else {
                                            txt += `🏆 *BIG CATCH WINNER:* @${winnerId.split('@')[0]} — *${winWords.toLocaleString()} words*\n🐟 *CAUGHT:* @${loserId.split('@')[0]} — ${loseWords.toLocaleString()} words\n`;
                                            
                                            if (winWords >= 150) {
                                                const res = await awardFishScale(winnerId);
                                                txt += `\n🪙 @${winnerId.split('@')[0]} earned *1 Fish Scale*!`;
                                                if (res.forged) {
                                                    txt += `\n✨ *3 FISH SCALES FORGED!* @${winnerId.split('@')[0]} unlocked *1 STREAK FREEZE* 🛡️! (Total Freezes: ${res.freezes})`;
                                                } else if (res.atCap) {
                                                    txt += `\n_(Freeze cap reached for your rank. Scales banked at 3/3 until a freeze is used!)_`;
                                                } else {
                                                    txt += ` (${res.scales}/3 towards a Streak Freeze 🛡️)`;
                                                }
                                            } else {
                                                txt += `\n⚠️ Winner logged less than 150 words, so no Fish Scale was awarded. Push harder next time!`;
                                            }

                                            try {
                                                const winProf = await UserProfile.findOne({ userId: winnerId });
                                                if (winProf) await awardBadge(winProf, 'duel_win', chatId);
                                            } catch (e) {}
                                        }
                                    } else {
                                        txt += `⚔️ *DUEL OVER!* ⚔️\n━━━━━━━━━━━━━━━━\n`;
                                        if (draw) {
                                            txt += `🤝 *IT'S A DRAW!*\nBoth: *${cW.toLocaleString()} words*\n\nHonour among wordsmiths! 🙏`;
                                        } else {
                                            txt += `🏆 *WINNER:* @${winnerId.split('@')[0]} — *${winWords.toLocaleString()} words*\n💀 *LOSER:* @${loserId.split('@')[0]} — ${loseWords.toLocaleString()} words\n\nBetter luck next time! 😤`;
                                            try {
                                                const winProf = await UserProfile.findOne({ userId: winnerId });
                                                if (winProf) await awardBadge(winProf, 'duel_win', chatId);
                                            } catch (e) {}
                                        }
                                    }

                                    // Log words to daily stats for both
                                    for (const [uid, words] of Object.entries(finalDuel.words)) {
                                        if (words > 0) {
                                            const name = uid === finalDuel.challenger ? finalDuel.challengerName : finalDuel.opponentName;
                                            await DailyStats.findOneAndUpdate({ userId: uid, groupId: chatId, date: todayStr }, { name, $inc: { words }, timestamp: new Date() }, { upsert: true });
                                            await updateStreak(uid, name, words);
                                        }
                                    }

                                    await sock.sendMessage(chatId, { text: txt.trim(), mentions: [finalDuel.challenger, finalDuel.opponent] });
                                    pushActivity('duel', `${finalDuel.isFish ? 'Fishing duel' : 'Duel'} ended in ${groupCache[chatId]?.subject || chatId}`, finalDuel.isFish ? '🎣' : '⚔️');
                                } catch (e) {
                                    console.error("⚠️ Error in duel resolution timer:", e);
                                }
                            }, 5 * 60000);
                            duel.graceTimer = graceTimer;
                        } catch (e) {
                            console.error("⚠️ Error in duel end timer:", e);
                        }
                    }, duration * 60000);

                    if (activeDuels[chatId]) {
                        activeDuels[chatId].timer = timer;
                    }
                };

                // ── !DUEL ───────────────────────────────────────────────────────────
                if (command === "!duel") {
                    const mentioned  = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
                    const opponentId = mentioned?.[0] || getTargetId(1);
                    const duration   = parseInt(args[2]) || parseInt(args[1]) || 15;

                    if (!opponentId)             return sock.sendMessage(chatId, { text: "❌ Tag your opponent: `!duel @user 15`" }, { quoted: msg });
                    if (opponentId === senderId) return sock.sendMessage(chatId, { text: "❌ You can't duel yourself!" }, { quoted: msg });
                    if (activeDuels[chatId])     return sock.sendMessage(chatId, { text: "⚠️ A duel or fishing duel is already active here!" }, { quoted: msg });
                    if (activeSprints[chatId])   return sock.sendMessage(chatId, { text: "⚠️ Can't start a duel during a sprint." }, { quoted: msg });
                    if (duration < 5 || duration > 60) return sock.sendMessage(chatId, { text: "❌ Duration must be 5–60 minutes." }, { quoted: msg });

                    await startDuelSession({
                        chatId,
                        challenger: senderId,
                        opponent: opponentId,
                        challengerName: senderName,
                        opponentName: opponentId.split('@')[0],
                        duration,
                        isFish: false
                    });
                    return;
                }

                // ── !FISH ───────────────────────────────────────────────────────────
                if (command === "!fish") {
                    if (!chatId.endsWith('@g.us')) {
                        return sock.sendMessage(chatId, { text: "❌ Fishing can only be cast in group chats!" }, { quoted: msg });
                    }

                    if (activeSprints[chatId]) {
                        return sock.sendMessage(chatId, { text: "⚠️ A sprint is already running in this group!" }, { quoted: msg });
                    }
                    if (activeDuels[chatId]) {
                        return sock.sendMessage(chatId, { text: "⚠️ A duel or fishing duel is already active here!" }, { quoted: msg });
                    }
                    if (pendingFish && pendingFish[chatId]) {
                        return sock.sendMessage(chatId, { 
                            text: `⚠️ A fishing line is already in the water! Waiting for @${pendingFish[chatId].target.split('@')[0]} to bite (or type *!bite*).`,
                            mentions: [pendingFish[chatId].target]
                        }, { quoted: msg });
                    }

                    // Cooldown: 30 minutes per group between casts
                    const COOLDOWN_MS = 30 * 60 * 1000;
                    if (fishCooldowns && fishCooldowns[chatId] && (Date.now() - fishCooldowns[chatId]) < COOLDOWN_MS) {
                        const waitMins = Math.ceil((COOLDOWN_MS - (Date.now() - fishCooldowns[chatId])) / 60000);
                        return sock.sendMessage(chatId, { text: `🌊 The waters need to calm down! You can cast another line in *${waitMins} minute${waitMins !== 1 ? 's' : ''}*.` }, { quoted: msg });
                    }

                    const duration = parseInt(args[1]) || 30;
                    if (duration < 5 || duration > 60) {
                        return sock.sendMessage(chatId, { text: "❌ Duration must be 5–60 minutes (default is 30 mins: `!fish`)." }, { quoted: msg });
                    }

                    // Find active writers in this group from the last 7 days
                    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                    const activeUserIds = await DailyStats.distinct("userId", { 
                        groupId: chatId, 
                        timestamp: { $gte: sevenDaysAgo } 
                    });

                    const botJid = sock.user?.id?.split(':')[0] || '';
                    let candidates = activeUserIds.filter(uid => uid !== senderId && !uid.includes(botJid));

                    // Fallback to group participants if not enough recent active writers
                    if (candidates.length === 0) {
                        try {
                            const meta = await sock.groupMetadata(chatId);
                            candidates = (meta.participants || [])
                                .map(p => p.id)
                                .filter(uid => uid !== senderId && !uid.includes(botJid));
                        } catch (e) {}
                    }

                    if (!candidates || candidates.length === 0) {
                        return sock.sendMessage(chatId, { text: "❌ Not enough writers in this group to fish!" }, { quoted: msg });
                    }

                    const targetId = candidates[Math.floor(Math.random() * candidates.length)];
                    const targetProfile = await UserProfile.findOne({ userId: targetId });
                    const targetName = targetProfile?.name || targetId.split('@')[0];

                    if (fishCooldowns) fishCooldowns[chatId] = Date.now();

                    const timeout = setTimeout(async () => {
                        try {
                            if (pendingFish && pendingFish[chatId] && pendingFish[chatId].target === targetId) {
                                delete pendingFish[chatId];
                                await sock.sendMessage(chatId, {
                                    text: `🐟 *THE FISH GOT AWAY!*\n\n@${targetId.split('@')[0]} didn't take the bait in time. The line reeled back empty! 🌊`,
                                    mentions: [targetId]
                                });
                            }
                        } catch (e) {
                            console.error("Fish timeout error:", e);
                        }
                    }, 3 * 60 * 1000); // 3 minutes to bite

                    if (pendingFish) {
                        pendingFish[chatId] = {
                            caster: senderId,
                            casterName: senderName,
                            target: targetId,
                            targetName: targetName,
                            duration,
                            timeout,
                            createdAt: Date.now()
                        };
                    }

                    return sock.sendMessage(chatId, {
                        text: `🎣 *FISHING LINE CAST!* 🎣\n━━━━━━━━━━━━━━━━\n🎣 @${senderId.split('@')[0]} cast a line into the deep waters and *HOOKED* @${targetId.split('@')[0]}!\n\nWill @${targetId.split('@')[0]} take the bait?\n👉 Type *!bite* within *3 minutes* to start a *${duration}-minute Fishing Duel*!\n\n🏆 *Reward:* Write *150+ words* to reel in *1 Fish Scale* 🪙!\nCollect *3 Fish Scales* to forge *1 Streak Freeze* 🛡️!\n\n⏱️ You have *3 minutes* to bite! 🐟`,
                        mentions: [senderId, targetId]
                    });
                }

                // ── !BITE ───────────────────────────────────────────────────────────
                if (command === "!bite") {
                    if (!pendingFish || !pendingFish[chatId]) {
                        return sock.sendMessage(chatId, { text: "❌ No active fishing line in the water! Cast one with `!fish`" }, { quoted: msg });
                    }

                    const fish = pendingFish[chatId];
                    if (senderId !== fish.target) {
                        return sock.sendMessage(chatId, { 
                            text: `❌ Hands off the reel! Only @${fish.target.split('@')[0]} was hooked on this line!`,
                            mentions: [fish.target]
                        }, { quoted: msg });
                    }

                    if (fish.timeout) clearTimeout(fish.timeout);
                    delete pendingFish[chatId];

                    await startDuelSession({
                        chatId,
                        challenger: fish.caster,
                        opponent: fish.target,
                        challengerName: fish.casterName,
                        opponentName: fish.targetName,
                        duration: fish.duration,
                        isFish: true
                    });
                    return;
                }

                // ── !WC ─────────────────────────────────────────────────────────────
                if (command === "!wc") {
                    const duel   = activeDuels[chatId];
                    const sprint = activeSprints[chatId];

                    if (!sprint && !duel) return sock.sendMessage(chatId, { text: "❌ *No Active Sprint or Duel*\n\nStart one with `!sprint 20` or `!duel @user 15`\nOr log manually: `!log 500`" }, { quoted: msg });

                    const isAdd  = args[1] === 'add' || args[1] === '+';
                    const rawNum = isAdd ? args[2] : args[1];
                    const c      = parseInt(rawNum);
                    if (isNaN(c) || c < 0) return sock.sendMessage(chatId, { text: "❌ Use: `!wc 500`" }, { quoted: msg });

                    const duration = sprint?.duration || duel?.duration || 20;
                    const maxSprintWords = Math.max(1500, duration * 250);

                    // Troll sprint attempt (> 15,000 words in a live sprint) -> 24-hour suspension without revealing limits
                    if (c > 15000) {
                        const banUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
                        await Blacklist.findOneAndUpdate(
                            { userId: senderId },
                            { userId: senderId, reason: `Invalid sprint submission (${c.toLocaleString()} words in ${duration}m sprint)`, bannedAt: new Date(), expiresAt: banUntil },
                            { upsert: true }
                        );
                        pushActivity('ban', `${senderName} suspended 24h (invalid sprint submission)`, '🚫');
                        return sock.sendMessage(chatId, {
                            text: `🚫 @${senderId.split('@')[0]} has been suspended for *24 hours* for submitting an invalid sprint word count.`,
                            mentions: [senderId]
                        });
                    }

                    // Sprint sanity check without revealing formula
                    if (c > maxSprintWords) {
                        return sock.sendMessage(chatId, {
                            text: `❌ *Invalid sprint word count.* Pacing exceeds sprint limits. If this is an offline backlog, please use \`!log\` instead.`
                        }, { quoted: msg });
                    }
                    
                    // Reactivate user if they log words
                    await UserProfile.findOneAndUpdate({ userId: senderId }, { isInactive: false });

                    if (duel && !sprint) {
                        if (senderId !== duel.challenger && senderId !== duel.opponent) {
                            return sock.sendMessage(chatId, { text: "❌ Only duel participants can log here." }, { quoted: msg });
                        }
                        if (isAdd) duel.words[senderId] = (duel.words[senderId] || 0) + c;
                        else duel.words[senderId] = c;
                        const left = Math.ceil((duel.endsAt - Date.now()) / 60000);
                        const label = duel.isFish ? '🎣 Fishing Duel' : '⚔️ Duel';
                        return sock.sendMessage(chatId, { text: `✅ ${label}: *${duel.words[senderId].toLocaleString()} words* | ${left}m left` }, { quoted: msg });
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
                            const breakTimer = setTimeout(async () => {
                                if (activePomodoros[chatId]) {
                                    await sock.sendMessage(chatId, {
                                        text: `🍅 *Break Over!* Round ${round}/${pomo.totalRounds} starting NOW! ${pomo.lastParticipants.map(id => '@' + id.split('@')[0]).join(' ')}`,
                                        mentions: pomo.lastParticipants
                                    });
                                    await startSprintSession(chatId, pomo.sprintTime);
                                }
                            }, pomo.breakTime * 60000);
                            pomo.breakTimer = breakTimer;
                        }
                    }
                }

                // ── !TOP10 ──────────────────────────────────────────────────────────
                if (command === "!top10" || command === "!top") {
                    const isGlobal = args[1]?.toLowerCase() === "all" || args[1]?.toLowerCase() === "global";
                    const groupName = groupCache[chatId]?.subject || "This Group";
                    const matchQuery = isGlobal ? {} : { groupId: chatId };

                    const top = await DailyStats.aggregate([
                        { $match: matchQuery },
                        { $group: { _id: "$userId", total: { $sum: "$words" }, name: { $first: "$name" } } },
                        { $sort: { total: -1 } },
                        { $limit: 10 }
                    ]);

                    if (!top.length) {
                        const emptyMsg = isGlobal
                            ? "📉 No all-time stats found."
                            : `📉 No stats found for *${groupName}* yet.\n\n\n💡 *Note:* To see rankings across all groups, use *${command} all*`;
                        return sock.sendMessage(chatId, { text: emptyMsg }, { quoted: msg });
                    }

                    let title = isGlobal
                        ? `🌎 *ALL-TIME HALL OF FAME — Worldwide (All Groups)*`
                        : `🏆 *ALL-TIME TOP 10 — ${groupName}*`;

                    let txt = `${title}\n\n`;
                    for (let i = 0; i < top.length; i++) {
                        const w = top[i];
                        const p = await UserProfile.findOne({ userId: w._id });
                        const fire = (p && p.currentStreak > 2) ? `🔥${toSuperscript(p.currentStreak)}` : "";
                        txt += `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.'} ${w.name || w._id.split('@')[0]} ${fire}: ${w.total.toLocaleString()} words\n`;
                    }

                    const note = isGlobal
                        ? `💡 *Note:* To see rankings for this group only, use *${command}*`
                        : `💡 *Note:* To see rankings across all groups, use *${command} all*`;

                    txt += `\n\n${note}`;
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
                    const activeGoals = await getActiveGoalsProgress(senderId, todayStr);
                    const freeze     = await StreakFreeze.findOne({ userId: senderId });
                    const rank       = getRank(profile.totalWordsAllTime);
                    const nextRank   = getNextRank(profile.totalWordsAllTime);
                    const profileLink = `${BASE_URL}/profile/${senderId.split('@')[0]}`;

                    let txt = `👤 *WRITER PROFILE*\n━━━━━━━━━━━━━━\n📛 *${profile.name}*\n🎖️ Rank: ${rank}\n`;
                    if (nextRank) {
                        const pct = Math.min(100, (profile.totalWordsAllTime / nextRank.threshold) * 100).toFixed(1);
                        const wordsLeft = Math.max(0, nextRank.threshold - profile.totalWordsAllTime);
                        txt += `📈 Next: ${nextRank.name} (${pct}% | ${wordsLeft.toLocaleString()} words left)\n`;
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

                    if (activeGoals.length) {
                        txt += `\n\n🎯 *Active Goals:*`;
                        for (const g of activeGoals) {
                            txt += `\n• ${g.icon} *${g.label}:* \`${g.current.toLocaleString()} / ${g.target.toLocaleString()}\` (${g.pct}%)\n  ${g.bar}`;
                        }
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

                // ── !DAILY / !YESTERDAY / !WEEKLY / !MONTHLY / !YEARLY / !MMM-YY ─────────────────
                const monthMatch = command.match(/^!([a-z]{3})(\d{2}|\d{4})$/i);
                const isMonthCmd = monthMatch && MONTH_MAP[monthMatch[1].toLowerCase()];

                if (["!daily", "!yesterday", "!weekly", "!monthly", "!yearly"].includes(command) || isMonthCmd) {
                    const isGlobal = args[1]?.toLowerCase() === "all" || args[1]?.toLowerCase() === "global";
                    const groupName = groupCache[chatId]?.subject || "This Group";

                    let baseTitle = "";
                    let matchQuery = {};

                    if (command === "!daily") {
                        baseTitle = `Daily (${todayStr})`;
                        matchQuery = { date: todayStr };
                    } else if (command === "!yesterday") {
                        const yStr = getLagosDateString(Date.now() - 86400000);
                        baseTitle = `Yesterday (${yStr})`;
                        matchQuery = { date: yStr };
                    } else if (command === "!weekly") {
                        const dt = new Date(); dt.setDate(dt.getDate() - 7); dt.setHours(0, 0, 0, 0);
                        baseTitle = "Weekly (Last 7 days)";
                        matchQuery = { timestamp: { $gte: dt } };
                    } else if (command === "!monthly") {
                        const dt = new Date(); dt.setDate(dt.getDate() - 30); dt.setHours(0, 0, 0, 0);
                        baseTitle = "Monthly (Last 30 days)";
                        matchQuery = { timestamp: { $gte: dt } };
                    } else if (command === "!yearly") {
                        const currentYear = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }).slice(0, 4);
                        baseTitle = `Yearly (${currentYear})`;
                        matchQuery = { date: { $regex: `^${currentYear}` } };
                    } else if (isMonthCmd) {
                        const mKey = monthMatch[1].toLowerCase();
                        const yRaw = monthMatch[2];
                        const fullYear = yRaw.length === 2 ? '20' + yRaw : yRaw;
                        const mInfo = MONTH_MAP[mKey];
                        baseTitle = `${mInfo.name} ${fullYear}`;
                        matchQuery = { date: { $regex: `^${fullYear}-${mInfo.num}` } };
                    }

                    if (!isGlobal) {
                        matchQuery.groupId = chatId;
                    }

                    const stats = await DailyStats.aggregate([
                        { $match: matchQuery },
                        { $group: { _id: "$userId", totalWords: { $sum: "$words" }, name: { $first: "$name" } } },
                        { $sort: { totalWords: -1 } },
                        { $limit: 15 }
                    ]);

                    if (!stats.length) {
                        const emptyMsg = isGlobal
                            ? `📉 No stats found for *${baseTitle}*.`
                            : `📉 No stats found in *${groupName}* for *${baseTitle}*.\n\n\n💡 *Note:* To see rankings across all groups, use *${command} all*`;
                        return sock.sendMessage(chatId, { text: emptyMsg }, { quoted: msg });
                    }

                    let title = isGlobal
                        ? `🌎 *${baseTitle} — Worldwide (All Groups)*`
                        : `🏆 *${baseTitle} — ${groupName}*`;

                    let txt = `${title}\n\n`;
                    for (let i = 0; i < stats.length; i++) {
                        const s = stats[i];
                        const p = await UserProfile.findOne({ userId: s._id });
                        const fire = (p && p.currentStreak > 2) ? `🔥${toSuperscript(p.currentStreak)}` : "";
                        txt += `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🎖️'} ${s.name || s._id.split('@')[0]} ${fire}: ${s.totalWords.toLocaleString()} words\n`;
                    }

                    const note = isGlobal
                        ? `💡 *Note:* To see rankings for this group only, use *${command}*`
                        : `💡 *Note:* To see rankings across all groups, use *${command} all*`;

                    txt += `\n\n${note}`;
                    await sock.sendMessage(chatId, { text: txt });
                }

                // ── !GOAL ────────────────────────────────────────────────────────────
                if (command === "!goal") {
                    const sub = args[1]?.toLowerCase();

                    // 1. !goal day [number] or !goal daily [number]
                    if (sub === "day" || sub === "daily") {
                        const t = parseInt(args[2]);
                        if (isNaN(t) || t <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!goal day 1000`" }, { quoted: msg });
                        await PersonalGoal.updateMany({ userId: senderId, type: "day" }, { isActive: false });
                        await PersonalGoal.create({ userId: senderId, name: senderName, type: "day", target: t, isActive: true });
                        return sock.sendMessage(chatId, { text: `📅 *Daily Goal Set: ${t.toLocaleString()} words!*\nResets every midnight (Lagos time). You've got this! 💪` }, { quoted: msg });
                    }

                    // 2. !goal week [number] or !goal weekly [number]
                    if (sub === "week" || sub === "weekly") {
                        const t = parseInt(args[2]);
                        if (isNaN(t) || t <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!goal week 5000`" }, { quoted: msg });
                        await PersonalGoal.updateMany({ userId: senderId, type: "week" }, { isActive: false });
                        await PersonalGoal.create({ userId: senderId, name: senderName, type: "week", target: t, isActive: true });
                        return sock.sendMessage(chatId, { text: `🗓️ *Weekly Goal Set: ${t.toLocaleString()} words!*\nResets every Monday at 00:00. Let's make it count! 🚀` }, { quoted: msg });
                    }

                    // 3. !goal month [number] or !goal monthly [number]
                    if (sub === "month" || sub === "monthly") {
                        const t = parseInt(args[2]);
                        if (isNaN(t) || t <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!goal month 20000`" }, { quoted: msg });
                        await PersonalGoal.updateMany({ userId: senderId, type: "month" }, { isActive: false });
                        await PersonalGoal.create({ userId: senderId, name: senderName, type: "month", target: t, isActive: true });
                        return sock.sendMessage(chatId, { text: `📆 *Monthly Goal Set: ${t.toLocaleString()} words!*\nResets on the 1st of every month. Go create magic! 🌟` }, { quoted: msg });
                    }

                    // 4. !goal set [number] (Open-ended goal)
                    if (sub === "set") {
                        const t = parseInt(args[2]);
                        if (isNaN(t) || t <= 0) return sock.sendMessage(chatId, { text: "❌ Use: `!goal set 50000`" }, { quoted: msg });
                        await PersonalGoal.updateMany({ userId: senderId, type: "open" }, { isActive: false });
                        await PersonalGoal.create({ userId: senderId, name: senderName, type: "open", target: t, current: 0, isActive: true });
                        return sock.sendMessage(chatId, { text: `🎯 *Open-Ended Goal Set: ${t.toLocaleString()} words!*\nRuns until you crush it. Write on! ✍️` }, { quoted: msg });
                    }

                    // 5. !goal cancel [day/week/month/open/all]
                    if (sub === "cancel" || sub === "stop" || sub === "delete") {
                        const targetType = args[2]?.toLowerCase();
                        if (targetType === "day" || targetType === "daily") {
                            const res = await PersonalGoal.updateMany({ userId: senderId, type: "day", isActive: true }, { isActive: false });
                            if (!res.modifiedCount) return sock.sendMessage(chatId, { text: "❌ No active daily goal to cancel." }, { quoted: msg });
                            return sock.sendMessage(chatId, { text: "🚫 *Daily Goal Cancelled.*" }, { quoted: msg });
                        }
                        if (targetType === "week" || targetType === "weekly") {
                            const res = await PersonalGoal.updateMany({ userId: senderId, type: "week", isActive: true }, { isActive: false });
                            if (!res.modifiedCount) return sock.sendMessage(chatId, { text: "❌ No active weekly goal to cancel." }, { quoted: msg });
                            return sock.sendMessage(chatId, { text: "🚫 *Weekly Goal Cancelled.*" }, { quoted: msg });
                        }
                        if (targetType === "month" || targetType === "monthly") {
                            const res = await PersonalGoal.updateMany({ userId: senderId, type: "month", isActive: true }, { isActive: false });
                            if (!res.modifiedCount) return sock.sendMessage(chatId, { text: "❌ No active monthly goal to cancel." }, { quoted: msg });
                            return sock.sendMessage(chatId, { text: "🚫 *Monthly Goal Cancelled.*" }, { quoted: msg });
                        }
                        if (targetType === "open" || targetType === "set") {
                            const res = await PersonalGoal.updateMany({ userId: senderId, type: "open", isActive: true }, { isActive: false });
                            if (!res.modifiedCount) return sock.sendMessage(chatId, { text: "❌ No active open-ended goal to cancel." }, { quoted: msg });
                            return sock.sendMessage(chatId, { text: "🚫 *Open-Ended Goal Cancelled.*" }, { quoted: msg });
                        }
                        if (targetType === "all") {
                            const res = await PersonalGoal.updateMany({ userId: senderId, isActive: true }, { isActive: false });
                            if (!res.modifiedCount) return sock.sendMessage(chatId, { text: "❌ No active goals to cancel." }, { quoted: msg });
                            return sock.sendMessage(chatId, { text: "🚫 *All Active Goals Cancelled.*" }, { quoted: msg });
                        }

                        // If type not specified, check active goals
                        const userGoals = await PersonalGoal.find({ userId: senderId, isActive: true });
                        if (!userGoals.length) return sock.sendMessage(chatId, { text: "❌ No active goals to cancel." }, { quoted: msg });
                        if (userGoals.length === 1) {
                            userGoals[0].isActive = false;
                            await userGoals[0].save();
                            return sock.sendMessage(chatId, { text: `🚫 *${userGoals[0].type ? userGoals[0].type.toUpperCase() : 'OPEN'} Goal Cancelled.*` }, { quoted: msg });
                        }
                        return sock.sendMessage(chatId, {
                            text: `❌ Please specify which goal to cancel:\n• \`!goal cancel day\`\n• \`!goal cancel week\`\n• \`!goal cancel month\`\n• \`!goal cancel open\`\n• \`!goal cancel all\``
                        }, { quoted: msg });
                    }

                    // 6. !goal history
                    if (sub === "history") {
                        const history = await PersonalGoal.find({ userId: senderId, isActive: false }).sort({ _id: -1 }).limit(6);
                        if (!history.length) return sock.sendMessage(chatId, { text: "📜 No past goals." }, { quoted: msg });
                        let txt = `📜 *GOAL HISTORY*\n━━━━━━━━━━━━━━\n`;
                        history.forEach(g => {
                            const target = g.target || 0;
                            const current = g.current || 0;
                            const pct = target > 0 ? Math.min(100, (current / target) * 100).toFixed(1) : '0';
                            const win = current >= target;
                            const dur = g.completedAt ? getDurationString(g.startedAt, g.completedAt) : null;
                            const typeTag = g.type ? `[${g.type.toUpperCase()}] ` : '';
                            txt += `\n${win ? '✅' : '❌'} ${typeTag}${g.startDate || 'Past'} | ${target.toLocaleString()} words\n   ${current.toLocaleString()} (${pct}%)${win && dur ? ` — ${dur}` : ''}\n`;
                        });
                        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
                    }

                    // 7. Check / Dashboard (default: !goal or !goal check / status)
                    const activeGoals = await getActiveGoalsProgress(senderId, todayStr);
                    if (!activeGoals.length) {
                        return sock.sendMessage(chatId, {
                            text: `🎯 *NO ACTIVE GOALS*\n\nSet your writing targets with:\n• \`!goal day 1000\` — Daily target (resets midnight)\n• \`!goal week 5000\` — Weekly target (resets Monday)\n• \`!goal month 20000\` — Monthly target (resets 1st)\n• \`!goal set 50000\` — Open-ended milestone`
                        }, { quoted: msg });
                    }

                    let txt = `🎯 *YOUR WRITING GOALS*\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
                    activeGoals.forEach((g, i) => {
                        txt += `${g.icon} *${g.label.toUpperCase()}:* \`${g.current.toLocaleString()} / ${g.target.toLocaleString()}\` (${g.pct}%)\n${g.bar}\n`;
                        if (i < activeGoals.length - 1) txt += `\n`;
                    });
                    txt += `\n━━━━━━━━━━━━━━━━━━━━━━━\nLog progress with *!log [words]* ✍️`;
                    return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
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
                    if (activeDuels[chatId]) return sock.sendMessage(chatId, { text: "⚠️ A duel is currently in progress! Complete or cancel the duel first." }, { quoted: msg });
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
                    pushActivity('schedule', `Sprint scheduled by @${senderName}`, '📅');
                    const timeStr = startAt.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
                    return sock.sendMessage(chatId, { text: `📅 *Sprint Scheduled!*\nDuration: ${dur} mins\nStart: In ${wait} mins (~${timeStr} GMT+1)` }, { quoted: msg });
                }

                // ── !UNSCHEDULE ─────────────────────────────────────────────────────
                if (command === "!unschedule") {
                    const r = await ScheduledSprint.deleteMany({ groupId: chatId });
                    if (r.deletedCount > 0) pushActivity('schedule', `Sprint cancelled by @${senderName}`, '🚫');
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
                    let label = "Duel";
                    if (sprint) label = "Sprint";
                    else if (duel.isFish) label = duel.isGracePeriod ? "Fishing Duel (Grace Period)" : "Fishing Duel";
                    else if (duel.isGracePeriod) label = "Duel (Grace Period)";
                    const endStr = new Date(target.endsAt).toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
                    return sock.sendMessage(chatId, { text: `⏳ *${label}:* ${Math.floor(r / 60000)}m ${Math.floor((r / 1000) % 60)}s remaining\n*(Ends at ~${endStr} GMT+1)*` }, { quoted: msg });
                }

                // ── !OPTOUT ──────────────────────────────────────────────────────────
                if (command === "!optout") {
                    let profile = await UserProfile.findOne({ userId: senderId });
                    if (!profile) {
                        return sock.sendMessage(chatId, { text: "❌ Profile not found." }, { quoted: msg });
                    }
                    if (profile.isArchived) {
                        return sock.sendMessage(chatId, { text: "⚠️ Your profile is already archived." }, { quoted: msg });
                    }
                    profile.isArchived = true;
                    await profile.save();
                    return sock.sendMessage(chatId, { text: `✅ Your profile has been archived. You will no longer receive reminders, notifications, or automatic freezes. Contact an admin if you wish to reactivate.` }, { quoted: msg });
                }

                // ── !CANCEL ─────────────────────────────────────────────────────────
                if (command === "!cancel" || command === "!stop") {
                    let txt = "";
                    if (pendingFish && pendingFish[chatId]) {
                        if (pendingFish[chatId].timeout) clearTimeout(pendingFish[chatId].timeout);
                        delete pendingFish[chatId];
                        txt += "🎣 Fishing line reeled in.\n";
                    }
                    if (activeSprints[chatId]) {
                        const sprint = activeSprints[chatId];
                        if (sprint.warningTimer) clearTimeout(sprint.warningTimer);
                        if (sprint.endTimer) clearTimeout(sprint.endTimer);
                        delete activeSprints[chatId];
                        await ActiveSprint.deleteOne({ groupId: chatId });
                        txt += "🚫 Sprint cancelled.\n";
                    }
                    if (activePomodoros[chatId]) {
                        const pomo = activePomodoros[chatId];
                        if (pomo.breakTimer) clearTimeout(pomo.breakTimer);
                        delete activePomodoros[chatId];
                        txt += "🚫 Pomodoro cancelled.\n";
                    }
                    if (activeDuels[chatId]) {
                        const duel = activeDuels[chatId];
                        if (duel.timer) clearTimeout(duel.timer);
                        if (duel.graceTimer) clearTimeout(duel.graceTimer);
                        delete activeDuels[chatId];
                        txt += duel.isFish ? "🎣 Fishing duel cancelled.\n" : "🚫 Duel cancelled.\n";
                    }
                    if (!txt) txt = "💤 Nothing to cancel.";
                    await sock.sendMessage(chatId, { text: txt.trim() }, { quoted: msg });
                }

            } catch (err) { console.error("Handler error:", err); }
};
