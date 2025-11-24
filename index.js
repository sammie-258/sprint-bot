const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// 1. Start a dummy web server (Keeps Render happy)
app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
});

// 2. Connect to Database and Start Bot
// NOTE: We will set this secret variable inside the Render dashboard later!
const MONGO_URI = process.env.MONGO_URI; 

mongoose.connect(MONGO_URI).then(() => {
    const store = new MongoStore({ mongoose: mongoose });
    const client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000
        }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('QR RECEIVED', qr);
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('Client is ready!');
    });

    client.on('message', message => {
        if(message.body === '!ping') {
            message.reply('pong');
        }
    });

    client.initialize();
}).catch(err => console.error("MongoDB connection error:", err));