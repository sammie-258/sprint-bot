const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const QRCode = require('qrcode'); // The new tool we just installed
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// Variables to store the status
let qrCodeData = null;
let isConnected = false;

// THE WEBSITE PART
app.get('/', async (req, res) => {
    if (isConnected) {
        res.send('<h1>✅ Bot is Connected! You can close this page.</h1>');
    } else if (qrCodeData) {
        // Convert the QR code text into an image URL
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 20px;">
                <h1>Scan this with WhatsApp</h1>
                <p>Refresh this page if the code expires.</p>
                <img src="${qrImage}" style="width: 300px; height: 300px; border: 1px solid #ccc;">
            </div>
        `);
    } else {
        res.send('<h1>⏳ Booting up... please wait 30 seconds and refresh.</h1>');
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
});

// THE BOT PART
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
        console.log('New QR Received (Go to the website to scan!)');
        qrCodeData = qr; // Save the QR code so the website can show it
    });

    client.on('ready', () => {
        console.log('Client is ready!');
        isConnected = true;
    });

    client.on('message', message => {
        if(message.body === '!ping') {
            message.reply('pong');
        }
    });

    client.initialize();
}).catch(err => console.error("MongoDB connection error:", err));