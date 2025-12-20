// Fix MongoDB data
const mongoose = require("mongoose");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error("❌ MONGO_URI not found in .env file");
    process.exit(1);
}

const dailyStatsSchema = new mongoose.Schema({
    userId: String,
    name: String,
    groupId: String,
    date: String, 
    words: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now } 
});
const DailyStats = mongoose.model("DailyStats", dailyStatsSchema);

async function fixData() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("✅ Connected to MongoDB\n");

        const allStats = await DailyStats.find({}).lean();
        console.log(`📊 Total records: ${allStats.length}\n`);

        // Group by userId
        const userMap = {};
        allStats.forEach(stat => {
            if (!userMap[stat.userId]) {
                userMap[stat.userId] = [];
            }
            userMap[stat.userId].push(stat.name);
        });

        // Find duplicates
        console.log("👥 Users with mismatched/duplicate names:\n");
        let duplicateCount = 0;
        const problematicUsers = [];

        for (const [userId, names] of Object.entries(userMap)) {
            const uniqueNames = [...new Set(names)];
            if (uniqueNames.length > 1) {
                duplicateCount++;
                problematicUsers.push({ userId, names: uniqueNames });
                console.log(`User: ${userId}`);
                uniqueNames.forEach((name, i) => {
                    const count = names.filter(n => n === name).length;
                    console.log(`  ${i + 1}. "${name}" (${count} records)`);
                });
                console.log();
            }
        }

        if (duplicateCount === 0) {
            console.log("✅ No duplicates found! Your data looks clean.\n");
        } else {
            console.log(`\n⚠️ Found ${duplicateCount} users with duplicate names\n`);
            console.log("TO FIX: Edit this script and add your selections below:\n");
            
            console.log("// Example: If user has names ['Art', '120363...@c.us']");
            console.log("// Choose 'Art' (the real name)\n");

            problematicUsers.forEach(user => {
                console.log(`// Fix for ${user.userId}:`);
                console.log(`// await DailyStats.updateMany(`);
                console.log(`//     { userId: "${user.userId}" },`);
                console.log(`//     { $set: { name: "${user.names[0]}" } }`);
                console.log(`// );\n`);
            });
        }

        await mongoose.connection.close();
        console.log("✅ Done! Closed connection");

    } catch (err) {
        console.error("❌ Error:", err.message);
        process.exit(1);
    }
}

fixData();