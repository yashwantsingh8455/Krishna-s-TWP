// 1. All Imports & Config
require('dotenv').config(); 
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const { Client, GatewayIntentBits } = require('discord.js');

// 2. Global Variables
let users = {}; // Now stores { socketId: { name: username, ip: userIP } }
let messages = {}; 
let bannedIPs = {}; // { ip: expiry_timestamp }

// 3. Discord Bot Setup (Kiko)
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
    ]
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// CHANNEL IDs SETUP
const STATUS_CHANNEL_ID = '1478764395491495977'; 
const CHAT_CHANNEL_ID   = '1478795441926836298'; 
const ADMIN_CHANNEL_ID  = '1478734555971063971'; 
const FIND_IP_CHANNEL_ID = '1478816709048668342'; // 👈 Naya Channel ID yahan daalein

// --- 🛠️ HELPER: Get IP for both Express & Socket ---
function getIP(reqOrSocket) {
    const headers = reqOrSocket.headers || reqOrSocket.handshake.headers;
    const address = reqOrSocket.ip || reqOrSocket.handshake.address;
    const rawIP = headers['x-forwarded-for'] || address;
    return rawIP.split(',')[0].trim();
}

// Helper Function: Send Discord Message
async function sendToDiscord(channelId, message, updateName = false) {
    try {
        if (!channelId) return;
        const channel = await client.channels.fetch(channelId);
        if (channel) {
            await channel.send(message);
            if (updateName && channelId === STATUS_CHANNEL_ID) {
                const onlineCount = Object.keys(users).length;
                await channel.setName(`🟢-active-${onlineCount}`);
            }
        }
    } catch (err) {
        console.error(`Discord Error:`, err.message);
    }
}

// ---------------------------------------------------------
// AUTO BAN EXPIRY CHECKER (Har 1 minute mein check karega)
// ---------------------------------------------------------
setInterval(() => {
    const now = Date.now();
    for (const ip in bannedIPs) {
        if (now >= bannedIPs[ip]) {
            sendToDiscord(ADMIN_CHANNEL_ID, `🔔 **Kiko Guard Notification:** IP \`${ip}\` ka ban time poora ho gaya hai. Woh ab website access kar sakta hai.`);
            delete bannedIPs[ip];
        }
    }
}, 60000);

// ---------------------------------------------------------
// 4. AGGRESSIVE BAN MIDDLEWARE (HTTP Level)
// ---------------------------------------------------------
app.use((req, res, next) => {
    const userIP = getIP(req);
    if (bannedIPs[userIP] && Date.now() < bannedIPs[userIP]) {
        return res.socket.destroy(); 
    }
    next();
});

// ---------------------------------------------------------
// DISCORD COMMANDS & SYNC LOGIC
// ---------------------------------------------------------
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const args = message.content.split(' ');

    // 🔍 NEW: Find IP by Username Command
    if (message.channel.id === FIND_IP_CHANNEL_ID || message.channel.id === ADMIN_CHANNEL_ID) {
        if (message.content.startsWith('!findip')) {
            const targetUsername = args[1];
            if (!targetUsername) return message.reply("❌ **Usage:** `!findip <username>`");

            // Online users mein dhoondo
            const foundUser = Object.values(users).find(u => u.name === targetUsername);

            if (foundUser) {
                message.reply(`🎯 **User Found:** \`${targetUsername}\`\n📍 **Live IP:** \`${foundUser.ip}\`\n\nAb aap use ban kar sakte hain: \`!ipban ${foundUser.ip} 20\``);
            } else {
                message.reply(`🤷‍♂️ **${targetUsername}** abhi website par online nahi hai.`);
            }
            return;
        }
    }

    // Admin Commands (Ban/Unban)
    if (message.channel.id === ADMIN_CHANNEL_ID) {
        if (message.content.startsWith('!ipban')) {
            const targetIP = args[1];
            const minutes = parseInt(args[2]);
            if (targetIP && !isNaN(minutes)) {
                bannedIPs[targetIP] = Date.now() + (minutes * 60000);
                message.reply(`🚫 **Kiko Guard:** IP \`${targetIP}\` block kar di gayi hai **${minutes} minutes** ke liye.`);
                
                const allSockets = await io.fetchSockets();
                allSockets.forEach(s => {
                    if (getIP(s) === targetIP) s.disconnect();
                });
            } else {
                message.reply("❌ **Format:** `!ipban <IP> <Minutes>`");
            }
        }

        if (message.content.startsWith('!ipunban')) {
            const targetIP = args[1];
            if (targetIP) {
                delete bannedIPs[targetIP];
                message.reply(`✅ **Kiko Guard:** IP \`${targetIP}\` manually unban kar di gayi.`);
            }
        }

        if (message.content === '!banlist') {
            const list = Object.keys(bannedIPs).filter(ip => bannedIPs[ip] > Date.now());
            message.reply(list.length > 0 ? `📜 **Active Bans:**\n${list.join('\n')}` : "📝 No active bans.");
        }
    }

    // Chat Sync
    if (message.channel.id === CHAT_CHANNEL_ID) {
        io.emit("chat message", {
            sender: `[Discord] ${message.author.username}`,
            message: message.content,
            id: message.id
        });
    }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

// --- SOCKET.IO SECURITY MIDDLEWARE ---
io.use((socket, next) => {
    const userIP = getIP(socket);
    if (bannedIPs[userIP] && Date.now() < bannedIPs[userIP]) {
        return next(new Error("Banned"));
    }
    next();
});

// 6. Merged Socket.IO Connection
io.on("connection", (socket) => {
    const userIP = getIP(socket);
    let currentUserName = "";

    socket.on("join", (username) => {
        // Duplicate check using the new object structure
        const isDuplicate = Object.values(users).some(u => u.name === username);
        
        if (isDuplicate) {
            socket.emit("duplicate");
        } else {
            currentUserName = username;
            // Store both name and IP 
            users[socket.id] = { name: username, ip: userIP };
            
            socket.emit("joined", username);
            io.emit("user list", Object.values(users).map(u => u.name));
            socket.broadcast.emit("server message", `${username} joined the chat`);

            const logMsg = `🌟 **${username}** joined the chat\n📍 **Real IP:** \`${userIP}\``;
            sendToDiscord(STATUS_CHANNEL_ID, logMsg, true);
        }
    });

    socket.on("chat message", (data) => {
        if (currentUserName) {
            const messageId = Date.now().toString();
            socket.broadcast.emit("chat message", { ...data, id: messageId, sender: currentUserName });

            let discordContent = `**${currentUserName}**: ${data.message}`;
            if (data.replyTo) {
                discordContent = `> *Replying to **${data.replyTo.sender}**: ${data.replyTo.message}*\n${discordContent}`;
            }
            sendToDiscord(CHAT_CHANNEL_ID, discordContent);
            messages[messageId] = { text: data.message, userId: socket.id };
        }
    });

    socket.on("disconnect", () => {
        if (currentUserName) {
            sendToDiscord(STATUS_CHANNEL_ID, `👋 **${currentUserName}** left the chat`, true);
            delete users[socket.id];
            io.emit("user list", Object.values(users).map(u => u.name));
        }
    });
});

// 7. Start Kiko
client.on('ready', () => { console.log(`✅ Kiko Bot is online as ${client.user.tag}`); });

const PORT = process.env.PORT || 4000;
client.login(DISCORD_TOKEN).then(() => {
    http.listen(PORT, () => { console.log(`✅ Server running on port ${PORT}`); });
});
