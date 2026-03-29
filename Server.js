const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(bodyParser.json({ limit: '10mb' }));

app.use((req, res, next) => {
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
    return [user1, user2].sort().join('_');
}

function generateUserId() {
    return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function updateConversation(username, chatWith, lastMessage, timestamp) {
    if (!conversationsDB[username]) conversationsDB[username] = [];
    const existing = conversationsDB[username].find(c => c.chatWith === chatWith);
    if (existing) {
        existing.lastMessage = lastMessage;
        existing.timestamp = timestamp;
    } else {
        conversationsDB[username].push({ chatWith, lastMessage, timestamp, unreadCount: 0 });
    }
    conversationsDB[username].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function sendPushNotification(toUsername, messageText, fromUsername) {
    const tokens = deviceTokensDB[toUsername];
    if (!tokens || tokens.length === 0) {
        console.log(`🔔 [NOTIFICATION] Нет токенов для ${toUsername}`);
        return;
    }
    console.log(`🔔 [NOTIFICATION] 📱 ${toUsername}: ${fromUsername} отправил "${messageText}"`);
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
        console.log(`✅ [REGISTER] ${username} (${userId})`);
        res.status(201).json({ success: true, token, user: getUserData(username) });
    } catch (error) {
        console.error('❌ [REGISTER ERROR]', error);
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
        console.log(`✅ [LOGIN] ${username}`);
        res.json({ success: true, token, user: getUserData(username) });
    } catch (error) {
        console.error('❌ [LOGIN ERROR]', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/auth/verify', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ valid: false });
    const username = tokensDB[token];
    const user = usersDB[username];
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
    console.log(`✏️ [PROFILE UPDATE] ${username}: name = ${name}`);
    res.json({ success: true, user: getUserData(username) });
});

app.put('/profile/avatar', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const username = tokensDB[token];
    const { avatar } = req.body;
    if (!usersDB[username]) return res.status(404).json({ error: 'Пользователь не найден' });
    usersDB[username].avatar = avatar;
    console.log(`🖼️ [AVATAR] ${username} обновил аватар`);
    res.json({ success: true, user: getUserData(username) });
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
    console.log(`🔔 [NOTIFICATION] Токен сохранён для ${username}`);
    res.json({ success: true });
});

// === ЧАТЫ ===
app.get('/conversations', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const username = tokensDB[token];
    const conversations = conversationsDB[username] || [];
    const enriched = conversations.map(conv => ({
        ...conv,
        user: usersDB[conv.chatWith] ? { id: usersDB[conv.chatWith].id, username: usersDB[conv.chatWith].username, name: usersDB[conv.chatWith].name, avatar: usersDB[conv.chatWith].avatar || null } : null
    })).filter(c => c.user !== null);
    res.json({ success: true, conversations: enriched });
});

// === СООБЩЕНИЯ ===
app.post('/send', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return res.status(401).json({ error: 'Неавторизован' });
    const username = tokensDB[token];
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Заполните все поля' });
    if (!usersDB[to]) return res.status(404).json({ error: 'Пользователь не найден' });

    const message = { id: Date.now().toString(), from: username, to, text, timestamp: new Date().toISOString() };
    const chatKey = getChatKey(username, to);
    if (!messagesDB[chatKey]) messagesDB[chatKey] = [];
    messagesDB[chatKey].push(message);
    console.log(`💬 [MESSAGE] ${username} → ${to}: ${text}`);

    updateConversation(username, to, text, message.timestamp);
    updateConversation(to, username, text, message.timestamp);

    sendPushNotification(to, text, username);
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
app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Сервер запущен на порту ' + PORT);
    console.log('🌐 URL: http://localhost:' + PORT);
});
