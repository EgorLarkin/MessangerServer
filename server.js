const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const BASE_URL = process.env.BASE_URL || 'https://messangerserver-1.onrender.com';
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.options('*', cors());

app.use(bodyParser.json({ limit: '100mb', strict: false }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

app.use((req, res, next) => {
    res.setTimeout(300000);
    next();
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '';
        cb(null, crypto.randomUUID() + ext);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 1024 * 1024 * 1024,
        files: 20
    }
});

const usersDB = {};
const messagesDB = {};
const tokensDB = {};
const deviceTokensDB = {};
const conversationsDB = {};
const filesDB = {};

function getChatKey(user1, user2) {
    return [user1, user2].sort().join('_');
}

function generateUserId() {
    return 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

function generateMessageId() {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

function getUserData(username) {
    const user = usersDB[username];
    if (!user) return null;

    return {
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.avatar || null
    };
}

function attachmentTypeFromMime(mimetype = '') {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'voice';
    return 'file';
}

function mediaPreview(type, fileName, text, count = 0) {
    if (type === 'text') return text || '';
    if (type === 'mixed') return count > 1 ? `📎 Вложения (${count})` : '📎 Вложение';
    if (type === 'image') return count > 1 ? `📷 Фото (${count})` : '📷 Фото';
    if (type === 'video') return count > 1 ? `🎬 Видео (${count})` : '🎬 Видео';
    if (type === 'file') return fileName || '📎 Файл';
    if (type === 'voice') return '🎤 Голосовое';
    if (type === 'video_note') return '⭕ Кружочек';
    return fileName || 'Медиа';
}

function ensureConversation(username, chatWith) {
    if (!conversationsDB[username]) conversationsDB[username] = [];
    let existing = conversationsDB[username].find(c => c.chatWith === chatWith);
    if (!existing) {
        existing = {
            chatWith,
            lastMessage: '',
            timestamp: new Date().toISOString(),
            unreadCount: 0,
            lastMessageType: 'text'
        };
        conversationsDB[username].push(existing);
    }
    return existing;
}

function updateConversation(username, chatWith, lastMessage, timestamp, messageType = 'text', count = 0) {
    const existing = ensureConversation(username, chatWith);
    const preview = mediaPreview(messageType, lastMessage, lastMessage, count);

    existing.lastMessage = preview;
    existing.timestamp = timestamp;
    existing.lastMessageType = messageType;

    conversationsDB[username].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function removeConversationIfEmpty(username, chatWith) {
    const chatKey = getChatKey(username, chatWith);
    const visible = getVisibleMessagesForUser(chatKey, username);
    if (visible.length > 0) return;

    if (!conversationsDB[username]) return;
    conversationsDB[username] = conversationsDB[username].filter(c => c.chatWith !== chatWith);
}

function recomputeConversationForUser(username, chatWith) {
    const chatKey = getChatKey(username, chatWith);
    const visible = getVisibleMessagesForUser(chatKey, username).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (!visible.length) {
        removeConversationIfEmpty(username, chatWith);
        return;
    }

    const last = visible[visible.length - 1];
    const count = Array.isArray(last.attachments) ? last.attachments.length : (last.mediaType === 'text' ? 0 : 1);
    const previewSource = last.fileName || last.text || last.attachments?.[0]?.fileName || '';
    updateConversation(username, chatWith, previewSource, last.timestamp, last.mediaType || 'text', count);
}

function sanitizeMessage(message) {
    return {
        ...message,
        deletedFor: Array.isArray(message.deletedFor) ? message.deletedFor : [],
        deletedForEveryone: !!message.deletedForEveryone,
        edited: !!message.edited,
        editedAt: message.editedAt || null
    };
}

function sendMessageToParticipants(message, username, to) {
    const payload = JSON.stringify(sanitizeMessage(message));

    wss.clients.forEach(client => {
        if (
            client.readyState === WebSocket.OPEN &&
            (client.user === username || client.user === to)
        ) {
            client.send(payload);
        }
    });
}

function sendEventToUsers(users, event) {
    const payload = JSON.stringify(event);
    wss.clients.forEach(client => {
        if (
            client.readyState === WebSocket.OPEN &&
            users.includes(client.user)
        ) {
            client.send(payload);
        }
    });
}

function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) {
        return res.status(401).json({ error: 'Неавторизован' });
    }

    req.username = tokensDB[token];
    req.token = token;
    next();
}

function normalizeBase64Attachment(att) {
    if (!att || typeof att !== 'object') return null;
    if (!att.mediaData || typeof att.mediaData !== 'string') return null;

    return {
        mediaData: att.mediaData,
        fileName: att.fileName || null,
        fileSize: att.fileSize != null ? Number(att.fileSize) : null,
        downloadUrl: att.downloadUrl || null,
        duration: att.duration != null ? Number(att.duration) : null,
        type: att.type || null
    };
}

function createBaseMessage({
    from,
    to,
    text = '',
    mediaType = 'text',
    mediaData = null,
    attachments = null,
    fileId = null,
    downloadUrl = null,
    duration = null,
    fileName = null,
    fileSize = null,
    timestamp = new Date().toISOString()
}) {
    return {
        id: generateMessageId(),
        from,
        to,
        text,
        mediaType,
        mediaData,
        attachments,
        fileId,
        downloadUrl,
        duration,
        fileName,
        fileSize,
        timestamp,
        deletedFor: [],
        deletedForEveryone: false,
        edited: false,
        editedAt: null
    };
}

function findMessageById(messageId) {
    for (const [chatKey, list] of Object.entries(messagesDB)) {
        const index = list.findIndex(m => m.id === messageId);
        if (index !== -1) {
            return {
                chatKey,
                index,
                message: list[index]
            };
        }
    }
    return null;
}

function isMessageVisibleForUser(message, username) {
    if (!message) return false;
    if (message.deletedForEveryone) return false;
    if (Array.isArray(message.deletedFor) && message.deletedFor.includes(username)) return false;
    return true;
}

function getVisibleMessagesForUser(chatKey, username) {
    return (messagesDB[chatKey] || []).filter(msg => isMessageVisibleForUser(msg, username));
}

function hydrateConversationListForUser(username) {
    const convs = conversationsDB[username] || [];
    return convs.map(conv => {
        const user = usersDB[conv.chatWith];
        if (!user) return null;

        return {
            chatWith: conv.chatWith,
            lastMessage: conv.lastMessage,
            timestamp: conv.timestamp,
            unreadCount: conv.unreadCount || 0,
            lastMessageType: conv.lastMessageType || 'text',
            user: {
                id: user.id,
                username: user.username,
                name: user.name,
                avatar: user.avatar || null
            }
        };
    }).filter(Boolean);
}

function recalcBothConversations(userA, userB) {
    recomputeConversationForUser(userA, userB);
    recomputeConversationForUser(userB, userA);
}

function createAndStoreMessage(message) {
    const chatKey = getChatKey(message.from, message.to);
    if (!messagesDB[chatKey]) messagesDB[chatKey] = [];
    messagesDB[chatKey].push(message);

    const count = Array.isArray(message.attachments) ? message.attachments.length : (message.mediaType === 'text' ? 0 : 1);
    const previewSource = message.fileName || message.text || message.attachments?.[0]?.fileName || '';
    updateConversation(message.from, message.to, previewSource, message.timestamp, message.mediaType, count);
    updateConversation(message.to, message.from, previewSource, message.timestamp, message.mediaType, count);

    return message;
}

function filterMessagesForUser(history, username) {
    return history.filter(msg => isMessageVisibleForUser(msg, username));
}

app.post('/auth/register', async (req, res) => {
    const { username, password, name } = req.body;

    if (!username || !password || !name) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    if (usersDB[username]) {
        return res.status(409).json({ error: 'Пользователь уже существует' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = generateUserId();

    usersDB[username] = {
        id: userId,
        username,
        name,
        passwordHash,
        avatar: null
    };

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    tokensDB[token] = username;

    res.status(201).json({
        success: true,
        token,
        user: getUserData(username)
    });
});

app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const user = usersDB[username];
    if (!user) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    tokensDB[token] = username;

    res.json({
        success: true,
        token,
        user: getUserData(username)
    });
});

app.get('/auth/verify', requireAuth, (req, res) => {
    res.json({ valid: true, user: getUserData(req.username) });
});

app.get('/users', requireAuth, (req, res) => {
    const users = Object.values(usersDB)
        .filter(u => u.username !== req.username)
        .map(u => ({
            id: u.id,
            username: u.username,
            name: u.name,
            avatar: u.avatar || null
        }));

    res.json({ success: true, users });
});

app.get('/users/search', requireAuth, (req, res) => {
    const query = (req.query.q || '').toLowerCase();

    const filteredUsers = Object.values(usersDB)
        .filter(u => u.username !== req.username)
        .filter(u =>
            u.username.toLowerCase().includes(query) ||
            u.name.toLowerCase().includes(query)
        )
        .map(u => ({
            id: u.id,
            username: u.username,
            name: u.name,
            avatar: u.avatar || null
        }));

    res.json({ users: filteredUsers });
});

app.put('/profile', requireAuth, (req, res) => {
    const { name } = req.body;

    if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'Имя обязательно' });
    }

    usersDB[req.username].name = String(name).trim();

    res.json({
        success: true,
        user: getUserData(req.username)
    });
});

