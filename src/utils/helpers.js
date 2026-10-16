const toSuperscript = (num) => {
    const map = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
    return num.toString().split('').map(d => map[d]).join('');
};

const getRank = (total) => {
    if (total >= 20000000) return "Cosmic Creator 🌌";
    if (total >= 10000000) return "Mythic Wordsmith 👑";
    if (total >= 5000000)  return "Legendary Scribe 🌟";
    if (total >= 1000000) return "Novel God ⚡";
    if (total >= 500000)  return "Word Expert 🎓";
    if (total >= 250000)  return "Word Architect 🏗️";
    if (total >= 100000)  return "Prolific Writer 📚";
    if (total >= 50000)   return "Novelist 📘";
    if (total >= 10000)   return "Aspiring Author ✍️";
    return "Unranked ⚪";
};

const getNextRank = (total) => {
    if (total < 10000)    return { name: "Aspiring Author ✍️", threshold: 10000 };
    if (total < 50000)    return { name: "Novelist 📘",         threshold: 50000 };
    if (total < 100000)   return { name: "Prolific Writer 📚",  threshold: 100000 };
    if (total < 250000)   return { name: "Word Architect 🏗️",  threshold: 250000 };
    if (total < 500000)   return { name: "Word Expert 🎓",      threshold: 500000 };
    if (total < 1000000)  return { name: "Novel God ⚡",         threshold: 1000000 };
    if (total < 5000000)  return { name: "Legendary Scribe 🌟",  threshold: 5000000 };
    if (total < 10000000) return { name: "Mythic Wordsmith 👑",  threshold: 10000000 };
    if (total < 20000000) return { name: "Cosmic Creator 🌌",  threshold: 20000000 };
    return null;
};

// Max streak freezes by rank
const getMaxFreezes = (rank) => {
    if (rank === "Cosmic Creator 🌌" || rank === "Mythic Wordsmith 👑" || rank === "Legendary Scribe 🌟" || rank === "Novel God ⚡") return 5;
    if (rank === "Word Expert 🎓" || rank === "Word Architect 🏗️") return 3;
    if (rank === "Prolific Writer 📚" || rank === "Novelist 📘") return 2;
    if (rank === "Aspiring Author ✍️") return 1;
    return 0; // Unranked gets 0
};

const getDurationString = (startDate, endDate = new Date()) => {
    const diffMs   = new Date(endDate) - new Date(startDate);
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHrs  = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (diffDays > 0) return `${diffDays} day${diffDays !== 1 ? 's' : ''}${diffHrs > 0 ? ` ${diffHrs}h` : ''}`;
    if (diffHrs  > 0) return `${diffHrs} hour${diffHrs !== 1 ? 's' : ''}`;
    return "less than an hour";
};

// Badge definitions
const BADGE_DEFS = [
    { key: 'first_log',     icon: '✍️',  label: 'First Words',    desc: 'Logged your first words' },
    { key: 'streak_7',      icon: '🔥',  label: '7-Day Streak',   desc: '7 consecutive writing days' },
    { key: 'streak_30',     icon: '🌟',  label: '30-Day Streak',  desc: '30 consecutive writing days' },
    { key: 'streak_100',    icon: '💎',  label: '100-Day Streak', desc: '100 consecutive writing days' },
    { key: 'words_10k',     icon: '📝',  label: '10K Club',       desc: 'Wrote 10,000 total words' },
    { key: 'words_100k',    icon: '📚',  label: '100K Club',      desc: 'Wrote 100,000 total words' },
    { key: 'words_250k',    icon: '🏗️',  label: '250K Club',      desc: 'Wrote 250,000 total words' },
    { key: 'words_500k',    icon: '🎓',  label: '500K Club',      desc: 'Wrote 500,000 total words' },
    { key: 'novel_god',     icon: '⚡',  label: 'Novel God',      desc: 'Reached 1,000,000 words' },
    { key: 'words_5m',      icon: '🌟',  label: '5M Club',        desc: 'Wrote 5,000,000 total words' },
    { key: 'words_10m',     icon: '👑',  label: '10M Club',       desc: 'Wrote 10,000,000 total words' },
    { key: 'words_20m',     icon: '🌌',  label: '20M Club',       desc: 'Wrote 20,000,000 total words' },
    { key: 'bot_anniversary', icon: '🎂', label: 'Bot Anniversary', desc: '1 year of using the bot' },
    { key: 'challenge_mvp', icon: '🏆',  label: 'Challenge MVP',  desc: 'Top contributor in a challenge' },
    { key: 'daily_first',   icon: '🥇',  label: 'Daily Champ',    desc: 'Topped the daily leaderboard' },
    { key: 'duel_win',      icon: '⚔️',  label: 'Duelist',        desc: 'Won a word duel' },
    { key: 'sprint_500',    icon: '💨',  label: 'Speed Writer',   desc: 'Wrote 500+ words in one sprint' },
];

