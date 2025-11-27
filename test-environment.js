// filepath: c:\laragon\www\sprint-bot\test-environment.js
const EventEmitter = require('events');

class MockMessage extends EventEmitter {
    constructor(body, author, chatId, isGroup = true) {
        super();
        this.body = body;
        this.author = author;
        this.from = author;
        this.chatId = chatId;
        this._data = { notifyName: author };
        this.mentionedIds = [];
    }

    async getChat() {
        return new MockChat(this.chatId, true);
    }

    async getContact() {
        return new MockContact(this.author, 'Test User');
    }

    async reply(text) {
        console.log(`[REPLY to ${this.author}]: ${text}`);
    }

    async react(emoji) {
        console.log(`[REACT ${emoji}] to message`);
    }
}

class MockChat extends EventEmitter {
    constructor(id, isGroup = true) {
        super();
        this.id = { _serialized: id };
        this.isGroup = isGroup;
        this.name = `Test Group ${id.slice(-4)}`;
    }

    async sendMessage(text, options = {}) {
        console.log(`[CHAT ${this.id._serialized}]: ${text}`);
    }

    async leave() {
        console.log(`[BOT LEFT CHAT]: ${this.id._serialized}`);
    }

    getId() {
        return this.id._serialized;
    }
}

class MockContact {
    constructor(id, name) {
        this.id = { _serialized: id };
        this.pushname = name;
        this.name = name;
        this.number = id.split('@')[0];
    }
}

class MockClient extends EventEmitter {
    constructor() {
        super();
        this.isInitialized = false;
        this.chats = [];
    }

    async getChats() {
        return this.chats;
    }

    async getChatById(chatId) {
        let chat = this.chats.find(c => c.id._serialized === chatId);
        if (!chat) {
            chat = new MockChat(chatId, true);
            this.chats.push(chat);
        }
        return chat;
    }

    async getContactById(contactId) {
        return new MockContact(contactId, 'Mock User');
    }

    initialize() {
        this.isInitialized = true;
        this.emit('qr', 'MOCK_QR_CODE_DATA');
        setTimeout(() => {
            this.emit('ready');
        }, 100);
    }

    simulateMessage(body, author, chatId, isGroup = true) {
        const msg = new MockMessage(body, author, chatId, isGroup);
        this.emit('message', msg);
    }
}

// Export for testing
module.exports = {
    MockClient,
    MockMessage,
    MockChat,
    MockContact
};