app.delete('/profile', requireAuth, (req, res) => {
    const username = req.username;

    delete usersDB[username];
    delete deviceTokensDB[username];
    delete conversationsDB[username];

    Object.keys(tokensDB).forEach(token => {
        if (tokensDB[token] === username) {
            delete tokensDB[token];
        }
    });

    Object.keys(messagesDB).forEach(chatKey => {
        messagesDB[chatKey] = (messagesDB[chatKey] || []).filter(
            msg => msg.from !== username && msg.to !== username
        );

        if (messagesDB[chatKey].length === 0) {
            delete messagesDB[chatKey];
        }
    });

    Object.keys(conversationsDB).forEach(user => {
        conversationsDB[user] = (conversationsDB[user] || []).filter(
            conv => conv.chatWith !== username
        );
    });

    res.json({ success: true });
});

app.put('/profile/avatar', requireAuth, (req, res) => {
    const { avatar } = req.body;
    usersDB[req.username].avatar = avatar;
    res.json({ success: true, user: getUserData(req.username) });
});

app.post('/notifications/register-token', requireAuth, (req, res) => {
    const { deviceToken } = req.body;

    if (!deviceToken) {
        return res.status(400).json({ error: 'deviceToken обязателен' });
    }

    if (!deviceTokensDB[req.username]) {
        deviceTokensDB[req.username] = [];
    }

    if (!deviceTokensDB[req.username].includes(deviceToken)) {
        deviceTokensDB[req.username].push(deviceToken);
    }

    res.json({ success: true });
});

