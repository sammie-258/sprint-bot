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
const getLagosDateString = (ms = Date.now()) => {
    const time = (ms instanceof Date) ? ms.getTime() : Number(ms || Date.now());
    const d = new Date(time + 3600000);
    return d.toISOString().slice(0, 10);
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

module.exports = {
    toSuperscript,
    getRank,
    getNextRank,
    getMaxFreezes,
    getDurationString,
    getLagosDateString,
    getLagosMonthName,
    BADGE_DEFS
};
