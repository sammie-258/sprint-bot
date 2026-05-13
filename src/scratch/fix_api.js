const fs = require('fs');

let apiCode = fs.readFileSync('src/routes/api.js', 'utf8');

// Remove destructuring
const destructureApi = "    const { sock, isConnected, qrCodeData, maintenanceMode, groupCache, activeSprints, activePomodoros, activeDuels, pushActivity, updateGroupCache } = appState;";
apiCode = apiCode.replace(destructureApi, "    const { updateGroupCache, pushActivity } = appState;");

// Replace primitives with appState.*
apiCode = apiCode.replace(/\bsock\b/g, 'appState.sock');
apiCode = apiCode.replace(/\bisConnected\b/g, 'appState.isConnected');
apiCode = apiCode.replace(/\bqrCodeData\b/g, 'appState.qrCodeData');
apiCode = apiCode.replace(/\bmaintenanceMode\b/g, 'appState.maintenanceMode');
apiCode = apiCode.replace(/\bgroupCache\b/g, 'appState.groupCache');
apiCode = apiCode.replace(/\bactiveSprints\b/g, 'appState.activeSprints');
apiCode = apiCode.replace(/\bactivePomodoros\b/g, 'appState.activePomodoros');
apiCode = apiCode.replace(/\bactiveDuels\b/g, 'appState.activeDuels');
apiCode = apiCode.replace(/\brecentActivity\b/g, 'appState.recentActivity');

// Fix 'appState.appState.sock' if any
apiCode = apiCode.replace(/appState\.appState\./g, 'appState.');

fs.writeFileSync('src/routes/api.js', apiCode);

let schedCode = fs.readFileSync('src/jobs/scheduler.js', 'utf8');
const destructureSched = `    const { \n        sock, isConnected, groupCache, getTodayDateGMT1, awardBadge, \n        startSprintSession, TIMEZONE, pushActivity\n    } = appState;`;
// Wait, replacing multi-line text exactly is flaky with whitespace.
// Instead, just replace the primitive usages:
schedCode = schedCode.replace(/\bisConnected\b/g, 'appState.isConnected');
schedCode = schedCode.replace(/\bgroupCache\b/g, 'appState.groupCache');
schedCode = schedCode.replace(/\bsock\b/g, 'appState.sock');

// Fix the destructuring so it doesn't declare them locally (which would shadow appState)
schedCode = schedCode.replace("sock, isConnected, groupCache,", "");

fs.writeFileSync('src/jobs/scheduler.js', schedCode);

console.log("Fix completed");
