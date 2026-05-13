const fs = require('fs');

let indexCode = fs.readFileSync('index.js', 'utf8').replace(/\r\n/g, '\n');

const startMarker = "// =======================\n//   WEB API ENDPOINTS\n// =======================";
const endMarker = "// =======================\n//   MAIN LOGIC\n// =======================";

const startIndex = indexCode.indexOf(startMarker);
const endIndex = indexCode.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error("Markers not found");
    process.exit(1);
}

// Slice out the routes code
let routesCode = indexCode.substring(startIndex + startMarker.length, endIndex);

// We need to keep app.listen in index.js, so remove it from routesCode
const appListenMarker = "app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));";
const setIntervalMarker = "setInterval(() => { http.get(`http://localhost:${PORT}/`, () => {}).on('error', () => {}); }, 5 * 60 * 1000);";

routesCode = routesCode.replace(appListenMarker, '').replace(setIntervalMarker, '');

const routeFileTemplate = `const express = require('express');
const fs = require('fs');
const path = require('path');
const QR = require('qrcode');

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

const { getRank, getNextRank, getDurationString } = require('../utils/helpers');

const TIMEZONE = "Africa/Lagos";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const requireAdmin = (req, res, next) => {
    if (req.headers['x-admin-password'] === ADMIN_PASSWORD) return next();
    res.status(403).json({ error: "Unauthorized" });
};

module.exports = function(appState) {
    const { sock, isConnected, qrCodeData, maintenanceMode, groupCache, activeSprints, activePomodoros, activeDuels, pushActivity, updateGroupCache } = appState;
    const router = express.Router();
    
${routesCode.replace(/app\./g, 'router.').replace(/router\.use/g, 'app.use')}

    return router;
};
`;

// Wait, router.use inside routesCode might be a problem. Actually, app.get, app.post should become router.get, router.post
// But the replace(/app\./g, 'router.') is simple.

fs.writeFileSync('src/routes/api.js', routeFileTemplate);

const replacement = `${startMarker}\nconst apiRoutes = require('./src/routes/api');\napp.use('/', apiRoutes({\n    get sock() { return sock; },\n    get isConnected() { return isConnected; },\n    get qrCodeData() { return qrCodeData; },\n    get maintenanceMode() { return maintenanceMode; },\n    set maintenanceMode(v) { maintenanceMode = v; },\n    get activeSprints() { return activeSprints; },\n    get activeDuels() { return activeDuels; },\n    get activePomodoros() { return activePomodoros; },\n    get recentActivity() { return recentActivity; },\n    updateGroupCache\n}));\n\n${appListenMarker}\n${setIntervalMarker}\n\n${endMarker}`;

indexCode = indexCode.substring(0, startIndex) + replacement + indexCode.substring(endIndex + endMarker.length);
fs.writeFileSync('index.js', indexCode);
console.log("Successfully extracted API routes!");
