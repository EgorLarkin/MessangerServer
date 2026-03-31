const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.options('*', cors());

app.use(bodyParser.json({ limit: '20mb', strict: false }));
app.use(bodyParser.urlencoded({ limit: '20mb', extended: true }));

app.use((req, res, next) => {
    res.setTimeout(300000);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 500 * 1024 * 1024
    }
});

const usersDB = {};
const messagesDB = {};
const tokensDB = {};
const deviceTokensDB = {};
const conversationsDB = {};

function getChatKey(user1, user2) {
    return [user1, user2].sort().join('_');
}

function generateUserId() {
    return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateMessageId() {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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

function updateConversation(username, chatWith, lastMessage, timestamp, messageType = 'text') {
    if (!conversationsDB[username]) conversationsDB[username] = [];
    const existing = conversationsDB[username].find(c => c.chatWith === chatWith);

    let preview = lastMessage;
    if (messageType !== 'text') {
        const labels = {
            image: '📷 Фото',
            video: '🎬 Видео',
            file: '📎 Файл',
            voice: '🎤 Голосовое',
            video_note: '⭕ Кружочек'
        };
        preview = labels[messageType] || 'Медиа';
    }

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

async function sendPushNotification(toUsername, messageText, fromUsername, messageType = 'text') {
    const tokens = deviceTokensDB[toUsername];
    if (!tokens || tokens.length === 0) return;

    let title = 'Новое сообщение';
    let body = messageText;

    if (messageType !== 'text') {
        const labels = {
            image: '📷 Новое фото',
            video: '🎬 Новое видео',
            file: '📎 Новый файл',
            voice: '🎤 Голосовое сообщение',
            video_note: '⭕ Видеосообщение'
        };
        title = labels[messageType] || 'Новое медиа';
        body = `${fromUsername} отправил(а) вложение`;
    }

    console.log(`🔔 ${toUsername}: ${title} - ${body}`);
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

app.post('/auth/register', async (req, res) => {
    const { username, password, name } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Заполните все поля' });
    if (usersDB[username]) return res.status(409).json({ error: 'Пользователь уже существует' });

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const userId = generateUserId();

        usersDB[username] = {
            id: userId,
            username,
            name,
            passwordHash,
            avatar: null,
            createdAt: new Date().toISOString()
        };

        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
        tokensDB[token] = username;

        res.status(201).json({
            success: true,
            token,
            user: getUserData(username)
        });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

    const user = usersDB[username];
    if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });

    try {
        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) return res.status(401).json({ error: 'Неверный логин или пароль' });

        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
        tokensDB[token] = username;

        res.json({
            success: true,
            token,
            user: getUserData(username)
        });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/auth/verify', requireAuth, (req, res) => {
    res.json({ valid: true, user: getUserData(req.username) });
});

app.get('/users', requireAuth, (req, res) => {
    const userList = Object.values(usersDB).map(u => ({
        id: u.id,
        username: u.username,
        name: u.name,
        avatar: u.avatar || null
    }));
    res.json({ users: userList });
});

app.get('/users/search', requireAuth, (req, res) => {
    const query = (req.query.q || '').toLowerCase();
    if (!query) return res.json({ users: [] });

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
    if (!usersDB[req.username]) return res.status(404).json({ error: 'Пользователь не найден' });
    if (name && name.length >= 2) usersDB[req.username].name = name;
    res.json({ success: true, user: getUserData(req.username) });
});

app.put('/profile/avatar', requireAuth, (req, res) => {
    const { avatar } = req.body;
    if (!usersDB[req.username]) return res.status(404).json({ error: 'Пользователь не найден' });
    usersDB[req.username].avatar = avatar;
    res.json({ success: true, user: getUserData(req.username) });
});

app.delete('/profile', requireAuth, (req, res) => {
    delete usersDB[req.username];
    delete conversationsDB[req.username];
    delete tokensDB[req.token];
    res.json({ success: true });
});

app.post('/notifications/register-token', requireAuth, (req, res) => {
    const { deviceToken } = req.body;
    if (!deviceToken) return res.status(400).json({ error: 'deviceToken обязателен' });

    if (!deviceTokensDB[req.username]) deviceTokensDB[req.username] = [];
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

app.post('/send', requireAuth, async (req, res) => {
    const username = req.username;
    const { to, text, mediaType, mediaData, duration, fileName, fileSize } = req.body;

    if (!to) return res.status(400).json({ error: 'Получатель обязателен' });
    if (!usersDB[to]) return res.status(404).json({ error: 'Пользователь не найден' });

    const messageType = mediaType || 'text';
    if (messageType === 'text' && (!text || text.trim() === '')) {
        return res.status(400).json({ error: 'Текст сообщения пустой' });
    }

    const message = {
        id: generateMessageId(),
        from: username,
        to,
        text: text || '',
        mediaType: messageType,
        mediaData: mediaData || null,
        duration: duration ? Number(duration) : null,
        fileName: fileName || null,
        fileSize: fileSize ? Number(fileSize) : null,
        timestamp: new Date().toISOString()
    };

    const chatKey = getChatKey(username, to);
    if (!messagesDB[chatKey]) messagesDB[chatKey] = [];
    messagesDB[chatKey].push(message);

    const preview = messageType === 'text'
        ? message.text
        : (fileName || messageType);

    updateConversation(username, to, preview, message.timestamp, messageType);
    updateConversation(to, username, preview, message.timestamp, messageType);

    wss.clients.forEach(client => {
        if (
            client.readyState === WebSocket.OPEN &&
            (client.user === username || client.user === to)
        ) {
            client.send(JSON.stringify(message));
        }
    });

    await sendPushNotification(to, preview, username, messageType);
    res.status(201).json({ success: true, message });
});

app.post('/send-media', requireAuth, upload.single('file'), async (req, res) => {
    const username = req.username;
    const { to, text, mediaType, duration } = req.body;

    if (!to) return res.status(400).json({ error: 'Получатель обязателен' });
    if (!usersDB[to]) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!req.file) return res.status(400).json({ error: 'Файл не найден' });

    const file = req.file;
    const safeMediaType = mediaType || 'file';
    const mediaData = `${file.mimetype};base64,${file.buffer.toString('base64')}`;

    const message = {
        id: generateMessageId(),
        from: username,
        to,
        text: text || '',
        mediaType: safeMediaType,
        mediaData,
        duration: duration ? Number(duration) : null,
        fileName: file.originalname,
        fileSize: file.size,
        timestamp: new Date().toISOString()
    };

    const chatKey = getChatKey(username, to);
    if (!messagesDB[chatKey]) messagesDB[chatKey] = [];
    messagesDB[chatKey].push(message);

    const preview = file.originalname || safeMediaType;

    updateConversation(username, to, preview, message.timestamp, safeMediaType);
    updateConversation(to, username, preview, message.timestamp, safeMediaType);

    wss.clients.forEach(client => {
        if (
            client.readyState === WebSocket.OPEN &&
            (client.user === username || client.user === to)
        ) {
            client.send(JSON.stringify(message));
        }
    });

    await sendPushNotification(to, preview, username, safeMediaType);
    res.status(201).json({ success: true, message });
});

app.get('/history/:user1/:user2', requireAuth, (req, res) => {
    const { user1, user2 } = req.params;
    const chatKey = getChatKey(user1, user2);
    const history = messagesDB[chatKey] || [];

    res.json({
        success: true,
        count: history.length,
        messages: history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    });
});

const server = http.createServer(app);
server.timeout = 300000;

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, request, username) => {
    ws.user = username;
    console.log(`✅ WebSocket connected: ${username}`);

    ws.on('close', () => {
        console.log(`❌ WebSocket disconnected: ${username}`);
    });
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
        console.error('Upgrade error:', error);
        socket.destroy();
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
