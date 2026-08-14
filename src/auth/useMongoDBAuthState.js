/**
 * MongoDB Auth State Store for @whiskeysockets/baileys
 * Handles permanent session persistence on Render/Cloud hosting using BufferJSON serialization.
 */

const {
    initAuthCreds,
    BufferJSON,
    proto
} = require('@whiskeysockets/baileys');

async function useMongoDBAuthState(collection, sessionId = 'sprint_bot_session') {
    const writeData = async (keyId, data) => {
        const docId = `${sessionId}_${keyId}`;
        const serialized = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne(
            { _id: docId },
            {
                $set: {
                    _id: docId,
                    sessionId,
                    keyId,
                    data: serialized,
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );
    };

    const readData = async (keyId) => {
        const docId = `${sessionId}_${keyId}`;
        const doc = await collection.findOne({ _id: docId });
        if (!doc || !doc.data) return null;
        try {
            return JSON.parse(doc.data, BufferJSON.reviver);
        } catch {
            return null;
        }
    };

    const removeData = async (keyId) => {
        const docId = `${sessionId}_${keyId}`;
        await collection.deleteOne({ _id: docId });
    };

    // 1. Initialize or load Credentials
    let creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            if (value) {
                                data[id] = value;
                            }
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(key, value));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        },
        clearSession: async () => {
            await collection.deleteMany({ sessionId });
        }
    };
}

module.exports = { useMongoDBAuthState };