app.get('/conversations', requireAuth, (req, res) => {
    const enriched = hydrateConversationListForUser(req.username);
    res.json({ success: true, conversations: enriched });
});

app.post('/send', requireAuth, (req, res) => {
    const username = req.username;
    const {
        to,
        text,
        mediaType,
        mediaData,
        duration,
        fileName,
        fileSize,
        attachments
    } = req.body;

    if (!to) {
        return res.status(400).json({ error: 'Получатель обязателен' });
    }

    if (!usersDB[to]) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const type = mediaType || 'text';
    const cleanText = typeof text === 'string' ? text.trim() : '';
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const hasSingleMedia = type !== 'text' && !!mediaData;

    if (type === 'text' && !cleanText && !hasAttachments) {
        return res.status(400).json({ error: 'Текст сообщения пустой' });
    }

    if (type !== 'text' && !hasAttachments && !hasSingleMedia) {
        return res.status(400).json({ error: 'Медиа-данные отсутствуют' });
    }

    const timestamp = new Date().toISOString();
    let message;

    if (hasAttachments) {
        const normalizedAttachments = attachments
            .map(normalizeBase64Attachment)
            .filter(Boolean);

        if (!normalizedAttachments.length) {
            return res.status(400).json({ error: 'Нет валидных вложений' });
        }

        message = createBaseMessage({
            from: username,
            to,
            text: cleanText,
            mediaType: type,
            mediaData: null,
            attachments: normalizedAttachments,
            duration: duration != null ? Number(duration) : null,
            fileName: null,
            fileSize: null,
            timestamp
        });
    } else if (hasSingleMedia) {
        message = createBaseMessage({
            from: username,
            to,
            text: cleanText,
            mediaType: type,
            mediaData: mediaData || null,
            attachments: null,
            duration: duration != null ? Number(duration) : null,
            fileName: fileName || null,
            fileSize: fileSize != null ? Number(fileSize) : null,
            timestamp
        });
    } else {
        message = createBaseMessage({
            from: username,
            to,
            text: cleanText,
            mediaType: 'text',
            timestamp
        });
    }

    createAndStoreMessage(message);
    sendMessageToParticipants(message, username, to);

    res.status(201).json({ success: true, message: sanitizeMessage(message) });
});

