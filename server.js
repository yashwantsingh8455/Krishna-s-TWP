// 1. All Imports & Config (Sare require ek sath)
require('dotenv').config(); 
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const { Client, GatewayIntentBits } = require('discord.js');

// 2. Global Variables
let users = {}; // { socket.id: username }
let messages = {}; // { id: { text, userId } }

// 3. Discord Bot Setup
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const STATUS_CHANNEL_ID = '1478764395491495977';

// Helper Function: Send Discord Logs
async function sendDiscordLog(message, updateCount = false) {
    try {
        const channel = await client.channels.fetch(STATUS_CHANNEL_ID);
        if (channel) {
            await channel.send(message);
            if (updateCount) {
                const onlineCount = Object.keys(users).length;
                await channel.setName(`🟢-active-${onlineCount}`);
            }
        }
    } catch (err) {
        console.error("Discord Error:", err.message);
    }
}

// 4. Routes & Middleware
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 5. Merged Socket.IO Connection (Sirf EK baar)
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

            // Discord Join Notification
            sendDiscordLog(`🌟 **${username}** is active now in our website`, true);
        }
    });

    // --- Chat message ---
    socket.on("chat message", (data) => {
        if (currentUser) {
            const messageId = Date.now().toString();
            socket.broadcast.emit("chat message", {
                ...data,
                id: messageId,
                sender: currentUser,
            });
            messages[messageId] = { text: data.message, userId: socket.id };
        }
    });

    // --- Chat image ---
    socket.on("chat image", (data) => {
        io.emit("chat image", { user: currentUser, data });
    });

    // --- Delete message ---
    socket.on("deleteMessage", (id) => {
        if (messages[id] && messages[id].userId === socket.id) {
            delete messages[id];
            io.emit("deleteMessage", id);
        }
    });

    // --- Edit message ---
    socket.on("editMessage", ({ id, newText }) => {
        if (messages[id] && messages[id].userId === socket.id) {
            messages[id].text = newText;
            io.emit("editMessage", { id, newText });
        }
    });

    // --- Disconnect ---
    socket.on("disconnect", () => {
        if (currentUser) {
            // Discord Leave Notification
            sendDiscordLog(`👋 **${currentUser}** has been left our site`, true);

            delete users[socket.id];
            io.emit("user list", Object.values(users));
            socket.broadcast.emit("server message", `${currentUser} left the chat`);
        }
    });
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