// Date helpers for GMT+1 (Africa/Lagos, UTC+1)
const getLagosDate = (ms = Date.now()) => {
    const time = (ms instanceof Date) ? ms.getTime() : Number(ms || Date.now());
    return new Date(time + 3600000);
};

const getLagosDateString = (ms = Date.now()) => {
    const time = (ms instanceof Date) ? ms.getTime() : Number(ms || Date.now());
    const d = new Date(time + 3600000);
    return d.toISOString().slice(0, 10);
};

const getCurrentLagosWeekDates = (ms = Date.now()) => {
    const lagos = getLagosDate(ms);
    const day = lagos.getUTCDay(); // 0 is Sunday, 1 is Monday...
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    const mondayMs = lagos.getTime() + diffToMonday * 86400000;
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(mondayMs + i * 86400000);
        dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
};

const getCurrentLagosMonthPrefix = (ms = Date.now()) => {
    const lagos = getLagosDate(ms);
    const y = lagos.getUTCFullYear();
    const m = String(lagos.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
};

const getLagosMonthName = (ms = Date.now()) => {
    const MONTH_NAMES = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const time = (ms instanceof Date) ? ms.getTime() : Number(ms || Date.now());
    const d = new Date(time + 3600000);
    return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

// Check and update goals when words are logged
const checkAndUpdateGoals = async (userId, count, userName, todayStr) => {
    const PersonalGoal = require('../models/PersonalGoal');
    const DailyStats = require('../models/DailyStats');

    const result = {
        logMessages: [],
        sprintMessages: []
    };

    if (!userId || !count || count <= 0) return result;

    const goals = await PersonalGoal.find({ userId, isActive: true });
    if (!goals || goals.length === 0) return result;

    const todayDate = todayStr || getLagosDateString();
    const weekDates = getCurrentLagosWeekDates();
    const monthPrefix = getCurrentLagosMonthPrefix();

    for (const g of goals) {
        const target = g.target;
        if (!target || target <= 0) continue;

        if (g.type === 'day') {
            const agg = await DailyStats.aggregate([
                { $match: { userId, date: todayDate } },
                { $group: { _id: null, total: { $sum: "$words" } } }
            ]);
            const wordsAfter = agg[0]?.total || 0;
            const wordsBefore = Math.max(0, wordsAfter - count);

            if (wordsBefore < target * 0.5 && wordsAfter >= target * 0.5) {
                result.logMessages.push(`🎯 *DAILY GOAL: 50% REACHED!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()} words) 💪`);
                result.sprintMessages.push(`🎯 *50% Daily Goal!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()})`);
            }
            if (wordsBefore < target && wordsAfter >= target) {
                result.logMessages.push(`🎉 *DAILY GOAL CRUSHED!* Smashed *${target.toLocaleString()} words* today! 🏆`);
                result.sprintMessages.push(`🎉 *Daily Goal Crushed!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()})`);
            }
        } else if (g.type === 'week') {
            const agg = await DailyStats.aggregate([
                { $match: { userId, date: { $in: weekDates } } },
                { $group: { _id: null, total: { $sum: "$words" } } }
            ]);
            const wordsAfter = agg[0]?.total || 0;
            const wordsBefore = Math.max(0, wordsAfter - count);

            if (wordsBefore < target * 0.5 && wordsAfter >= target * 0.5) {
                result.logMessages.push(`🎯 *WEEKLY GOAL: 50% REACHED!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()} words) 💪`);
                result.sprintMessages.push(`🎯 *50% Weekly Goal!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()})`);
            }
            if (wordsBefore < target && wordsAfter >= target) {
                result.logMessages.push(`🏆 *WEEKLY GOAL CRUSHED!* Smashed *${target.toLocaleString()} words* this week! ⚡`);
                result.sprintMessages.push(`🏆 *Weekly Goal Crushed!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()})`);
            }
        } else if (g.type === 'month') {
            const agg = await DailyStats.aggregate([
                { $match: { userId, date: { $regex: '^' + monthPrefix } } },
                { $group: { _id: null, total: { $sum: "$words" } } }
            ]);
            const wordsAfter = agg[0]?.total || 0;
            const wordsBefore = Math.max(0, wordsAfter - count);

            if (wordsBefore < target * 0.5 && wordsAfter >= target * 0.5) {
                result.logMessages.push(`🎯 *MONTHLY GOAL: 50% REACHED!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()} words) 💪`);
                result.sprintMessages.push(`🎯 *50% Monthly Goal!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()})`);
            }
            if (wordsBefore < target && wordsAfter >= target) {
                result.logMessages.push(`🌟 *MONTHLY GOAL CRUSHED!* Smashed *${target.toLocaleString()} words* this month! 👑`);
                result.sprintMessages.push(`🌟 *Monthly Goal Crushed!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()})`);
            }
        } else {
            // 'open' or indefinite
            const wordsBefore = g.current || 0;
            g.current = wordsBefore + count;
            const wordsAfter = g.current;

            if (wordsBefore < target * 0.5 && wordsAfter >= target * 0.5 && !g.milestone50Hit) {
                g.milestone50Hit = true;
                result.logMessages.push(`🎯 *GOAL: 50% REACHED!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()} words) 💪`);
                result.sprintMessages.push(`🎯 *50% Goal Milestone!* (${wordsAfter.toLocaleString()} / ${target.toLocaleString()})`);
            }

            if (wordsAfter >= target) {
                g.isActive = false;
                g.completedAt = new Date();
                result.logMessages.push(`🎉 *GOAL ACHIEVED!* Smashed *${target.toLocaleString()} words* in ${getDurationString(g.startedAt)}! 🏆`);
                result.sprintMessages.push(`🎉 *Goal Achieved!* (${target.toLocaleString()} words smashed!)`);
            }
            await g.save();
        }
    }

    return result;
};

// Retrieve active goals formatted with progress
const getActiveGoalsProgress = async (userId, todayStr) => {
    const PersonalGoal = require('../models/PersonalGoal');
    const DailyStats = require('../models/DailyStats');

    const goals = await PersonalGoal.find({ userId, isActive: true });
    if (!goals || goals.length === 0) return [];

    // Sort order: Today -> Week -> Month -> Open Goal
    const typeOrder = { day: 1, week: 2, month: 3, open: 4 };
    goals.sort((a, b) => (typeOrder[a.type || 'open'] || 4) - (typeOrder[b.type || 'open'] || 4));

    const todayDate = todayStr || getLagosDateString();
    const weekDates = getCurrentLagosWeekDates();
    const monthPrefix = getCurrentLagosMonthPrefix();

    const result = [];

    for (const g of goals) {
        let current = 0;
        let label = 'Open Goal';
        let icon = '📖';

        if (g.type === 'day') {
            label = 'Today';
            icon = '📅';
            const agg = await DailyStats.aggregate([
                { $match: { userId, date: todayDate } },
                { $group: { _id: null, total: { $sum: "$words" } } }
            ]);
            current = agg[0]?.total || 0;
        } else if (g.type === 'week') {
            label = 'Week';
            icon = '🗓️';
            const agg = await DailyStats.aggregate([
                { $match: { userId, date: { $in: weekDates } } },
                { $group: { _id: null, total: { $sum: "$words" } } }
            ]);
            current = agg[0]?.total || 0;
        } else if (g.type === 'month') {
            label = 'Month';
            icon = '📆';
            const agg = await DailyStats.aggregate([
                { $match: { userId, date: { $regex: '^' + monthPrefix } } },
                { $group: { _id: null, total: { $sum: "$words" } } }
            ]);
            current = agg[0]?.total || 0;
        } else {
            label = 'Open Goal';
            icon = '📖';
            current = g.current || 0;
        }

        const rawPct = (current / g.target) * 100;
        const pct = Math.min(100, Math.max(0, rawPct));
        const bar = "🟩".repeat(Math.round(pct / 10)) + "⬜".repeat(10 - Math.round(pct / 10));

        result.push({
            id: g._id,
            type: g.type,
            label,
            icon,
            target: g.target,
            current,
            pct: pct.toFixed(1),
            rawPct,
            bar,
            startedAt: g.startedAt,
            startDate: g.startDate
        });
    }

    return result;
};

module.exports = {
    toSuperscript,
    getRank,
    getNextRank,
    getMaxFreezes,
    getDurationString,
    getLagosDate,
    getLagosDateString,
    getCurrentLagosWeekDates,
    getCurrentLagosMonthPrefix,
    getLagosMonthName,
    checkAndUpdateGoals,
    getActiveGoalsProgress,
    BADGE_DEFS
};