app.post('/send-media', requireAuth, upload.single('file'), (req, res) => {
    const username = req.username;
    const { to, mediaType, text, duration } = req.body;

    if (!to) {
        return res.status(400).json({ error: 'Получатель обязателен' });
    }

    if (!usersDB[to]) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'Файл не найден' });
    }

    const timestamp = new Date().toISOString();
    const fileId = crypto.randomUUID();

    filesDB[fileId] = {
        id: fileId,
        owner: username,
        recipient: to,
        originalName: req.file.originalname,
        storedName: req.file.filename,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path,
        createdAt: timestamp
    };

    const message = createBaseMessage({
        from: username,
        to,
        text: text || '',
        mediaType: mediaType || 'file',
        mediaData: null,
        attachments: null,
        fileId,
        downloadUrl: `${BASE_URL}/files/${fileId}`,
        duration: duration ? Number(duration) : null,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        timestamp
    });

    createAndStoreMessage(message);
    sendMessageToParticipants(message, username, to);

    res.status(201).json({ success: true, message: sanitizeMessage(message) });
});

app.post('/send-media-group', requireAuth, upload.array('files', 20), (req, res) => {
    const username = req.username;
    const { to, mediaType, text, durations } = req.body;

    if (!to) {
        return res.status(400).json({ error: 'Получатель обязателен' });
    }

    if (!usersDB[to]) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const files = req.files || [];
    if (!files.length) {
        return res.status(400).json({ error: 'Файлы не найдены' });
    }

    const type = mediaType || 'video';

    let parsedDurations = [];
    if (durations) {
        try {
            parsedDurations = JSON.parse(durations).map(Number);
        } catch (e) {
            parsedDurations = [];
        }
    }

    const timestamp = new Date().toISOString();

    const attachments = files.map((file, index) => {
        const fileId = crypto.randomUUID();
        const downloadUrl = `${BASE_URL}/files/${fileId}`;

        filesDB[fileId] = {
            id: fileId,
            owner: username,
            recipient: to,
            originalName: file.originalname,
            storedName: file.filename,
            mimetype: file.mimetype,
            size: file.size,
            path: file.path,
            createdAt: timestamp
        };

        return {
            mediaData: downloadUrl,
            downloadUrl,
            fileName: file.originalname,
            fileSize: file.size,
            duration: parsedDurations[index] ?? null
        };
    });

    const message = createBaseMessage({
        from: username,
        to,
        text: text || '',
        mediaType: type,
        mediaData: null,
        attachments,
        fileId: null,
        downloadUrl: null,
        duration: null,
        fileName: null,
        fileSize: null,
        timestamp
    });

    createAndStoreMessage(message);
    sendMessageToParticipants(message, username, to);

    res.status(201).json({ success: true, message: sanitizeMessage(message) });
});

app.post('/send-media-mixed-group', requireAuth, upload.array('files', 20), (req, res) => {
    const username = req.username;
    const { to, text, durations, itemTypes } = req.body;

    if (!to) {
        return res.status(400).json({ error: 'Получатель обязателен' });
    }

    if (!usersDB[to]) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const files = req.files || [];
    if (!files.length) {
        return res.status(400).json({ error: 'Файлы не найдены' });
    }

    let parsedDurations = [];
    if (durations) {
        try {
            parsedDurations = JSON.parse(durations).map(value => value == null ? null : Number(value));
        } catch (e) {
            parsedDurations = [];
        }
    }

    let parsedItemTypes = [];
    if (itemTypes) {
        try {
            parsedItemTypes = JSON.parse(itemTypes);
        } catch (e) {
            parsedItemTypes = [];
        }
    }

    const timestamp = new Date().toISOString();

    const attachments = files.map((file, index) => {
        const fileId = crypto.randomUUID();
        const downloadUrl = `${BASE_URL}/files/${fileId}`;
        const inferredType = parsedItemTypes[index] || attachmentTypeFromMime(file.mimetype);

        filesDB[fileId] = {
            id: fileId,
            owner: username,
            recipient: to,
            originalName: file.originalname,
            storedName: file.filename,
            mimetype: file.mimetype,
            size: file.size,
            path: file.path,
            createdAt: timestamp
        };

        return {
            mediaData: downloadUrl,
            downloadUrl,
            fileName: file.originalname,
            fileSize: file.size,
            duration: parsedDurations[index] ?? null,
            type: inferredType
        };
    });

    const message = createBaseMessage({
        from: username,
        to,
        text: text || '',
        mediaType: 'mixed',
        mediaData: null,
        attachments,
        fileId: null,
        downloadUrl: null,
        duration: null,
        fileName: null,
        fileSize: null,
        timestamp
    });

    createAndStoreMessage(message);
    sendMessageToParticipants(message, username, to);

    res.status(201).json({ success: true, message: sanitizeMessage(message) });
});

