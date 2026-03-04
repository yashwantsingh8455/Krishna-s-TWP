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

// 3. Discord Bot Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
    ]
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// IDs Setup
const STATUS_CHANNEL_ID = '1478764395491495977'; // Join/Leave notifications
const CHAT_CHANNEL_ID = '1478795441926836298';  // Website ↔ Discord Chat Sync

// Helper Function: Send Discord Message
async function sendToDiscord(channelId, message, updateName = false) {
    try {
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

// Discord to Website Sync
client.on('messageCreate', async (message) => {
    if (message.author.bot || message.channel.id !== CHAT_CHANNEL_ID) return;

    io.emit("chat message", {
        sender: `[Discord] ${message.author.username}`,
        message: message.content,
        id: message.id
    });
});

// 4. Routes & Middleware
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 5. Merged Socket.IO Connection (All events go inside here)
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    let currentUser = "";

    // --- User joins ---
    socket.on("join", (username) => {
        if (Object.values(users).includes(username)) {
            socket.emit("duplicate");
        } else {
            currentUser = username;
            users[socket.id] = username;
            socket.emit("joined", username);
            io.emit("user list", Object.values(users));
            socket.broadcast.emit("server message", `${username} joined the chat`);

            // Join message STATUS channel mein jayega
            sendToDiscord(STATUS_CHANNEL_ID, `🌟 **${username}** is active now in our website`, true);
        }
    });

    // --- Chat message (Integrated with Reply Sync) ---
    socket.on("chat message", (data) => {
        if (currentUser) {
            const messageId = Date.now().toString();
            
            // 1. Website par baaki users ko bhejein
            socket.broadcast.emit("chat message", {
                ...data,
                id: messageId,
                sender: currentUser,
            });

            // 2. Discord ke liye format karein (Checking for replies)
            let discordContent = `**${currentUser}**: ${data.message}`;

            if (data.replyTo) {
                // Discord Quote format for replies
                discordContent = `> *Replying to **${data.replyTo.sender}**: ${data.replyTo.message}*\n${discordContent}`;
            }

            // 3. Discord CHAT channel mein bhejein
            sendToDiscord(CHAT_CHANNEL_ID, discordContent);

            messages[messageId] = { text: data.message, userId: socket.id };
        }
    });

    socket.on("chat image", (data) => {
        io.emit("chat image", { user: currentUser, data });
    });

    socket.on("disconnect", () => {
        if (currentUser) {
            sendToDiscord(STATUS_CHANNEL_ID, `👋 **${currentUser}** has been left our site`, true);
            delete users[socket.id];
            io.emit("user list", Object.values(users));
            socket.broadcast.emit("server message", `${currentUser} left the chat`);
        }
    });

    // Edit/Delete events should also be placed here
});

// 6. Discord Ready Event
client.on('ready', () => {
    console.log(`✅ Discord Bot logged in as ${client.user.tag}`);
});

// 7. Start Server
const PORT = process.env.PORT || 4000;
client.login(DISCORD_TOKEN).then(() => {
    http.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
    });
});
