// 1. All Imports & Config
require('dotenv').config(); 
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// 2. Global Variables
let users = {}; 
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
const STATUS_CHANNEL_ID  = '1478764395491495977'; 
const CHAT_CHANNEL_ID    = '1478795441926836298'; 
const ADMIN_CHANNEL_ID   = '1478734555971063971'; 
const FIND_IP_CHANNEL_ID = '1478816709048668342'; 
const MOD_LOG_CHANNEL_ID = 'YOUR_NEW_LOG_CHANNEL_ID'; // 👈 Yahan naya log channel ID daalein

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
            // Mod Log mein bhi notify karein
            sendToDiscord(MOD_LOG_CHANNEL_ID, `✅ **Auto-Unban:** IP \`${ip}\` ka ban time khatam ho gaya.`);
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
// DISCORD COMMANDS: Role-Based Channel Logic
// ---------------------------------------------------------
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const args = message.content.split(' ');
    const command = message.content.toLowerCase();

    // ✨ 1. SMART HELP
    if (message.content === '!' || command === '!help') {
        let helpText = "🤖 **Kiko Smart Menu**\n━━━━━━━━━━━━━━━━━━━━\n";

        if (message.channel.id === ADMIN_CHANNEL_ID) {
            helpText += "🛡️ **Admin Tools (Multiple Support):**\n🔹 `!ipban IP1,IP2 <Mins>`\n🔹 `!ipunban IP1,IP2`\n🔹 `!banlist`\n";
        } 
        else if (message.channel.id === FIND_IP_CHANNEL_ID) {
            helpText += "🔍 **Lookup Tools (Staff):**\n🔹 `!findip <username>`\n🔹 `!online`\n";
        } 
        else {
            helpText += "🔹 `!help` - Show menu\n🔹 `!online` - active users\n";
        }
        return message.reply(helpText + "━━━━━━━━━━━━━━━━━━━━");
    }

    // 🛡️ 2. ADMIN CHANNEL: Multiple Ban/Unban with Logs
    if (message.channel.id === ADMIN_CHANNEL_ID) {
        // MULTIPLE BAN LOGIC
        if (command.startsWith('!ipban')) {
            const ipInput = args[1];
            const mins = parseInt(args[2]);

            if (ipInput && !isNaN(mins)) {
                const ipList = ipInput.split(',').map(i => i.trim());
                const expiry = Date.now() + (mins * 60000);
                const allSockets = await io.fetchSockets();

                ipList.forEach(ip => {
                    if (ip) {
                        bannedIPs[ip] = expiry;
                        allSockets.forEach(s => { if (getIP(s) === ip) s.disconnect(); });
                    }
                });

                message.reply(`🚫 **Success:** Total **${ipList.length}** IPs banned.`);
                
                // 📝 MODERATION LOG
                const logMsg = `🛡️ **MOD LOG: BAN**\n👤 **Admin:** ${message.author.tag}\n📍 **IPs:** \`${ipList.join(', ')}\`\n⏳ **Duration:** ${mins} mins`;
                sendToDiscord(MOD_LOG_CHANNEL_ID, logMsg);
            } else message.reply("❌ Use: `!ipban IP1,IP2 <Mins>`");
            return;
        }

        // MULTIPLE UNBAN LOGIC
        if (command.startsWith('!ipunban')) {
            const ipInput = args[1];
            if (ipInput) {
                const ipList = ipInput.split(',').map(i => i.trim());
                ipList.forEach(ip => delete bannedIPs[ip]);
                
                message.reply(`✅ **Success:** **${ipList.length}** IPs unbanned.`);
                
                // 📝 MODERATION LOG
                const logMsg = `🛡️ **MOD LOG: UNBAN**\n👤 **Admin:** ${message.author.tag}\n📍 **IPs:** \`${ipList.join(', ')}\``;
                sendToDiscord(MOD_LOG_CHANNEL_ID, logMsg);
                return;
            }
        }

        if (command === '!banlist') {
            const list = Object.keys(bannedIPs).filter(i => bannedIPs[i] > Date.now());
            return message.reply(list.length > 0 ? `📜 **Banned IPs:**\n${list.join('\n')}` : "📝 No bans.");
        }
    }

    // 🔍 3. FIND IP CHANNEL COMMANDS
    if (message.channel.id === FIND_IP_CHANNEL_ID || message.channel.id === ADMIN_CHANNEL_ID) {
        if (command.startsWith('!findip')) {
            const target = args[1];
            if (!target) return message.reply("❌ Use: `!findip <username>`");
            const found = Object.values(users).find(u => u.name.toLowerCase() === target.toLowerCase());
            if (found) {
                return message.reply(`🎯 **User Found:** \`${found.name}\`\n📍 **IP:** \`${found.ip}\`\n🔨 Ban: \`!ipban ${found.ip} 20\``);
            }
            return message.reply(`🤷‍♂️ **${target}** online nahi hai.`);
        }
        if (command === '!online') {
            const list = Object.values(users).map(u => u.name);
            return message.reply(list.length > 0 ? `👥 **Online:** ${list.join(', ')}` : "📝 No one online.");
        }
    }

    // 💬 4. CHAT SYNC
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
        if (isDuplicate) socket.emit("duplicate");
        else {
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
