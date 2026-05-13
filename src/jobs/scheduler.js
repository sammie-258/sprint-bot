const cron = require('node-cron');
const GroupMeta = require('../models/GroupMeta');
const ScheduledSprint = require('../models/ScheduledSprint');
const ScheduledBroadcast = require('../models/ScheduledBroadcast');
const DailyStats = require('../models/DailyStats');
const UserProfile = require('../models/UserProfile');
const GroupChallenge = require('../models/GroupChallenge');
const WeeklyChallenge = require('../models/WeeklyChallenge');
const StreakFreeze = require('../models/StreakFreeze');
const { getRank, getMaxFreezes } = require('../utils/helpers');

module.exports = function(appState) {
    const { 
        sock, isConnected, groupCache, getTodayDateGMT1, awardBadge, 
        startSprintSession, TIMEZONE, pushActivity
    } = appState;
    let lastDailyRunDate = "";

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

};
