const fs = require('fs');

let indexCode = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n');

const schedMarker = "    // =======================\n    //   SCHEDULERS\n    // =======================";
const upsertMarker = "    // =======================\n    //   HANDLE MESSAGES\n    // =======================";

let startIndex = indexCode.indexOf(schedMarker);
let endIndex = indexCode.indexOf(upsertMarker);

if (startIndex === -1) startIndex = indexCode.indexOf("//   SCHEDULERS");
if (endIndex === -1) endIndex = indexCode.indexOf("sock.ev.on('messages.upsert'");

if (startIndex === -1 || endIndex === -1) {
    console.error("Markers not found:", startIndex, endIndex);
    process.exit(1);
}

let schedCode = indexCode.substring(startIndex, endIndex);

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
        startSprintSession, TIMEZONE, pushActivity, lastDailyRunDate, setLastDailyRunDate 
    } = appState;

${schedCode}
};
`;

fs.writeFileSync('src/jobs/scheduler.js', schedulerFileTemplate);

const replacement = `    require('./src/jobs/scheduler')({\n        get sock() { return sock; },\n        get isConnected() { return isConnected; },\n        get groupCache() { return groupCache; },\n        getTodayDateGMT1,\n        awardBadge,\n        startSprintSession,\n        TIMEZONE,\n        pushActivity,\n        get lastDailyRunDate() { return lastDailyRunDate; },\n        setLastDailyRunDate: (v) => { lastDailyRunDate = v; }\n    });\n\n`;

indexCode = indexCode.substring(0, startIndex) + replacement + indexCode.substring(endIndex);
fs.writeFileSync('index.js', indexCode);
console.log("Successfully extracted Schedulers!");
