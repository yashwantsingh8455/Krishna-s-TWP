// server.js
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");

let users = {}; // { socket.id: username }
let messages = {}; // { id: { text, userId } }

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Default route
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/Group-Chatroom.html");
});

// Socket.IO connection
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
    }
  });

  // server.js ke andar "chat message" wala section replace karein
  socket.on("chat message", (data) => {
    if (currentUser) {
      const messageId = Date.now().toString(); // Hum 'broadcast' use karenge taaki bhejnewale ko dubara na mile
      // Aur pura data object bhejenge (sender, message, replyTo)
      socket.broadcast.emit("chat message", {
        ...data,
        id: messageId,
        sender: currentUser,
      }); // Storage logic

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
      delete users[socket.id];
      io.emit("user list", Object.values(users));
      socket.broadcast.emit("server message", `${currentUser} left the chat`);
    }
  });
});










// Discord automated join and leave bot
const express = require("express");
const path = require("path");
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');

// --- DISCORD BOT SETUP ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

require('dotenv').config(); // Sabse upar add karein

// Purani token line ko replace karein
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const STATUS_CHANNEL_ID = '1478764395491495977'; 

// Function: Update Channel Name & Send Logs
async function sendDiscordLog(message, updateCount = false) {
    try {
        const channel = await client.channels.fetch(STATUS_CHANNEL_ID);
        if (channel) {
            // Send the Text Message (Automatic)
            await channel.send(message);
            
            // If updateCount is true, change channel name too
            if (updateCount) {
                const onlineCount = Object.keys(users).length;
                await channel.setName(`🟢-active-${onlineCount}`);
            }
        }
    } catch (err) {
        console.error("Discord Error:", err.message);
    }
}

app.use(express.static(path.join(__dirname, "public")));

// --- SOCKET.IO LOGIC ---
io.on("connection", (socket) => {
    let currentUser = "";

    // 1. AUTOMATIC JOIN MESSAGE
    socket.on("join", (username) => {
        if (!Object.values(users).includes(username)) {
            currentUser = username;
            users[socket.id] = username;

            socket.emit("joined", username);
            io.emit("user list", Object.values(users));

            // Discord Notification
            sendDiscordLog(`🌟 **${username}** is active now in our website`, true);
        }
    });

    // 2. AUTOMATIC LEAVE MESSAGE
    socket.on("disconnect", () => {
        if (currentUser) {
            // Discord Notification
            sendDiscordLog(`👋 **${currentUser}** has been left our site`, true);
            
            delete users[socket.id];
            io.emit("user list", Object.values(users));
        }
    });

    // Chat Message Logic
    socket.on("chat message", (data) => {
        if (currentUser) {
            socket.broadcast.emit("chat message", { ...data, sender: currentUser });
        }
    });
});

// Bot Ready
client.on('ready', () => {
    console.log(`✅ Discord Bot logged in as ${client.user.tag}`);
});
// ...........................................................................................active and leavebot code ended here








// Start server
const PORT = process.env.PORT || 4000;
http.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
