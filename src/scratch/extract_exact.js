const fs = require('fs');

let codeLines = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n').split('\n');

// 0-indexed, so lines 406 to 664 is index 405 to 663
const schedCodeLines = codeLines.slice(405, 663);

const schedulerFileTemplate = `const cron = require('node-cron');
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

${schedCodeLines.join('\n')}
};
`;

fs.writeFileSync('src/jobs/scheduler.js', schedulerFileTemplate);

// Replace lines 405 to 663 with a require
codeLines.splice(405, 259, `    require('./src/jobs/scheduler')({\n        get sock() { return sock; },\n        get isConnected() { return isConnected; },\n        get groupCache() { return groupCache; },\n        getTodayDateGMT1,\n        awardBadge,\n        startSprintSession,\n        TIMEZONE,\n        pushActivity\n    });`);

fs.writeFileSync('index.js', codeLines.join('\n'));
console.log("Successfully extracted Schedulers with exact line numbers!");
