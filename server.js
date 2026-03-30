const WebSocket = require('ws');

// Создайте WebSocket-сервер
const wss = new WebSocket.Server({ noServer: true });

// Обработчик подключения WebSocket
wss.on('connection', (ws, req) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !tokensDB[token]) return ws.close();

    const username = tokensDB[token];

    // Отправка новых сообщений пользователю
    ws.on('message', async message => {
        console.log(`Received: ${message}`);
    });

    // Функция для отправки сообщения клиенту
    function sendMessage(message) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }

    // Отправка истории сообщений при подключении
    const chatKey = getChatKey(username, req.params.user1);
    const history = messagesDB[chatKey] || [];
    history.forEach(msg => sendMessage(msg));

    // Обновление WebSocket-клиента при получении новых сообщений
    ws.on('close', () => {
        console.log('WebSocket connection closed');
    });
});

// Интеграция WebSocket с HTTP сервером
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});
