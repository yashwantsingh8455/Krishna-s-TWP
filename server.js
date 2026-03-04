// 1. All Imports & Config
require('dotenv').config(); 
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const { Client, GatewayIntentBits } = require('discord.js');

// 2. Global Variables
let users = {}; 
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
const STATUS_CHANNEL_ID = '1478764395491495977'; // Logs & Online Count
const CHAT_CHANNEL_ID   = '1478795441926836298'; // Website ↔ Discord Chat Sync
const ADMIN_CHANNEL_ID  = '1478734555971063971'; // Ban/Unban Commands (Private)

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
        console.error(`Discord Error in channel ${channelId}:`, err.message);
    }
}

// ---------------------------------------------------------
// DISCORD COMMANDS & SYNC LOGIC
// ---------------------------------------------------------
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // A. ADMIN COMMANDS (Sirf Admin Channel mein)
    if (message.channel.id === ADMIN_CHANNEL_ID) {
        const args = message.content.split(' ');

        // 1. Ban: !ban <IP> <Minutes>
        if (message.content.startsWith('!ban')) {
            const targetIP = args[1];
            const minutes = parseInt(args[2]);
            if (targetIP && !isNaN(minutes)) {
                bannedIPs[targetIP] = Date.now() + minutes * 60000;
                message.reply(`🚫 **Kiko Guard:** IP \`${targetIP}\` banned for **${minutes} minutes**.`);
                
                const allSockets = await io.fetchSockets();
                allSockets.forEach(s => {
                    const ip = s.handshake.headers['x-forwarded-for'] || s.handshake.address;
                    if (ip.includes(targetIP)) s.disconnect();
                });
            } else {
                message.reply("❌ Use: `!ban <IP> <Mins>`");
            }
        }

        // 2. Unban: !unban <IP>
        if (message.content.startsWith('!unban')) {
            const targetIP = args[1];
            if (targetIP) {
                delete bannedIPs[targetIP];
                message.reply(`✅ **Kiko Guard:** IP \`${targetIP}\` unbanned.`);
            }
        }
    }

    // B. WEB SYNC (Sirf Chat Channel se)
    if (message.channel.id === CHAT_CHANNEL_ID) {
        io.emit("chat message", {
            sender: `[Discord] ${message.author.username}`,
            message: message.content,
            id: message.id
        });
    }
});

// 4. Routes & Middleware
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- SOCKET.IO SECURITY MIDDLEWARE ---
io.use((socket, next) => {
    const userIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (bannedIPs[userIP] && Date.now() < bannedIPs[userIP]) {
        return next(new Error("Banned"));
    }
    next();
});

// 5. Merged Socket.IO Connection
io.on("connection", (socket) => {
    const userIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    let currentUser = "";

    // JOIN LOGIC with Full IP Logging
    socket.on("join", (username) => {
        if (Object.values(users).includes(username)) {
            socket.emit("duplicate");
        } else {
            currentUser = username;
            users[socket.id] = username;
            socket.emit("joined", username);
            io.emit("user list", Object.values(users));
            socket.broadcast.emit("server message", `${username} joined the chat`);

            // Detailed Log in Status Channel
            const logMsg = `🌟 **${username}** joined the chat\n📍 **Full IP Address:** \`${userIP}\``;
            sendToDiscord(STATUS_CHANNEL_ID, logMsg, true);
        }
    });

    // CHAT MESSAGE with Reply Support
    socket.on("chat message", (data) => {
        if (currentUser) {
            const messageId = Date.now().toString();
            socket.broadcast.emit("chat message", { ...data, id: messageId, sender: currentUser });

            let discordContent = `**${currentUser}**: ${data.message}`;
            if (data.replyTo) {
                // Formatting for Discord Quote
                discordContent = `> *Replying to **${data.replyTo.sender}**: ${data.replyTo.message}*\n${discordContent}`;
            }
            sendToDiscord(CHAT_CHANNEL_ID, discordContent);

            messages[messageId] = { text: data.message, userId: socket.id };
        }
    });

    socket.on("disconnect", () => {
        if (currentUser) {
            sendToDiscord(STATUS_CHANNEL_ID, `👋 **${currentUser}** left the site (IP: \`${userIP}\`)`, true);
            delete users[socket.id];
            io.emit("user list", Object.values(users));
        }
    });
});

// 6. Start Kiko
client.on('ready', () => { 
    console.log(`✅ Kiko Bot is online as ${client.user.tag}`); 
});

const PORT = process.env.PORT || 4000;
client.login(DISCORD_TOKEN).then(() => {
    http.listen(PORT, () => { console.log(`✅ Server running on http://localhost:${PORT}`); });
});
