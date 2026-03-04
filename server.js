// 1. All Imports & Config
require('dotenv').config(); 
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const { Client, GatewayIntentBits } = require('discord.js');

// 2. Global Variables
let users = {}; // Stores { socketId: { name: username, ip: userIP } }
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
const FIND_IP_CHANNEL_ID = '1478816709048668342'; 

// --- 🛠️ HELPER: Get IP ---
function getIP(reqOrSocket) {
    const headers = reqOrSocket.headers || reqOrSocket.handshake.headers;
    const address = reqOrSocket.ip || reqOrSocket.handshake.address;
    const rawIP = headers['x-forwarded-for'] || address;
    return rawIP.split(',')[0].trim();
}

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
    } catch (err) { console.error(`Discord Error:`, err.message); }
}

// --- AUTO BAN EXPIRY CHECKER ---
setInterval(() => {
    const now = Date.now();
    for (const ip in bannedIPs) {
        if (now >= bannedIPs[ip]) {
            sendToDiscord(ADMIN_CHANNEL_ID, `🔔 **Kiko Guard Notification:** IP \`${ip}\` unbanned ho gayi hai.`);
            delete bannedIPs[ip];
        }
    }
}, 60000);

// --- AGGRESSIVE BAN MIDDLEWARE ---
app.use((req, res, next) => {
    const userIP = getIP(req);
    if (bannedIPs[userIP] && Date.now() < bannedIPs[userIP]) return res.socket.destroy();
    next();
});

// ---------------------------------------------------------
// DISCORD COMMANDS & HELP LOGIC
// ---------------------------------------------------------
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const args = message.content.split(' ');
    const command = message.content.toLowerCase();

    // ✨ SMART HELP FEATURE (Just type ! or !help)
    if (message.content === '!' || command === '!help') {
        let helpMenu = "🤖 **Kiko Bot Help Menu**\n";
        helpMenu += "━━━━━━━━━━━━━━━━━━━━\n";
        helpMenu += "🔹 `!help` or `!` - Show this menu\n";
        helpMenu += "🔹 `!online` - List all users currently on the website\n\n";

        // Find IP Channel Specific
        if (message.channel.id === FIND_IP_CHANNEL_ID || message.channel.id === ADMIN_CHANNEL_ID) {
            helpMenu += "🔍 **Lookup Tools:**\n";
            helpMenu += "🔹 `!findip <username>` - Get a user's live IP\n\n";
        }

        // Admin Channel Specific
        if (message.channel.id === ADMIN_CHANNEL_ID) {
            helpMenu += "🛡️ **Admin Tools:**\n";
            helpMenu += "🔹 `!ipban <IP> <Mins>` - Ban someone (Site unreachable)\n";
            helpMenu += "🔹 `!ipunban <IP>` - Remove ban manually\n";
            helpMenu += "🔹 `!banlist` - See all currently blocked IPs\n";
        }
        helpMenu += "━━━━━━━━━━━━━━━━━━━━";
        return message.reply(helpMenu);
    }

    // ONLINE USERS COMMAND
    if (command === '!online') {
        const onlineUsers = Object.values(users).map(u => u.name);
        return message.reply(onlineUsers.length > 0 ? `👥 **Users Online:** ${onlineUsers.join(', ')}` : "📝 No one is online right now.");
    }

    // FIND IP COMMAND (Case-Insensitive)
    if (message.channel.id === FIND_IP_CHANNEL_ID || message.channel.id === ADMIN_CHANNEL_ID) {
        if (command.startsWith('!findip')) {
            const target = args[1];
            if (!target) return message.reply("❌ Use: `!findip <username>`");
            
            const foundUser = Object.values(users).find(u => u.name.toLowerCase() === target.toLowerCase());
            if (foundUser) {
                message.reply(`🎯 **Found:** \`${foundUser.name}\`\n📍 **Live IP:** \`${foundUser.ip}\`\n🔨 **Quick Ban:** \`!ipban ${foundUser.ip} 20\``);
            } else {
                message.reply(`🤷‍♂️ **${target}** online nahi hai. \`!online\` use karke active users dekhein.`);
            }
            return;
        }
    }

    // ADMIN COMMANDS
    if (message.channel.id === ADMIN_CHANNEL_ID) {
        if (command.startsWith('!ipban')) {
            const targetIP = args[1], minutes = parseInt(args[2]);
            if (targetIP && !isNaN(minutes)) {
                bannedIPs[targetIP] = Date.now() + (minutes * 60000);
                message.reply(`🚫 **Banned:** \`${targetIP}\` for **${minutes}m**. Connection destroyed.`);
                const allSockets = await io.fetchSockets();
                allSockets.forEach(s => { if (getIP(s) === targetIP) s.disconnect(); });
            }
        }

        if (command.startsWith('!ipunban')) {
            delete bannedIPs[args[1]];
            message.reply(`✅ **Unbanned:** \`${args[1]}\``);
        }

        if (command === '!banlist') {
            const list = Object.keys(bannedIPs).filter(ip => bannedIPs[ip] > Date.now());
            message.reply(list.length > 0 ? `📜 **Active Bans:**\n${list.join('\n')}` : "📝 No active bans.");
        }
    }

    // WEB SYNC
    if (message.channel.id === CHAT_CHANNEL_ID) {
        io.emit("chat message", { sender: `[Discord] ${message.author.username}`, message: message.content, id: message.id });
    }
});

// --- SERVER & SOCKET LOGIC ---
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

io.use((socket, next) => {
    const userIP = getIP(socket);
    if (bannedIPs[userIP] && Date.now() < bannedIPs[userIP]) return next(new Error("Banned"));
    next();
});

io.on("connection", (socket) => {
    const userIP = getIP(socket);
    let currentUserName = "";

    socket.on("join", (username) => {
        const isDuplicate = Object.values(users).some(u => u.name.toLowerCase() === username.toLowerCase());
        if (isDuplicate) {
            socket.emit("duplicate");
        } else {
            currentUserName = username;
            users[socket.id] = { name: username, ip: userIP };
            socket.emit("joined", username);
            io.emit("user list", Object.values(users).map(u => u.name));
            sendToDiscord(STATUS_CHANNEL_ID, `🌟 **${username}** joined (IP: \`${userIP}\`)`, true);
        }
    });

    socket.on("chat message", (data) => {
        if (currentUserName) {
            socket.broadcast.emit("chat message", { ...data, id: Date.now().toString(), sender: currentUserName });
            let content = `**${currentUserName}**: ${data.message}`;
            if (data.replyTo) content = `> *Replying to **${data.replyTo.sender}**: ${data.replyTo.message}*\n${content}`;
            sendToDiscord(CHAT_CHANNEL_ID, content);
        }
    });

    socket.on("disconnect", () => {
        if (currentUserName) {
            sendToDiscord(STATUS_CHANNEL_ID, `👋 **${currentUserName}** left`, true);
            delete users[socket.id];
            io.emit("user list", Object.values(users).map(u => u.name));
        }
    });
});

client.on('ready', () => { console.log(`✅ Kiko is online!`); });
const PORT = process.env.PORT || 4000;
client.login(DISCORD_TOKEN).then(() => { http.listen(PORT, () => { console.log(`✅ Server running on port ${PORT}`); }); });
