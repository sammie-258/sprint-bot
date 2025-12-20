const { MongoClient } = require("mongodb");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI;

console.log("🔍 DEBUG INFO:");
console.log("MONGO_URI exists:", !!MONGO_URI);
console.log("MONGO_URI starts with:", MONGO_URI?.substring(0, 20) + "...");
console.log();

async function fixData() {
    console.log("⏳ Attempting to connect...");
    const client = new MongoClient(MONGO_URI, { 
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000 
    });
    
    try {
        console.log("⏳ Connecting to MongoDB...");
        await client.connect();
        console.log("✅ Connected to MongoDB!");
        
        const db = client.db("myDatabase");
        console.log("✅ Selected database: myDatabase");
        
        const stats = db.collection("dailystats");
        console.log("✅ Selected collection: dailystats");
        
        console.log("⏳ Fetching all records...");
        const allRecords = await stats.find({}).toArray();
        console.log(`✅ Found ${allRecords.length} records\n`);
        
        if (allRecords.length === 0) {
            console.log("⚠️  No records in database yet!");
            return;
        }

        // Show first 5 records
        console.log("📋 First 5 records:");
        allRecords.slice(0, 5).forEach((record, i) => {
            console.log(`${i + 1}. userId: ${record.userId}, name: ${record.name}`);
        });
        console.log();
        
        // Group by userId
        const userMap = {};
        allRecords.forEach(record => {
            if (!userMap[record.userId]) {
                userMap[record.userId] = new Set();
            }
            userMap[record.userId].add(record.name);
        });

        console.log(`👥 Total unique users: ${Object.keys(userMap).length}\n`);

        let duplicateCount = 0;
        console.log("👥 Users with multiple names:\n");
        for (const [userId, names] of Object.entries(userMap)) {
            if (names.size > 1) {
                duplicateCount++;
                console.log(`${userId}:`);
                Array.from(names).forEach((name, i) => {
                    console.log(`  ${i + 1}. "${name}"`);
                });
                console.log();
            }
        }
        
        if (duplicateCount === 0) {
            console.log("✅ No duplicates found!");
        } else {
            console.log(`⚠️  Found ${duplicateCount} users with duplicate names`);
        }
        
    } catch (err) {
        console.error("❌ ERROR:", err.message);
        console.error("Code:", err.code);
    } finally {
        console.log("\n⏳ Closing connection...");
        await client.close();
        console.log("✅ Done!");
    }
}

fixData();