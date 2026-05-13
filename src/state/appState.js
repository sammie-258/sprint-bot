module.exports = {
    sock: null,
    isConnected: false,
    qrCodeData: null,
    maintenanceMode: false,
    groupCache: {},
    lastCacheUpdate: 0,
    lastDailyRunDate: "",
    
    // In-memory stores
    activeSprints: {},
    activePomodoros: {},
    activeDuels: {},
    recentActivity: [],

    pushActivity(type, text, icon = '📝') {
        this.recentActivity.unshift({ type, text, icon, at: new Date() });
        if (this.recentActivity.length > 20) this.recentActivity.pop();
    }
};
