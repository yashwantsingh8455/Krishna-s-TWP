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

// CHANNEL IDs SETUP (Inhe Private Rakhein)
const STATUS_CHANNEL_ID  = '1478764395491495977'; 
const CHAT_CHANNEL_ID    = '1478795441926836298'; 
const ADMIN_CHANNEL_ID   = '1478734555971063971'; 
const FIND_IP_CHANNEL_ID = '1478816709048668342'; 
const MOD_LOG_CHANNEL_ID = '1478824787743735859'; 

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

    // ✨ SMART HELP
    if (message.content === '!' || command === '!help') {
        let helpText = "🤖 **Kiko Admin Menu**\n━━━━━━━━━━━━━━━━━━━━\n";
        if (message.channel.id === ADMIN_CHANNEL_ID) {
            helpText += "🛡️ **Admin Tools:** `!ipban IP1,IP2 <Mins>`, `!ipunban`, `!banlist` (IPs only visible here)\n";
        } else if (message.channel.id === FIND_IP_CHANNEL_ID) {
            helpText += "🔍 **Staff Tools:** `!findip <username>`, `!online` (IP retrieval)\n";
        } else {
            helpText += "🔹 `!help` or `!online` - No private data shown here.\n";
        }
        return message.reply(helpText + "━━━━━━━━━━━━━━━━━━━━");
    }

    // 🛡️ ADMIN CHANNEL: Multiple Ban/Unban with Alert Logic
    if (message.channel.id === ADMIN_CHANNEL_ID) {
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
                        allSockets.forEach(s => { 
                            if (getIP(s) === ip) {
                                // User ko message bhej rahe hain disconnect karne se pehle
                                s.emit("ban_alert", "🚫 You are banned by admin! 🔨"); 
                                setTimeout(() => s.disconnect(), 1500); 
                            } 
                        });
                    }
                });

                message.reply(`🚫 **Success:** Total **${ipList.length}** IPs banned with Alert.`);
                sendToDiscord(MOD_LOG_CHANNEL_ID, `🛡️ **MOD LOG: BAN**\n👤 **Admin:** ${message.author.tag}\n📍 **IPs:** \`${ipList.join(', ')}\`\n⏳ **Duration:** ${mins} mins`);
            } else message.reply("❌ Use: `!ipban IP1,IP2 <Mins>`");
            return;
        }

        if (command.startsWith('!ipunban')) {
            const ipInput = args[1];
            if (ipInput) {
                const ipList = ipInput.split(',').map(i => i.trim());
                ipList.forEach(ip => delete bannedIPs[ip]);
                message.reply(`✅ **Success:** **${ipList.length}** IPs unbanned.`);
                sendToDiscord(MOD_LOG_CHANNEL_ID, `🛡️ **MOD LOG: UNBAN**\n👤 **Admin:** ${message.author.tag}\n📍 **IPs:** \`${ipList.join(', ')}\``);
                return;
            }
        }

        if (command === '!banlist') {
            const list = Object.keys(bannedIPs).filter(i => bannedIPs[i] > Date.now());
            return message.reply(list.length > 0 ? `📜 **Banned IPs:**\n${list.join('\n')}` : "📝 No bans.");
        }
    }

    // 🔍 FIND IP CHANNEL
    if (message.channel.id === FIND_IP_CHANNEL_ID || message.channel.id === ADMIN_CHANNEL_ID) {
        if (command.startsWith('!findip')) {
            const target = args[1];
            const found = Object.values(users).find(u => u.name.toLowerCase() === (target || "").toLowerCase());
            if (found) {
                return message.reply(`🎯 **User Found:** \`${found.name}\`\n📍 **Private IP:** \`${found.ip}\`\n🔨 Ban: \`!ipban ${found.ip} 20\``);
            }
            return message.reply(`🤷‍♂️ **${target}** online nahi hai.`);
        }
        if (command === '!online') {
            const list = Object.values(users).map(u => u.name);
            return message.reply(list.length > 0 ? `👥 **Online:** ${list.join(', ')}` : "📝 No one online.");
        }
    }

    // 💬 CHAT SYNC (IP-Free)
    if (message.channel.id === CHAT_CHANNEL_ID) {
        io.emit("chat message", { sender: `[Discord] ${message.author.username}`, message: message.content, id: message.id });
    }
});

// --- SERVER & SOCKET LOGIC ---
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

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
            
            // Web privacy: No IP broadcast
            io.emit("user list", Object.values(users).map(u => u.name));
            
            // Discord Private Admin log: IP visible only to you
            sendToDiscord(STATUS_CHANNEL_ID, `🌟 **${username}** joined\n📍 **Private IP:** \`${userIP}\``, true);
        }
    });

    socket.on("chat message", (data) => {
        if (currentUserName) {
            socket.broadcast.emit("chat message", { ...data, id: Date.now().toString(), sender: currentUserName });
            sendToDiscord(CHAT_CHANNEL_ID, `**${currentUserName}**: ${data.message}`);
        }
    });

    socket.on("disconnect", () => {
        if (currentUserName) {
            sendToDiscord(STATUS_CHANNEL_ID, `👋 **${currentUserName}** left (Logged IP: \`${userIP}\`)`, true);
            delete users[socket.id];
            io.emit("user list", Object.values(users).map(u => u.name));
        }
    });
});

client.on('ready', () => { console.log(`✅ Kiko is online!`); });
const PORT = process.env.PORT || 4000;
client.login(DISCORD_TOKEN).then(() => { http.listen(PORT, () => { console.log(`✅ Server running on port ${PORT}`); }); });
