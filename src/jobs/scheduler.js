const cron = require('node-cron');
const GroupMeta = require('../models/GroupMeta');
const ScheduledSprint = require('../models/ScheduledSprint');
const ScheduledBroadcast = require('../models/ScheduledBroadcast');
const DailyStats = require('../models/DailyStats');
const UserProfile = require('../models/UserProfile');
const WeeklyChallenge = require('../models/WeeklyChallenge');
const StreakFreeze = require('../models/StreakFreeze');
const { getRank, getMaxFreezes } = require('../utils/helpers');

module.exports = function(appState) {
    const { getTodayDateGMT1, awardBadge, startSprintSession, TIMEZONE, pushActivity } = appState;

    // Helper for Lagos time
    const getLagosDate = () => new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));

    // ==========================================
    // 1. MINUTELY CHECKER (Sprints & Broadcasts)
    // ==========================================
    cron.schedule('* * * * *', async () => {
        if (!appState.isConnected || !appState.sock) return;
        
        // --- Scheduled Sprints ---
        try {
            const dueSprints = await ScheduledSprint.find({ startTime: { $lte: new Date() } });
            for (const sprint of dueSprints) {
                const started = await startSprintSession(sprint.groupId, sprint.duration);
                if (started) {
                    await appState.sock.sendMessage(sprint.groupId, { 
                        text: `(Scheduled by @${sprint.createdBy.split('@')[0]})`, 
                        mentions: [sprint.createdBy] 
                    });
                }
                await ScheduledSprint.deleteOne({ _id: sprint._id });
            }
        } catch (e) { console.error("Sprint scheduler error:", e); }

        // --- Scheduled Broadcasts ---
        try {
            const dueBroadcasts = await ScheduledBroadcast.find({ sent: false, sendAt: { $lte: new Date() } });
            for (const broadcast of dueBroadcasts) {
                const groups = await appState.sock.groupFetchAllParticipating();
                console.log(`📢 Sending scheduled broadcast to ${Object.keys(groups).length} groups...`);
                
                for (const gid of Object.keys(groups)) {
                    try {
                        if (broadcast.image) {
                            const buffer = Buffer.from(broadcast.image.split(",")[1], 'base64');
                            await appState.sock.sendMessage(gid, { image: buffer, caption: broadcast.message || "" });
                        } else {
                            await appState.sock.sendMessage(gid, { text: broadcast.message });
                        }
                        await new Promise(r => setTimeout(r, 500));
                    } catch (e) {}
                }
                broadcast.sent = true;
                await broadcast.save();
                pushActivity('broadcast', 'Scheduled broadcast delivered', '📢');
            }
        } catch (e) { console.error("Broadcast scheduler error:", e); }
    }, { timezone: TIMEZONE });

    // ==========================================
    // 2. STREAK REMINDER (23:00)
    // ==========================================
    cron.schedule('0 23 * * *', async () => {
        if (!appState.isConnected || !appState.sock) return;
        try {
            const today = getTodayDateGMT1();

            // At risk = Anyone with a streak who hasn't logged words today
            const activeToday = new Set(await DailyStats.distinct("userId", { date: today }));
            const rawAtRiskProfiles = await UserProfile.find({ 
                currentStreak: { $gt: 0 },
                lastActiveDate: { $ne: today }, // Haven't updated streak today
                isInactive: { $ne: true },      // Skip inactive writers
                isArchived: { $ne: true }       // Skip archived writers
            });

            const atRiskProfiles = rawAtRiskProfiles.filter(p => !activeToday.has(p.userId));

            console.log(`🔥 Streak Reminder: ${atRiskProfiles.length} authors at risk...`);
            pushActivity('system', `Running streak reminder for ${atRiskProfiles.length} authors`, '🔥');

            if (!atRiskProfiles.length) return;

            // Map each user to their most recent active group
            const atRiskUserIds = atRiskProfiles.map(p => p.userId);
            const recentStats = await DailyStats.aggregate([
                { $match: { userId: { $in: atRiskUserIds } } },
                { $sort: { timestamp: -1 } },
                { $group: {
                    _id: "$userId",
                    groupId: { $first: "$groupId" }
                }}
            ]);

            const userGroupMap = new Map();
            recentStats.forEach(r => {
                if (r.groupId && r.groupId !== "Manual_Correction") {
                    userGroupMap.set(r._id, r.groupId);
                }
            });

            const groupsFromDB = await GroupMeta.find({}, 'groupId');
            const defaultGroup = groupsFromDB[0]?.groupId;

            const groupAtRiskMap = new Map();
            for (const profile of atRiskProfiles) {
                const targetGroup = userGroupMap.get(profile.userId) || defaultGroup;
                if (!targetGroup) continue;
                if (!groupAtRiskMap.has(targetGroup)) {
                    groupAtRiskMap.set(targetGroup, []);
                }
                groupAtRiskMap.get(targetGroup).push(profile);
            }

            let sentCount = 0;
            for (const [gid, profiles] of groupAtRiskMap.entries()) {
                if (!profiles.length) continue;

                const listText = profiles.map(p => `- @${p.userId.split('@')[0]} (${p.currentStreak}-day streak 🔥)`).join('\n');
                const mentions = profiles.map(p => p.userId);

                const txt = `⚠️ *STREAK AT RISK!* ⚠️\n━━━━━━━━━━━━━━━━\nThe following writers have less than 1 hour to log their words or risk losing their streaks:\n${listText}\n\nType *!log [number]* or start a *!sprint* NOW! ✍️`;

                try {
                    await appState.sock.sendMessage(gid, { text: txt, mentions });
                    sentCount += profiles.length;
                    await new Promise(r => setTimeout(r, 500));
                } catch (e) {
                    console.error(`Error sending streak reminder to group ${gid}:`, e.message);
                }
            }

            pushActivity('system', `Streak reminders delivered to ${sentCount} authors`, '📢');
        } catch (e) { console.error("Streak reminder job error:", e); }
    }, { timezone: TIMEZONE });

    // ==========================================
    // 3. MVP ANNOUNCEMENTS (23:55)
    // ==========================================
    cron.schedule('55 23 * * *', async () => {
        if (!appState.isConnected || !appState.sock) return;
        try {
            const lagos = getLagosDate();
            const today = getTodayDateGMT1();
            const dayOfWeek = lagos.getDay(); // 0 = Sunday
            const groupsFromDB = await GroupMeta.find({}, 'groupId');
            const groupIds = groupsFromDB.map(g => g.groupId);

            console.log("🌟 Running Daily MVP Announcements...");

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
                    
                    await appState.sock.sendMessage(gid, { text: txt, mentions: top.map(w => w._id) });
                    const mvpProfile = await UserProfile.findOne({ userId: top[0]._id });
                    if (mvpProfile) await awardBadge(mvpProfile, 'daily_first', gid);
                    await new Promise(r => setTimeout(r, 500));
                } catch (e) {}
            }

            // --- WEEKLY (Sundays) ---
            if (dayOfWeek === 0) {
                console.log("🏆 Running Weekly MVP Announcements...");
                const dates = Array.from({ length: 7 }, (_, i) => { 
                    const d = new Date(lagos); d.setDate(d.getDate() - i); 
                    return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); 
                });

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
                        
                        await appState.sock.sendMessage(gid, { text: txt, mentions: top.map(w => w._id) });
                        await new Promise(r => setTimeout(r, 500));
                    } catch (e) {}
                }

                // Resolve expired weekly challenges
                const expired = await WeeklyChallenge.find({ resolved: false, weekEnd: { $lte: lagos } });
                for (const wc of expired) {
                    if (wc.current < wc.target) {
                        const pct = Math.round((wc.current / wc.target) * 100);
                        try {
                            await appState.sock.sendMessage(wc.groupId, {
                                text: `😤 *WEEKLY BOSS SURVIVED!*\n━━━━━━━━━━━━━━━━\n👹 Boss needed *${wc.target.toLocaleString()}* words.\nYou reached *${wc.current.toLocaleString()}* (${pct}%).\n\nThe boss returns Monday — STRONGER. 💀`
                            });
                        } catch (e) {}
                    }
                    wc.resolved = true;
                    await wc.save();
                }
            }

            // --- MONTHLY (Last day of month) ---
            const tomorrow = new Date(lagos); tomorrow.setDate(tomorrow.getDate() + 1);
            if (tomorrow.getDate() === 1) {
                console.log("🎖️ Running Monthly MVP Announcements...");
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
                        await appState.sock.sendMessage(gid, { text: txt, mentions: top.map(w => w._id) });
                        await new Promise(r => setTimeout(r, 500));
                    } catch (e) {}
                }
            }

            // --- YEARLY (Dec 31) ---
            if (lagos.getDate() === 31 && lagos.getMonth() === 11) {
                console.log("🎊 Running Yearly MVP Announcements...");
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
                        await appState.sock.sendMessage(gid, { text: txt, mentions: top.map(w => w._id) });
                        await new Promise(r => setTimeout(r, 500));
                    } catch (e) {}
                }
            }
        } catch (e) { console.error("MVP Job error:", e); }
    }, { timezone: TIMEZONE });

    // ==========================================
    // 4. FREEZE PROCESSOR (00:00)
    // ==========================================
    cron.schedule('0 0 * * *', async () => {
        if (!appState.isConnected || !appState.sock) return;
        try {
            const lagos = getLagosDate();
            const today = getTodayDateGMT1();
            const yesterday = (() => { 
                const d = new Date(lagos); d.setDate(d.getDate() - 1); 
                return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); 
            })();

            const allProfiles = await UserProfile.find({ currentStreak: { $gt: 0 }, isArchived: { $ne: true } });
            const activeYest  = new Set(await DailyStats.distinct("userId", { date: yesterday }));

            console.log(`🛡️ Freeze Processor: Checking streaks for ${allProfiles.length} users...`);

            for (const profile of allProfiles) {
                if (activeYest.has(profile.userId)) {
                    // Wrote yesterday — check if earned a freeze (every 7 days)
                    if (profile.currentStreak % 7 === 0) {
                        const rank = getRank(profile.totalWordsAllTime);
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
                                    if (recent?.groupId) {
                                        await appState.sock.sendMessage(recent.groupId, {
                                            text: `🛡️ *STREAK FREEZE EARNED!*\n\n@${profile.userId.split('@')[0]} hit a *${profile.currentStreak}-day streak milestone!*\nYou now have *${freeze.freezesAvailable}/${maxFreezes}* freeze${freeze.freezesAvailable !== 1 ? 's' : ''}.\n\nUse *!streak freeze* on a missed day to protect your streak.`,
                                            mentions: [profile.userId]
                                        });
                                    }
                                } catch (e) {}
                            }
                        }
                    }
                } else {
                    // Manual freeze check: if they manual-froze or wrote today, lastActiveDate is already yesterday or today
                    if (profile.lastActiveDate === yesterday || profile.lastActiveDate === today) {
                        continue;
                    }

                    // Missed yesterday — auto-burn freeze
                    const freeze = await StreakFreeze.findOne({ userId: profile.userId });
                    if (freeze && freeze.freezesAvailable > 0) {
                        freeze.freezesAvailable -= 1;
                        await freeze.save();
                        profile.lastActiveDate = yesterday; // Protect the streak
                        await profile.save();
                        try {
                            const recent = await DailyStats.findOne({ userId: profile.userId }).sort({ timestamp: -1 });
                            if (recent?.groupId) {
                                await appState.sock.sendMessage(recent.groupId, {
                                    text: `🛡️ *FREEZE AUTO-USED!* \n\n@${profile.userId.split('@')[0]}, a freeze protected your *${profile.currentStreak}-day streak!*\n${freeze.freezesAvailable} freeze${freeze.freezesAvailable !== 1 ? 's' : ''} remaining.`,
                                    mentions: [profile.userId]
                                });
                            }
                        } catch (e) {}
                    } else {
                        // NO FREEZES LEFT — Streak is broken! Reset to 0
                        profile.currentStreak = 0;
                        await profile.save();
                    }
                }
            }
        } catch (e) { console.error("Freeze Processor error:", e); }
    }, { timezone: TIMEZONE });

    // ==========================================
    // 5. WEEKLY BOSS SPAWN (Monday 00:01)
    // ==========================================
    cron.schedule('1 0 * * 1', async () => {
        if (!appState.isConnected || !appState.sock) return;
        try {
            const lagos = getLagosDate();
            const groupsFromDB = await GroupMeta.find({}, 'groupId');
            const groupIds = groupsFromDB.map(g => g.groupId);

            console.log("⚔️ Spawning New Weekly Bosses...");

            for (const gid of groupIds) {
                try {
                    const existing = await WeeklyChallenge.findOne({ groupId: gid, resolved: false });
                    if (existing) continue;
                    
                    const lastWeekAgo = new Date(lagos); lastWeekAgo.setDate(lastWeekAgo.getDate() - 7);
                    const lastStat    = await DailyStats.aggregate([{ $match: { groupId: gid, timestamp: { $gte: lastWeekAgo } } }, { $group: { _id: null, total: { $sum: "$words" } } }]);
                    const target      = Math.max(1000, Math.round((lastStat[0]?.total || 0) * 1.1));
                    const weekEnd     = new Date(lagos); weekEnd.setDate(weekEnd.getDate() + 7);
                    
                    await WeeklyChallenge.create({ 
                        groupId: gid, target, current: 0, contributors: {}, 
                        weekStart: new Date(lagos), weekEnd 
                    });
                    
                    await appState.sock.sendMessage(gid, {
                        text: `⚔️ *WEEKLY BOSS SPAWNED!* ⚔️\n━━━━━━━━━━━━━━━━\n👹 This week's target: *${target.toLocaleString()} words*\n📅 You have 7 days to defeat it!\n\nEvery *!log* and sprint counts. Let's go! 🔥`
                    });
                } catch (e) {}
            }
        } catch (e) { console.error("Weekly boss spawn error:", e); }
    }, { timezone: TIMEZONE });

};
