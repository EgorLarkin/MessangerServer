const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.options('*', cors());

// Body parser с увеличенными лимитами для фото/видео
app.use(bodyParser.json({ limit: '100mb', strict: false }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

// Таймауты для больших файлов
app.use((req, res, next) => {
    res.setTimeout(300000);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// === БАЗА ДАННЫХ ===
const usersDB = {};
const messagesDB = {};
const tokensDB = {};
const deviceTokensDB = {};
const conversationsDB = {};

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===
function getChatKey(user1, user2) {
    const sorted = [user1, user2].sort();
    return sorted.join('_');
}

function generateUserId() {
    return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateMessageId() {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function updateConversation(username, chatWith, lastMessage, timestamp, messageType = 'text') {
    if (!conversationsDB[username]) conversationsDB[username] = [];
    const existing = conversationsDB[username].find(c => c.chatWith === chatWith);
    
    let preview = lastMessage;
    if (messageType !== 'text') {
        const labels = {
            'image': '📷 Фото',
            'video': '🎬 Видео',
            'file': '📎 Файл',
            'voice': '🎤 Голосовое',
            'video_note': '⭕ Кружочек'
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
            'image': '📷 Новое фото',
            'video': '🎬 Новое видео',
            'file': '📎 Новый файл',
            'voice': '🎤 Голосовое сообщение',
            'video_note': '⭕ Видеосообщение'
        };
        title = labels[messageType] || 'Новое медиа';
        body = fromUsername + ' отправил(а) медиа';
    }
    
    console.log(`🔔 ${toUsername}: ${title} - ${body}`);
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

// === АУТЕНТИФИКАЦИЯ ===
app.post('/auth/register', async (req, res) => {
    const { username, password, name } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Заполните все поля' });
    if (username.length < 3) return res.status(400).json({ error: 'Логин должен быть не менее 3 символов' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
    if (usersDB[username]) return res.status(409).json({ error: 'Пользователь уже существует' });

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const userId = generateUserId();
        usersDB[username] = { id: userId, username, name, passwordHash, avatar: null, createdAt: new Date().toISOString() };
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
        tokensDB[token] = username;
        res.status(201).json({ success: true, token, user: getUserData(username) });
    } catch (error) {
        console.error('Register error:', error);
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
        res.json({ success: true, token, user: getUserData(username) });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/auth/verify', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ valid: false });
    const username = tokensDB[token];
    res.json({ valid: true, user: getUserData(username) });
});

// === ПОЛЬЗОВАТЕЛИ ===
app.get('/users', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const userList = Object.values(usersDB).map(u => ({ id: u.id, username: u.username, name: u.name, avatar: u.avatar || null }));
    res.json({ users: userList });
});

app.get('/users/search', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const query = (req.query.q || '').toLowerCase();
    const currentUsername = tokensDB[token];
    if (!query) return res.json({ users: [] });
    const filteredUsers = Object.values(usersDB)
        .filter(u => u.username !== currentUsername)
        .filter(u => u.username.toLowerCase().includes(query) || u.name.toLowerCase().includes(query))
        .map(u => ({ id: u.id, username: u.username, name: u.name, avatar: u.avatar || null }));
    res.json({ users: filteredUsers });
});

// === ПРОФИЛЬ ===
app.put('/profile', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const username = tokensDB[token];
    const { name } = req.body;
    if (!usersDB[username]) return res.status(404).json({ error: 'Пользователь не найден' });
    if (name && name.length >= 2) usersDB[username].name = name;
    res.json({ success: true, user: getUserData(username) });
});

app.put('/profile/avatar', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const username = tokensDB[token];
    const { avatar } = req.body;
    if (!usersDB[username]) return res.status(404).json({ error: 'Пользователь не найден' });
    usersDB[username].avatar = avatar;
    res.json({ success: true, user: getUserData(username) });
});

app.delete('/profile', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const username = tokensDB[token];
    delete usersDB[username];
    delete tokensDB[token];
    delete conversationsDB[username];
    res.json({ success: true });
});

// === УВЕДОМЛЕНИЯ ===
app.post('/notifications/register-token', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const username = tokensDB[token];
    const { deviceToken } = req.body;
    if (!deviceToken) return res.status(400).json({ error: 'deviceToken обязателен' });
    if (!deviceTokensDB[username]) deviceTokensDB[username] = [];
    if (!deviceTokensDB[username].includes(deviceToken)) deviceTokensDB[username].push(deviceToken);
    res.json({ success: true });
});

// === ЧАТЫ ===
app.get('/conversations', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const username = tokensDB[token];
    const conversations = conversationsDB[username] || [];
    
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
    }).filter(c => c !== null);
    
    res.json({ success: true, conversations: enriched });
});

// === СООБЩЕНИЯ ===
app.post('/send', (req, res) => {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken || !tokensDB[authToken]) return res.status(401).json({ error: 'Неавторизован' });
    const username = tokensDB[authToken];
    const { to, text, mediaType, mediaData, duration, fileName, fileSize } = req.body;
    
    if (!to) return res.status(400).json({ error: 'Заполните все поля' });
    if (!usersDB[to]) return res.status(404).json({ error: 'Пользователь не найден' });

    let messageType = 'text';
    if (mediaType && mediaType !== 'text') {
        messageType = mediaType;
    } else if (mediaData && mediaData.startsWith('image')) {
        messageType = 'image';
    } else if (mediaData && mediaData.startsWith('video')) {
        messageType = 'video';
    } else if (mediaData && mediaData.startsWith('audio')) {
        messageType = 'voice';
    }
    
    if (messageType === 'text' && (!text || text.trim() === '')) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const message = {
        id: generateMessageId(),
        from: username,
        to,
        text: text || '',
        mediaType: messageType,
        mediaData: mediaData || null,
        duration: duration || null,
        fileName: fileName || null,
        fileSize: fileSize || null,
        timestamp: new Date().toISOString()
    };

    const chatKey = getChatKey(username, to);
    if (!messagesDB[chatKey]) messagesDB[chatKey] = [];
    messagesDB[chatKey].push(message);

    let preview = text || '';
    if (messageType !== 'text') {
        const labels = {
            'image': '📷 Фото',
            'video': '🎬 Видео',
            'file': '📎 Файл',
            'voice': '🎤 Голосовое',
            'video_note': '⭕ Кружочек'
        };
        preview = labels[messageType] || 'Медиа';
    }
    
    updateConversation(username, to, preview, message.timestamp, messageType);
    updateConversation(to, username, preview, message.timestamp, messageType);
    sendPushNotification(to, text || preview, username, messageType);

    res.status(201).json({ success: true, message });
});

app.get('/history/:user1/:user2', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const { user1, user2 } = req.params;
    const chatKey = getChatKey(user1, user2);
    const history = messagesDB[chatKey] || [];
    res.json({
        success: true,
        count: history.length,
        messages: history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    });
});

// === ЗАПУСК ===
const server = http.createServer(app);
server.timeout = 300000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 URL: https://messangerserver-1.onrender.com`);
});
