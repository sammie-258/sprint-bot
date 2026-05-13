const fs = require('fs');

let codeLines = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n').split('\n');

// 0-indexed, so lines 472 to the end of initializeBot()
// initializeBot ends at the line containing "    };" right before "    initializeBot();"

const startIndex = 471; // line 472 is "        sock.ev.on('messages.upsert', async (m) => {"
let endIndex = -1;
for (let i = startIndex; i < codeLines.length; i++) {
    if (codeLines[i] === "    };" && codeLines[i+1] === "" && codeLines[i+2] === "    initializeBot();") {
        endIndex = i;
        break;
    }
}

if (endIndex === -1) {
    console.error("End index not found!");
    process.exit(1);
}

// We extract just the inside of the callback:
// The first line is `        sock.ev.on('messages.upsert', async (m) => {`
// The last line is `        });`

const handlerCodeLines = codeLines.slice(startIndex + 1, endIndex - 1);

const handlerFileTemplate = `const GroupMeta = require('../models/GroupMeta');
const DailyStats = require('../models/DailyStats');
const UserProfile = require('../models/UserProfile');
const PersonalGoal = require('../models/PersonalGoal');
const ScheduledSprint = require('../models/ScheduledSprint');
const Blacklist = require('../models/Blacklist');
const Feedback = require('../models/Feedback');
const { getDurationString, getNextRank, getRank } = require('../utils/helpers');

module.exports = async function(m, appState) {
    const { 
        sock, isConnected, groupCache, maintenanceMode, activeSprints, activePomodoros, activeDuels,
        getTodayDateGMT1, awardBadge, checkAndAwardBadges, updateStreak, updateChallenge, updateWeeklyChallenge,
        startSprintSession, finishSprint, pushActivity
    } = appState;

${handlerCodeLines.join('\n')}
};
`;

fs.writeFileSync('src/handlers/messageHandler.js', handlerFileTemplate);

// Replace the block with the require call
const replacement = `        const messageHandler = require('./src/handlers/messageHandler');
        sock.ev.on('messages.upsert', async (m) => {
            await messageHandler(m, {
                sock, isConnected, groupCache, maintenanceMode, activeSprints, activePomodoros, activeDuels,
                getTodayDateGMT1, awardBadge, checkAndAwardBadges, updateStreak, updateChallenge, updateWeeklyChallenge,
                startSprintSession, finishSprint, pushActivity
            });
        });`;

codeLines.splice(startIndex, endIndex - startIndex, replacement);

fs.writeFileSync('index.js', codeLines.join('\n'));
console.log("Successfully extracted message handler!");
