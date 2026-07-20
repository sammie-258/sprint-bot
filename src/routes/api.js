const express = require('express');
const fs = require('fs');
const path = require('path');
const QR = require('qrcode');
const os = require('os');

const UserProfile = require('../models/UserProfile');
const PersonalGoal = require('../models/PersonalGoal');
const DailyStats = require('../models/DailyStats');
const GroupMeta = require('../models/GroupMeta');
const ActiveSprint = require('../models/ActiveSprint');
const ScheduledSprint = require('../models/ScheduledSprint');
const Blacklist = require('../models/Blacklist');
const Feedback = require('../models/Feedback');
const ScheduledBroadcast = require('../models/ScheduledBroadcast');
const SprintRecord = require('../models/SprintRecord');
const StreakFreeze = require('../models/StreakFreeze');

const { getRank, getNextRank, getDurationString } = require('../utils/helpers');

const TIMEZONE = "Africa/Lagos";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const requireAdmin = (req, res, next) => {
    if (req.headers['x-admin-password'] === ADMIN_PASSWORD) return next();
    res.status(403).json({ error: "Unauthorized" });
};

module.exports = function(appState) {
    const { updateGroupCache } = appState;
    const router = express.Router();
    

router.get('/', (req, res) => res.redirect('/sprint-bot-dashboard'));

router.get('/sprint-bot-dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(__dirname, '../../sprint-bot-dashboard (2)'));
});

router.get('/sprint-bot-admin', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(__dirname, '../../sprint-bot-admin (11)'));
});

router.get('/admin', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(__dirname, '../../sprint-bot-admin (11)'));
});

// Profile card
router.get('/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const potentialJids = [
            userId.includes('@') ? userId : userId + '@s.whatsapp.net',
            userId.includes('@') ? userId : userId + '@lid'
        ];
        const profile = await UserProfile.findOne({ userId: { $in: potentialJids } });
        if (!profile) return res.status(404).send(`<h1>Profile Not Found</h1>`);

        const goal      = await PersonalGoal.findOne({ userId: profile.userId, isActive: true });
        const rank      = getRank(profile.totalWordsAllTime);
        const nextRank  = getNextRank(profile.totalWordsAllTime);
        const todayStr  = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const todayAgg  = await DailyStats.aggregate([
            { $match: { userId: profile.userId, date: todayStr } },
            { $group: { _id: null, total: { $sum: "$words" } } }
        ]);
        const dailyWords = todayAgg[0]?.total || 0;

        const templatePath = path.join(__dirname, '../../profile.html');
        if (!fs.existsSync(templatePath)) return res.status(500).send("<h1>Profile Template Missing</h1>");
        let html = fs.readFileSync(templatePath, 'utf8');

        const nextRankPct   = nextRank ? Math.min(100, (profile.totalWordsAllTime / nextRank.threshold) * 100).toFixed(1) : '100';
        const nextRankName  = nextRank ? nextRank.name : 'MAX RANK';
        const nextRankThres = nextRank ? nextRank.threshold.toLocaleString() : '-';

        html = html
            .replace(/{{NAME}}/g, profile.name)
            .replace(/{{INITIAL}}/g, profile.name.charAt(0).toUpperCase())
            .replace(/{{RANK}}/g, rank)
            .replace(/{{TOTAL}}/g, profile.totalWordsAllTime.toLocaleString())
            .replace(/{{STREAK}}/g, profile.currentStreak)
            .replace(/{{DAILY_WORDS}}/g, dailyWords.toLocaleString())
            .replace(/{{BEST_SPRINT_WORDS}}/g, profile.bestSprintWords.toLocaleString())
            .replace(/{{BEST_SPRINT_WPM}}/g, profile.bestSprintWpm)
            .replace(/{{BADGES_JSON}}/g, JSON.stringify(profile.badges || []))
            .replace(/{{ACTIVITY_LOG}}/g, profile.activityLog || '0'.repeat(35))
            .replace(/{{NEXT_RANK_NAME}}/g, nextRankName)
            .replace(/{{NEXT_RANK_PCT}}/g, nextRankPct)
            .replace(/{{NEXT_RANK_THRESHOLD}}/g, nextRankThres);

        if (goal) {
            const pct = Math.min(100, (goal.current / goal.target) * 100).toFixed(1);
            html = html
                .replace('{{GOAL_DISPLAY}}',  'block')
                .replace('{{GOAL_CURRENT}}',  goal.current.toLocaleString())
                .replace('{{GOAL_TARGET}}',   goal.target.toLocaleString())
                .replace('{{GOAL_PERCENT}}',  pct);
        } else {
            html = html.replace('{{GOAL_DISPLAY}}', 'hidden');
        }
        res.send(html);
    } catch (e) { console.error(e); res.status(500).send("Error"); }
});