app.post('/messages/forward', requireAuth, (req, res) => {
    const username = req.username;
    const { messageIds, to } = req.body;

    if (!to) {
        return res.status(400).json({ error: 'Получатель обязателен' });
    }

    if (!usersDB[to]) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }

    if (!Array.isArray(messageIds) || !messageIds.length) {
        return res.status(400).json({ error: 'Нужен список messageIds' });
    }

    const forwarded = [];

    for (const messageId of messageIds) {
        const found = findMessageById(messageId);
        if (!found) continue;

        const source = found.message;
        if (!isMessageVisibleForUser(source, username)) continue;

        const cloned = createBaseMessage({
            from: username,
            to,
            text: source.text || '',
            mediaType: source.mediaType || 'text',
            mediaData: source.mediaData || null,
            attachments: source.attachments ? JSON.parse(JSON.stringify(source.attachments)) : null,
            fileId: source.fileId || null,
            downloadUrl: source.downloadUrl || null,
            duration: source.duration ?? null,
            fileName: source.fileName || null,
            fileSize: source.fileSize ?? null,
            timestamp: new Date().toISOString()
        });

        createAndStoreMessage(cloned);
        sendMessageToParticipants(cloned, username, to);
        forwarded.push(sanitizeMessage(cloned));
    }

    res.status(201).json({
        success: true,
        count: forwarded.length,
        messages: forwarded
    });
});

app.put('/messages/:messageId', requireAuth, (req, res) => {
    const { messageId } = req.params;
    const { text } = req.body;
    const username = req.username;

    if (!text || !String(text).trim()) {
        return res.status(400).json({ error: 'Текст обязателен' });
    }

    const found = findMessageById(messageId);
    if (!found) {
        return res.status(404).json({ error: 'Сообщение не найдено' });
    }

    const message = found.message;

    if (message.from !== username) {
        return res.status(403).json({ error: 'Нет прав редактировать' });
    }

    if (message.deletedForEveryone) {
        return res.status(400).json({ error: 'Сообщение уже удалено у всех' });
    }

    message.text = String(text).trim();
    message.edited = true;
    message.editedAt = new Date().toISOString();

    recalcBothConversations(message.from, message.to);
    sendEventToUsers([message.from, message.to], {
        type: 'message_edited',
        message: sanitizeMessage(message)
    });

    res.json({
        success: true,
        message: sanitizeMessage(message)
    });
});

app.post('/messages/:messageId/delete-for-me', requireAuth, (req, res) => {
    const { messageId } = req.params;
    const username = req.username;

    const found = findMessageById(messageId);
    if (!found) {
        return res.status(404).json({ error: 'Сообщение не найдено' });
    }

    const message = found.message;
    if (message.from !== username && message.to !== username) {
        return res.status(403).json({ error: 'Нет доступа' });
    }

    message.deletedFor = Array.isArray(message.deletedFor) ? message.deletedFor : [];
    if (!message.deletedFor.includes(username)) {
        message.deletedFor.push(username);
    }

    recomputeConversationForUser(username, message.from === username ? message.to : message.from);

    res.json({ success: true, messageId });
});

app.post('/messages/:messageId/delete-for-peer', requireAuth, (req, res) => {
    const { messageId } = req.params;
    const username = req.username;

    const found = findMessageById(messageId);
    if (!found) {
        return res.status(404).json({ error: 'Сообщение не найдено' });
    }

    const message = found.message;

    if (message.from !== username) {
        return res.status(403).json({ error: 'Удалить у собеседника может только отправитель' });
    }

    if (message.deletedForEveryone) {
        return res.status(400).json({ error: 'Сообщение уже удалено у всех' });
    }

    const peer = message.to;
    message.deletedFor = Array.isArray(message.deletedFor) ? message.deletedFor : [];

    if (!message.deletedFor.includes(peer)) {
        message.deletedFor.push(peer);
    }

    recomputeConversationForUser(peer, username);

    sendEventToUsers([peer], {
        type: 'message_deleted_for_you',
        messageId: message.id,
        by: username
    });

    res.json({ success: true, messageId });
});

