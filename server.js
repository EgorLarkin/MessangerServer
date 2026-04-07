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

function updateConversation(username, chatWith, lastMessage, timestamp, messageType = 'text', count = 0) {
    if (!conversationsDB[username]) conversationsDB[username] = [];

    const existing = conversationsDB[username].find(c => c.chatWith === chatWith);
    const preview = mediaPreview(messageType, lastMessage, lastMessage, count);

    if (existing) {
        existing.lastMessage = preview;
        existing.timestamp = timestamp;
        existing.lastMessageType = messageType;
    } else {
        conversationsDB[username].push({
            chatWith,
            lastMessage: preview,
            timestamp,
            unreadCount: 0,
            lastMessageType: messageType
        });
    }

    conversationsDB[username].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function sanitizeMessage(message) {
    return message;
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
        duration: att.duration != null ? Number(att.duration) : null
    };
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
    const conversations = conversationsDB[req.username] || [];

    const enriched = conversations.map(conv => {
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

        message = {
            id: generateMessageId(),
            from: username,
            to,
            text: cleanText,
            mediaType: type,
            mediaData: null,
            attachments: normalizedAttachments,
            fileId: null,
            downloadUrl: null,
            duration: duration != null ? Number(duration) : null,
            fileName: null,
            fileSize: null,
            timestamp
        };

        const preview = mediaPreview(type, normalizedAttachments[0]?.fileName || '', cleanText, normalizedAttachments.length);
        updateConversation(username, to, preview, timestamp, type, normalizedAttachments.length);
        updateConversation(to, username, preview, timestamp, type, normalizedAttachments.length);
    } else if (hasSingleMedia) {
        message = {
            id: generateMessageId(),
            from: username,
            to,
            text: cleanText,
            mediaType: type,
            mediaData: mediaData || null,
            attachments: null,
            fileId: null,
            downloadUrl: null,
            duration: duration != null ? Number(duration) : null,
            fileName: fileName || null,
            fileSize: fileSize != null ? Number(fileSize) : null,
            timestamp
        };

        updateConversation(username, to, message.fileName || message.text || '', timestamp, type, 1);
        updateConversation(to, username, message.fileName || message.text || '', timestamp, type, 1);
    } else {
        message = {
            id: generateMessageId(),
            from: username,
            to,
            text: cleanText,
            mediaType: 'text',
            mediaData: null,
            attachments: null,
            fileId: null,
            downloadUrl: null,
            duration: null,
            fileName: null,
            fileSize: null,
            timestamp
        };

        updateConversation(username, to, message.text || '', timestamp, 'text', 0);
        updateConversation(to, username, message.text || '', timestamp, 'text', 0);
    }

    const chatKey = getChatKey(username, to);
    if (!messagesDB[chatKey]) messagesDB[chatKey] = [];
    messagesDB[chatKey].push(message);

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

    const message = {
        id: generateMessageId(),
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
    };

    const chatKey = getChatKey(username, to);
    if (!messagesDB[chatKey]) messagesDB[chatKey] = [];
    messagesDB[chatKey].push(message);

    updateConversation(username, to, req.file.originalname, message.timestamp, message.mediaType, 1);
    updateConversation(to, username, req.file.originalname, message.timestamp, message.mediaType, 1);

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

    const message = {
        id: generateMessageId(),
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
    };

    const chatKey = getChatKey(username, to);
    if (!messagesDB[chatKey]) messagesDB[chatKey] = [];
    messagesDB[chatKey].push(message);

    const preview = mediaPreview(type, attachments[0]?.fileName || '', text || '', attachments.length);
    updateConversation(username, to, preview, timestamp, type, attachments.length);
    updateConversation(to, username, preview, timestamp, type, attachments.length);

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

    const message = {
        id: generateMessageId(),
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
    };

    const chatKey = getChatKey(username, to);
    if (!messagesDB[chatKey]) messagesDB[chatKey] = [];
    messagesDB[chatKey].push(message);

    const preview = mediaPreview('mixed', attachments[0]?.fileName || '', text || '', attachments.length);
    updateConversation(username, to, preview, timestamp, 'mixed', attachments.length);
    updateConversation(to, username, preview, timestamp, 'mixed', attachments.length);

    sendMessageToParticipants(message, username, to);
    res.status(201).json({ success: true, message: sanitizeMessage(message) });
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
    const chatKey = getChatKey(user1, user2);
    const history = messagesDB[chatKey] || [];

    res.json({
        success: true,
        count: history.length,
        messages: history
            .map(sanitizeMessage)
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
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