// Public stats (dashboard)
router.get('/api/stats', async (req, res) => {
    try {
        let qrImage = null;
        if (!appState.isConnected && appState.qrCodeData) qrImage = await QR.toDataURL(appState.qrCodeData);

        const dbGroups = await GroupMeta.find({});
        const groupMap = {};
        dbGroups.forEach(g => groupMap[g.groupId] = g.subject);

        const todayStr       = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const sevenDaysAgo   = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const [topWriters, todayWriters, topGroups, totalWordsAgg, chartDataRaw,
               todayWordAgg, todayActiveUsers, hotGroupRaw, totalWriters, allGroupIds] = await Promise.all([
            DailyStats.aggregate([{ $group: { _id: "$name", total: { $sum: "$words" } } }, { $sort: { total: -1 } }, { $limit: 10 }]),
            DailyStats.aggregate([{ $match: { date: todayStr } }, { $group: { _id: "$name", total: { $sum: "$words" } } }, { $sort: { total: -1 } }, { $limit: 10 }]),
            DailyStats.aggregate([{ $match: { groupId: { $ne: "Manual_Correction" } } }, { $group: { _id: "$groupId", total: { $sum: "$words" } } }, { $sort: { total: -1 } }, { $limit: 10 }]),
            DailyStats.aggregate([{ $group: { _id: null, total: { $sum: "$words" } } }]),
            DailyStats.aggregate([{ $match: { timestamp: { $gte: sevenDaysAgo } } }, { $group: { _id: "$date", total: { $sum: "$words" } } }, { $sort: { _id: 1 } }]),
            DailyStats.aggregate([{ $match: { date: todayStr } }, { $group: { _id: null, total: { $sum: "$words" } } }]),
            DailyStats.distinct("userId", { date: todayStr }),
            DailyStats.aggregate([{ $match: { date: todayStr, groupId: { $ne: "Manual_Correction" } } }, { $group: { _id: "$groupId", total: { $sum: "$words" } } }, { $sort: { total: -1 } }, { $limit: 1 }]),
            DailyStats.distinct("name"),
            DailyStats.distinct("groupId"),
        ]);

        const hotGroup = hotGroupRaw[0] ? { name: groupMap[hotGroupRaw[0]._id] || hotGroupRaw[0]._id, words: hotGroupRaw[0].total } : null;

        res.json({
            isConnected: appState.isConnected, qrCode: qrImage,
            topWriters:   topWriters.map(w => ({ name: w._id, words: w.total })),
            todayWriters: todayWriters.map(w => ({ name: w._id, words: w.total })),
            topGroups:    topGroups.map(g => ({ name: groupMap[g._id] || g._id, words: g.total })),
            totalWords:   totalWordsAgg[0]?.total || 0,
            totalWriters: totalWriters.length,
            totalGroups:  allGroupIds.filter(id => id !== "Manual_Correction").length,
            activeSprintsCount: Object.keys(appState.activeSprints).length,
            chartData: { labels: chartDataRaw.map(d => d._id), data: chartDataRaw.map(d => d.total) },
            todayPulse: { words: todayWordAgg[0]?.total || 0, writers: todayActiveUsers.length, hotGroup },
            recentActivity: appState.recentActivity.slice(0, 10)
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: system info (includes appState.recentActivity + feedback unread count)
router.get('/api/admin/system', requireAdmin, async (req, res) => {
    try {
        const memory = process.memoryUsage();
        const unreadFeedback = await Feedback.countDocuments({ isRead: false });
        res.json({
            uptime:    process.uptime(),
            memory:    Math.round(memory.heapUsed / 1024 / 1024),
            platform:  os.platform() + " " + os.release(),
            cpu:       os.cpus()[0].model,
            maintenance: appState.maintenanceMode,
            activeSprintsCount:    Object.keys(appState.activeSprints).length,
            activeDuelsCount:      Object.keys(appState.activeDuels).length,
            activePomodorosCount:  Object.keys(appState.activePomodoros).length,
            unreadFeedback,
            recentActivity: appState.recentActivity
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/maintenance', requireAdmin, (req, res) => {
    appState.maintenanceMode = req.body.status;
    res.json({ success: true, status: appState.maintenanceMode });
});

router.get('/api/admin/sprints', requireAdmin, async (req, res) => {
    try {
        await updateGroupCache();
        const sprints = Object.entries(appState.activeSprints).map(([chatId, sprint]) => ({
            id: chatId,
            name: appState.groupCache[chatId]?.subject || chatId,
            timeLeft: Math.ceil(Math.max(0, sprint.endsAt - Date.now()) / 60000),
            participants: Object.keys(sprint.participants).length,
            participantList: Object.entries(sprint.participants).map(([uid, d]) => ({ uid: uid.split('@')[0], name: d.name || uid.split('@')[0], words: d.words || 0 }))
        }));
        const duels = Object.entries(appState.activeDuels).map(([chatId, duel]) => ({
            id: chatId,
            name: `⚔️ DUEL: ${duel.challengerName} vs ${duel.opponentName}`,
            timeLeft: Math.ceil(Math.max(0, duel.endsAt - Date.now()) / 60000),
            participants: 2,
            participantList: [
                { uid: duel.challenger.split('@')[0], name: duel.challengerName, words: duel.words[duel.challenger] || 0 },
                { uid: duel.opponent.split('@')[0], name: duel.opponentName, words: duel.words[duel.opponent] || 0 }
            ]
        }));
        res.json([...sprints, ...duels]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/sprints/stop', requireAdmin, async (req, res) => {
    const { chatId } = req.body;
    const sprint = appState.activeSprints[chatId];
    if (sprint) {
        if (sprint.warningTimer) clearTimeout(sprint.warningTimer);
        if (sprint.endTimer) clearTimeout(sprint.endTimer);
        delete appState.activeSprints[chatId];
        await ActiveSprint.deleteOne({ groupId: chatId });
        try { if (appState.sock && appState.isConnected) await appState.sock.sendMessage(chatId, { text: "🛑 *ADMIN STOP*: Sprint cancelled by Admin." }); } catch(e) {}
        return res.json({ success: true });
    }
    res.status(404).json({ error: "Sprint not found" });
});

router.get('/api/admin/scheduled', requireAdmin, async (req, res) => {
    try {
        await updateGroupCache();
        const sprints = await ScheduledSprint.find({ startTime: { $gt: new Date() } }).sort({ startTime: 1 });
        res.json(sprints.map(s => ({
            id: s._id,
            groupName: appState.groupCache[s.groupId]?.subject || s.groupId,
            startTime: s.startTime, duration: s.duration,
            createdBy: s.createdBy ? s.createdBy.split('@')[0] : 'Admin'
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/scheduled/cancel', requireAdmin, async (req, res) => {
    try {
        const sprint = await ScheduledSprint.findById(req.body.id);
        if (sprint && appState.sock && appState.isConnected) {
            try { await appState.sock.sendMessage(sprint.groupId, { text: `🚫 *SCHEDULED SPRINT CANCELLED*\n\nThe upcoming ${sprint.duration}-minute sprint has been cancelled by Admin.` }); } catch (e) {}
        }
        await ScheduledSprint.findByIdAndDelete(req.body.id);
        res.json({ success: true });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Writers: all matching query, no .limit()
router.post('/api/admin/search', requireAdmin, async (req, res) => {
    try {
        const { query, exact } = req.body;
        let filter = { $or: [{ name: { $regex: query || '', $options: 'i' } }, { userId: { $regex: query || '', $options: 'i' } }] };
        if (exact) filter = { userId: query };

        const profiles = await UserProfile.find(filter);
        const blacklisted = new Set(
            (await Blacklist.find({ userId: { $in: profiles.map(p => p.userId) } }, 'userId'))
            .map(b => b.userId)
        );

        const enriched = profiles.map(p => ({
            _id: p.userId, name: p.name,
            totalWords: p.totalWordsAllTime, lastActive: p.lastActiveDate,
            rank: getRank(p.totalWordsAllTime), streak: p.currentStreak,
            bestStreak: p.bestStreak, trueTotal: p.totalWordsAllTime,
            isBanned: blacklisted.has(p.userId),
            isInactive: !!p.isInactive,
            isArchived: !!p.isArchived,
            badges: p.badges || [],
            bestSprintWords: p.bestSprintWords, bestSprintWpm: p.bestSprintWpm,
            sprintCount: p.sprintCount, activityLog: p.activityLog
        }));
        res.json(enriched);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Writer sprint history (for drawer)
router.get('/api/admin/writer/:userId/history', requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const [wordsByDay, goals, recentSprints] = await Promise.all([
            DailyStats.aggregate([
                { $match: { userId, timestamp: { $gte: thirtyDaysAgo } } },
                { $group: { _id: "$date", total: { $sum: "$words" } } },
                { $sort: { _id: 1 } }
            ]),
            PersonalGoal.find({ userId }).sort({ _id: -1 }).limit(5),
            SprintRecord.find({ 'participants.userId': userId }).sort({ timestamp: -1 }).limit(10)
        ]);
        res.json({
            wordsByDay: { labels: wordsByDay.map(d => d._id), data: wordsByDay.map(d => d.total) },
            goals: goals.map(g => ({
                target: g.target, current: g.current, isActive: g.isActive,
                startDate: g.startDate, completedAt: g.completedAt,
                duration: g.completedAt ? getDurationString(g.startedAt, g.completedAt) : null
            })),
            recentSprints: recentSprints.map(sr => {
                const p = sr.participants.find(x => x.userId === userId);
                return { date: sr.timestamp, duration: sr.duration, words: p?.words || 0, wpm: p?.wpm || 0 };
            })
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/update', requireAdmin, async (req, res) => {
    const { userId, amount, type, name } = req.body;
    try {
        if (type === 'streak') {
            const { currentStreak, bestStreak } = req.body;
            await UserProfile.findOneAndUpdate({ userId }, { currentStreak, bestStreak });
            return res.json({ success: true });
        }
        if (type === 'name') {
            await UserProfile.findOneAndUpdate({ userId }, { name });
            await DailyStats.updateMany({ userId }, { name });
            await PersonalGoal.updateMany({ userId }, { name });
            return res.json({ success: true });
        }
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const history  = await DailyStats.findOne({ userId }).sort({ timestamp: -1 });
        let doc = await DailyStats.findOne({ userId, date: todayStr, groupId: history?.groupId || "Manual_Correction" });
        if (!doc) doc = await DailyStats.create({ userId, name: history?.name || userId, groupId: history?.groupId || "Manual_Correction", date: todayStr, words: 0 });
        let diff = 0;
        if (type === 'set') { diff = parseInt(amount) - doc.words; doc.words = parseInt(amount); }
        else { diff = parseInt(amount); doc.words += diff; }
        doc.timestamp = new Date();
        await doc.save();
        await PersonalGoal.findOneAndUpdate({ userId, isActive: true }, { $inc: { current: diff } });
        await UserProfile.findOneAndUpdate({ userId }, { $inc: { totalWordsAllTime: diff } }, { upsert: true });
        res.json({ success: true, newTotal: doc.words });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/ban', requireAdmin, async (req, res) => {
    const { userId, action } = req.body;
    try {
        if (action === 'ban') await Blacklist.findOneAndUpdate({ userId }, { userId }, { upsert: true });
        else await Blacklist.deleteMany({ userId });
        res.json({ success: true, isBanned: action === 'ban' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/writers/inactive', requireAdmin, async (req, res) => {
    const { userId, isInactive } = req.body;
    try {
        await UserProfile.findOneAndUpdate({ userId }, { isInactive });
        res.json({ success: true, isInactive });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/writers/archive', requireAdmin, async (req, res) => {
    const { userId, archive } = req.body;
    try {
        const profile = await UserProfile.findOneAndUpdate({ userId }, { isArchived: !!archive }, { new: true });
        res.json({ success: true, isArchived: profile.isArchived });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
    try {
        const { message, image, targetGroups } = req.body;
        if (!message && !image) return res.status(400).json({ error: "Need text or image" });
        if (!appState.sock || !appState.isConnected) {
            console.log("❌ Broadcast failed: Bot not connected");
            return res.status(503).json({ error: "Bot not connected" });
        }

        // If targetGroups provided, use them; otherwise send to all
        let gids;
        if (targetGroups && Array.isArray(targetGroups) && targetGroups.length > 0) {
            gids = targetGroups;
            console.log(`📣 Targeted broadcast to ${gids.length} selected groups...`);
        } else {
            const groups = await appState.sock.groupFetchAllParticipating();
            gids = Object.keys(groups);
            console.log(`📣 Broadcasting to all ${gids.length} groups...`);
        }

        let count = 0;
        for (const gid of gids) {
            try {
                if (image) {
                    const buffer = Buffer.from(image.split(",")[1], 'base64');
                    await appState.sock.sendMessage(gid, { image: buffer, caption: message || "" });
                } else {
                    await appState.sock.sendMessage(gid, { text: message });
                }
                count++;
                await new Promise(r => setTimeout(r, 500));
            } catch (e) {
                console.log(`⚠️ Failed to send to ${gid}:`, e.message);
            }
        }
        console.log(`✅ Broadcast complete. Sent to ${count} groups.`);
        res.json({ success: true, count });
    } catch (e) { 
        console.error("❌ Broadcast error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

// Admin: Grant streak freeze to a writer
router.post('/api/admin/writers/freeze', requireAdmin, async (req, res) => {
    try {
        const { userId, amount = 1 } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });
        let freeze = await StreakFreeze.findOne({ userId });
        if (!freeze) freeze = await StreakFreeze.create({ userId, freezesAvailable: 0 });
        freeze.freezesAvailable += Number(amount);
        await freeze.save();
        console.log(`🛡️ Admin granted ${amount} freeze(s) to ${userId}. New total: ${freeze.freezesAvailable}`);
        res.json({ success: true, newTotal: freeze.freezesAvailable });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Groups: enriched with health data
router.get('/api/admin/groups', requireAdmin, async (req, res) => {
    try {
        const groups = await GroupMeta.find({});
        const todayStr    = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
        const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const result = await Promise.all(groups.map(async (data) => {
            const jid = data.groupId;
            try {
                const [weekWords, activeWriters, lastSprint] = await Promise.all([
                    DailyStats.aggregate([{ $match: { groupId: jid, timestamp: { $gte: sevenDaysAgo } } }, { $group: { _id: null, total: { $sum: "$words" } } }]),
                    DailyStats.distinct("userId", { groupId: jid, date: todayStr }),
                    SprintRecord.findOne({ groupId: jid }).sort({ timestamp: -1 })
                ]);
                const weekTotal = weekWords[0]?.total || 0;
                const health = weekTotal > 5000 ? 'Active' : weekTotal > 500 ? 'Quiet' : 'Dormant';
                return {
                    id: jid, name: data.subject || jid,
                    participants: data.size || 0,
                    weekWords: weekTotal, activeWritersToday: activeWriters.length,
                    lastSprintAt: lastSprint?.timestamp || null, health
                };
            } catch (err) {
                // Return fallback data so the list doesn't crash
                return {
                    id: jid, name: data.subject || jid,
                    participants: data.size || 0,
                    weekWords: 0, activeWritersToday: 0,
                    lastSprintAt: null, health: 'Dormant'
                };
            }
        }));
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/groups/leave', requireAdmin, async (req, res) => {
    try {
        const { chatId } = req.body;
        if (appState.sock && appState.isConnected) {
            await appState.sock.sendMessage(chatId, { text: "👋 Bot leaving via Admin Console." });
            await appState.sock.groupLeave(chatId);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/groups/accept', requireAdmin, async (req, res) => {
    const { inviteCode } = req.body;
    if (!inviteCode) return res.status(400).json({ error: "Provide invite code." });
    if (!appState.sock || !appState.isConnected) return res.status(503).json({ error: "Bot not connected." });
    try {
        const code    = inviteCode.includes('chat.whatsapp.com/') ? inviteCode.split('chat.whatsapp.com/').pop().trim() : inviteCode.trim();
        const groupId = await appState.sock.groupAcceptInvite(code);
        res.json({ success: true, groupId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Feedback
router.get('/api/admin/feedback', requireAdmin, async (req, res) => {
    try {
        const [items, unreadCount] = await Promise.all([
            Feedback.find().sort({ timestamp: -1 }).limit(100),
            Feedback.countDocuments({ isRead: false })
        ]);
        res.json({ items, unreadCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/feedback/read', requireAdmin, async (req, res) => {
    try {
        const { id } = req.body;
        if (id === 'all') await Feedback.updateMany({}, { isRead: true });
        else await Feedback.findByIdAndUpdate(id, { isRead: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Analytics
router.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    try {
        const range = req.query.range || 'weekly';
        const now = new Date();
        let currentStart, prevStart, windowMs;

        if (range === 'daily') {
            currentStart = new Date(now); currentStart.setDate(currentStart.getDate() - 1); currentStart.setHours(0,0,0,0);
            prevStart = new Date(currentStart); prevStart.setDate(prevStart.getDate() - 1);
            windowMs = 24 * 60 * 60 * 1000;
        } else if (range === 'monthly') {
            currentStart = new Date(now); currentStart.setDate(currentStart.getDate() - 30); currentStart.setHours(0,0,0,0);
            prevStart = new Date(currentStart); prevStart.setDate(prevStart.getDate() - 30);
            windowMs = 30 * 24 * 60 * 60 * 1000;
        } else {
            // Default Weekly
            currentStart = new Date(now); currentStart.setDate(currentStart.getDate() - 7); currentStart.setHours(0,0,0,0);
            prevStart = new Date(currentStart); prevStart.setDate(prevStart.getDate() - 7);
            windowMs = 7 * 24 * 60 * 60 * 1000;
        }

        const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const [wordsByDay, wordsByHour, activeCurrent, activePrev, currentWords, prevWords, groupBreakdown, dbGroups] = await Promise.all([
            DailyStats.aggregate([{ $match: { timestamp: { $gte: thirtyDaysAgo } } }, { $group: { _id: "$date", total: { $sum: "$words" } } }, { $sort: { _id: 1 } }]),
            DailyStats.aggregate([{ $match: { timestamp: { $gte: thirtyDaysAgo } } }, { $group: { _id: { $hour: "$timestamp" }, total: { $sum: "$words" } } }, { $sort: { _id: 1 } }]),
            DailyStats.distinct("userId", { timestamp: { $gte: currentStart } }),
            DailyStats.distinct("userId", { timestamp: { $gte: prevStart, $lt: currentStart } }),
            DailyStats.aggregate([{ $match: { timestamp: { $gte: currentStart } } }, { $group: { _id: "$userId", total: { $sum: "$words" }, name: { $first: "$name" } } }]),
            DailyStats.aggregate([{ $match: { timestamp: { $gte: prevStart, $lt: currentStart } } }, { $group: { _id: "$userId", total: { $sum: "$words" } } }]),
            DailyStats.aggregate([{ $match: { timestamp: { $gte: currentStart }, groupId: { $ne: "Manual_Correction" } } }, { $group: { _id: "$groupId", total: { $sum: "$words" }, writers: { $addToSet: "$userId" } } }, { $sort: { total: -1 } }, { $limit: 10 }]),
            GroupMeta.find({})
        ]);

        const retained      = activeCurrent.filter(u => activePrev.includes(u));
        const retentionRate = activePrev.length > 0 ? Math.round((retained.length / activePrev.length) * 100) : 0;

        const prevMap = {};
        prevWords.forEach(w => prevMap[w._id] = w.total);
        const growers = currentWords
            .map(w => ({ name: w.name, thisPeriod: w.total, lastPeriod: prevMap[w._id] || 0, growth: w.total - (prevMap[w._id] || 0) }))
            .filter(w => w.growth > 0).sort((a, b) => b.growth - a.growth).slice(0, 10);

        const groupMap = {};
        dbGroups.forEach(g => groupMap[g.groupId] = g.subject);

        res.json({
            wordsByDay: { labels: wordsByDay.map(d => d._id), data: wordsByDay.map(d => d.total) },
            wordsByHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, total: wordsByHour.find(x => x._id === h)?.total || 0 })),
            retentionRate, activeCurrent: activeCurrent.length, activePrev: activePrev.length,
            growers,
            groupBreakdown: groupBreakdown.map(g => ({ name: groupMap[g._id] || g._id, words: g.total, writers: g.writers.length }))
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scheduled broadcasts
router.get('/api/admin/broadcasts/scheduled', requireAdmin, async (req, res) => {
    try {
        const items = await ScheduledBroadcast.find({ sent: false, sendAt: { $gt: new Date() } }).sort({ sendAt: 1 });
        res.json(items);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/broadcasts/schedule', requireAdmin, async (req, res) => {
    try {
        const { message, image, sendAt } = req.body;
        if (!message && !image) return res.status(400).json({ error: "Need message or image" });
        if (!sendAt) return res.status(400).json({ error: "Need sendAt time" });
        const broadcast = await ScheduledBroadcast.create({ message, image, sendAt: new Date(sendAt) });
        res.json({ success: true, id: broadcast._id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/broadcasts/cancel', requireAdmin, async (req, res) => {
    try { await ScheduledBroadcast.findByIdAndDelete(req.body.id); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/writers/merge', requireAdmin, async (req, res) => {
    try {
        const { oldUserId, newUserId } = req.body;
        if (!oldUserId || !newUserId) {
            return res.status(400).json({ error: "Missing oldUserId or newUserId" });
        }
        if (oldUserId === newUserId) {
            return res.status(400).json({ error: "Cannot merge a profile into itself" });
        }

        const oldProfile = await UserProfile.findOne({ userId: oldUserId });
        if (!oldProfile) {
            return res.status(404).json({ error: "Old profile not found" });
        }

        let newProfile = await UserProfile.findOne({ userId: newUserId });
        if (!newProfile) {
            newProfile = new UserProfile({
                userId: newUserId,
                name: oldProfile.name,
                currentStreak: oldProfile.currentStreak,
                bestStreak: oldProfile.bestStreak,
                lastActiveDate: oldProfile.lastActiveDate,
                totalWordsAllTime: oldProfile.totalWordsAllTime,
                badges: oldProfile.badges,
                activityLog: oldProfile.activityLog,
                bestSprintWords: oldProfile.bestSprintWords,
                bestSprintWpm: oldProfile.bestSprintWpm,
                sprintCount: oldProfile.sprintCount,
                totalSprintWords: oldProfile.totalSprintWords,
                isInactive: oldProfile.isInactive
            });
        } else {
            newProfile.totalWordsAllTime += oldProfile.totalWordsAllTime;
            newProfile.currentStreak = Math.max(newProfile.currentStreak || 0, oldProfile.currentStreak || 0);
            newProfile.bestStreak = Math.max(newProfile.bestStreak || 0, oldProfile.bestStreak || 0);
            newProfile.sprintCount = (newProfile.sprintCount || 0) + (oldProfile.sprintCount || 0);
            newProfile.totalSprintWords = (newProfile.totalSprintWords || 0) + (oldProfile.totalSprintWords || 0);
            newProfile.bestSprintWords = Math.max(newProfile.bestSprintWords || 0, oldProfile.bestSprintWords || 0);
            newProfile.bestSprintWpm = Math.max(newProfile.bestSprintWpm || 0, oldProfile.bestSprintWpm || 0);
            
            const badgesSet = new Set([...(newProfile.badges || []), ...(oldProfile.badges || [])]);
            newProfile.badges = Array.from(badgesSet);

            let mergedLog = '';
            const log1 = oldProfile.activityLog || '0'.repeat(35);
            const log2 = newProfile.activityLog || '0'.repeat(35);
            for (let i = 0; i < 35; i++) {
                mergedLog += (log1[i] === '1' || log2[i] === '1') ? '1' : '0';
            }
            newProfile.activityLog = mergedLog;

            if (oldProfile.lastActiveDate && (!newProfile.lastActiveDate || oldProfile.lastActiveDate > newProfile.lastActiveDate)) {
                newProfile.lastActiveDate = oldProfile.lastActiveDate;
            }
            newProfile.isInactive = oldProfile.isInactive || newProfile.isInactive;
        }

        await newProfile.save();

        await DailyStats.updateMany({ userId: oldUserId }, { $set: { userId: newUserId } });
        await PersonalGoal.updateMany({ userId: oldUserId }, { $set: { userId: newUserId } });
        await SprintRecord.updateMany({ "participants.userId": oldUserId }, { $set: { "participants.$.userId": newUserId } });

        const oldFreeze = await StreakFreeze.findOne({ userId: oldUserId });
        const newFreeze = await StreakFreeze.findOne({ userId: newUserId });
        if (oldFreeze) {
            if (newFreeze) {
                newFreeze.freezesAvailable += oldFreeze.freezesAvailable;
                if (oldFreeze.lastEarnedDate && (!newFreeze.lastEarnedDate || oldFreeze.lastEarnedDate > newFreeze.lastEarnedDate)) {
                    newFreeze.lastEarnedDate = oldFreeze.lastEarnedDate;
                }
                await newFreeze.save();
                await StreakFreeze.deleteOne({ userId: oldUserId });
            } else {
                await StreakFreeze.updateOne({ userId: oldUserId }, { $set: { userId: newUserId } });
            }
        }

        const oldBlacklist = await Blacklist.findOne({ userId: oldUserId });
        if (oldBlacklist) {
            const newBlacklist = await Blacklist.findOne({ userId: newUserId });
            if (!newBlacklist) {
                await Blacklist.create({ userId: newUserId });
            }
            await Blacklist.deleteOne({ userId: oldUserId });
        }

        await UserProfile.deleteOne({ userId: oldUserId });

        if (appState.pushActivity) {
            appState.pushActivity('admin', `Merged identity ${oldUserId.split('@')[0]} to ${newUserId.split('@')[0]}`, '🔄');
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


    return router;
};