app.post('/messages/:messageId/delete-for-all', requireAuth, (req, res) => {
    const { messageId } = req.params;
    const username = req.username;

    const found = findMessageById(messageId);
    if (!found) {
        return res.status(404).json({ error: 'Сообщение не найдено' });
    }

    const message = found.message;

    if (message.from !== username) {
        return res.status(403).json({ error: 'Удалить у всех может только отправитель' });
    }

    if (message.deletedForEveryone) {
        return res.status(400).json({ error: 'Сообщение уже удалено у всех' });
    }

    message.deletedForEveryone = true;

    recalcBothConversations(message.from, message.to);

    sendEventToUsers([message.from, message.to], {
        type: 'message_deleted_for_all',
        messageId: message.id,
        by: username
    });

    res.json({ success: true, messageId });
});

app.post('/messages/bulk-delete', requireAuth, (req, res) => {
    const username = req.username;
    const { ids, mode } = req.body;

    if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'Нужен список ids' });
    }

    if (!['me', 'all'].includes(mode)) {
        return res.status(400).json({ error: 'mode должен быть me или all' });
    }

    const updated = [];
    const rejected = [];

    for (const id of ids) {
        const found = findMessageById(id);
        if (!found) {
            rejected.push({ id, reason: 'not_found' });
            continue;
        }

        const message = found.message;

        if (mode === 'me') {
            if (message.from !== username && message.to !== username) {
                rejected.push({ id, reason: 'forbidden' });
                continue;
            }

            message.deletedFor = Array.isArray(message.deletedFor) ? message.deletedFor : [];
            if (!message.deletedFor.includes(username)) {
                message.deletedFor.push(username);
            }

            recomputeConversationForUser(username, message.from === username ? message.to : message.from);
            updated.push(id);
            continue;
        }

        if (mode === 'all') {
            if (message.from !== username) {
                rejected.push({ id, reason: 'not_sender' });
                continue;
            }

            if (!message.deletedForEveryone) {
                message.deletedForEveryone = true;
                recalcBothConversations(message.from, message.to);
                sendEventToUsers([message.from, message.to], {
                    type: 'message_deleted_for_all',
                    messageId: message.id,
                    by: username
                });
            }

            updated.push(id);
        }
    }

    res.json({
        success: true,
        mode,
        updated,
        rejected
    });
});

app.get('/files/:fileId', requireAuth, (req, res) => {
    const file = filesDB[req.params.fileId];

    if (!file) {
        return res.status(404).json({ error: 'Файл не найден' });
    }

    if (req.username !== file.owner && req.username !== file.recipient) {
        return res.status(403).json({ error: 'Нет доступа' });
    }

    res.download(file.path, file.originalName);
});

app.get('/history/:user1/:user2', requireAuth, (req, res) => {
    const { user1, user2 } = req.params;

    if (req.username !== user1 && req.username !== user2) {
        return res.status(403).json({ error: 'Нет доступа к истории' });
    }

    const chatKey = getChatKey(user1, user2);
    const history = messagesDB[chatKey] || [];
    const filtered = filterMessagesForUser(history, req.username);

    res.json({
        success: true,
        count: filtered.length,
        messages: filtered
            .map(sanitizeMessage)
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    });
});

app.get('/ping', (req, res) => {
    res.json({
        success: true,
        message: 'pong',
        time: new Date().toISOString()
    });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, request, username) => {
    ws.user = username;
    ws.on('close', () => {});
    ws.on('error', () => {});
});

server.on('upgrade', (request, socket, head) => {
    try {
        const url = new URL(request.url, 'http://localhost');

        if (url.pathname !== '/socket') {
            socket.destroy();
            return;
        }

        const token = url.searchParams.get('token');

        if (!token || !tokensDB[token]) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        const username = tokensDB[token];

        wss.handleUpgrade(request, socket, head, ws => {
            wss.emit('connection', ws, request, username);
        });
    } catch (error) {
        socket.destroy();
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
