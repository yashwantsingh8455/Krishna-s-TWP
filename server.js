// 1. Dependencies & Configuration
require('dotenv').config();
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const fs = require("fs");
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');

// ── Global State ──────────────────────────────────────────────────────────────
let users = {};
let bannedIPs = {};
let shadowBanned = new Set();
let vips = new Set();
let blacklisted = new Set();
const lastSeenMap = {};  // nameLower -> timestamp

// ── Permanent Username Ban List ───────────────────────────────────────────────
const BANNED_FILE = path.join(__dirname, 'banned-usernames.json');
function loadBanned() {
  try {
    if (fs.existsSync(BANNED_FILE))
      return new Set(JSON.parse(fs.readFileSync(BANNED_FILE, 'utf8')));
  } catch {}
  return new Set();
}
function saveBanned() {
  fs.writeFileSync(BANNED_FILE, JSON.stringify([...bannedUsernames]), 'utf8');
}
const bannedUsernames = loadBanned();

// ── Discord Bot ───────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const STATUS_CHANNEL_ID  = '1485502261097398312';
const CHAT_CHANNEL_ID    = '1485501926152863957';
const ADMIN_CHANNEL_ID   = '1485501424891727952';
const FIND_IP_CHANNEL_ID = '1485502368136298569';
const MOD_LOG_CHANNEL_ID = '1485502442610098366';

// ── Helpers ───────────────────────────────────────────────────────────────────
function getIP(socket) {
  try {
    const raw = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    return (raw || '127.0.0.1').split(',')[0].trim();
  } catch { return '127.0.0.1'; }
}

function buildUserList() {
  return Object.values(users).map(u => ({
    name:    u.name,
    bio:     u.bio,
    isVip:   u.isVip,
    isGuest: u.isGuest,
    avatar:  u.avatar || null,
    status:  'online',
    lastSeen: null
  }));
}

async function updateDiscordStatus() {
  try {
    const channel = await client.channels.fetch(STATUS_CHANNEL_ID);
    const count = Object.keys(users).length;
    if (channel) await channel.setName(`🟢-active-${count}`);
    client.user.setActivity(`${count} Users Online`, { type: ActivityType.Watching });
  } catch (e) { console.error('Status Error:', e.message); }
}

// ── Discord Commands ──────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const args    = message.content.split(' ');
  const command = args[0].toLowerCase();

  if (message.channel.id === ADMIN_CHANNEL_ID) {

    if (command === '!ann') {
      const msg = args.slice(1).join(' ');
      if (!msg) return message.reply('❌ Use: `!ann <message>`');
      io.emit('announcement', msg);
      return message.reply('✅ Announcement sent!');
    }

    if (command === '!vip') {
      const target = args[1];
      if (!target) return message.reply('❌ Use: `!vip <username>`');
      vips.add(target.toLowerCase());
      io.emit('vip_update', target.toLowerCase());
      return message.reply(`💎 **${target}** is now VIP!`);
    }

    if (command === '!sban') {
      const target = args[1];
      if (!target) return message.reply('❌ Use: `!sban <username>`');
      shadowBanned.add(target.toLowerCase());
      return message.reply(`🕵️ **${target}** shadow banned.`);
    }

    if (command === '!unban') {
      const target = args[1];
      if (!target) return message.reply('❌ Use: `!unban <username>`');
      bannedUsernames.delete(target.toLowerCase());
      blacklisted.delete(target.toLowerCase());
      saveBanned();
      return message.reply(`✅ **${target}** unban ho gaya.`);
    }

    // Block karo permanently + disconnect
    if (command === '!black') {
      const target = args[1];
      if (!target) return message.reply('❌ Use: `!black <username>`');
      const nameLower = target.toLowerCase();
      blacklisted.add(nameLower);
      bannedUsernames.add(nameLower);
      saveBanned();
      const entry = Object.entries(users).find(([, u]) => u.name.toLowerCase() === nameLower);
      if (entry) {
        io.to(entry[0]).emit('ban_alert', '⛔ Aapka account blacklist kar diya gaya hai.');
        setTimeout(() => io.sockets.sockets.get(entry[0])?.disconnect(), 600);
      }
      return message.reply(`⛔ **${target}** blacklisted + permanently banned!`);
    }

    // Kick (temporary)
    if (command === '!kick') {
      const target = args[1];
      if (!target) return message.reply('❌ Use: `!kick <username>`');
      const entry = Object.entries(users).find(([, u]) => u.name.toLowerCase() === target.toLowerCase());
      if (!entry) return message.reply(`❓ **${target}** not found online.`);
      io.to(entry[0]).emit('ban_alert', '👢 Aapko chat se kick kar diya gaya.');
      setTimeout(() => io.sockets.sockets.get(entry[0])?.disconnect(), 600);
      return message.reply(`👢 **${target}** kicked!`);
    }

    // Online users list
    if (command === '!online') {
      const list = Object.values(users)
        .map(u => `• **${u.name}**${u.isGuest?' (Guest)':''} | \`${u.ip}\``)
        .join('\n') || 'Koi nahi abhi.';
      return message.reply(`**Online (${Object.keys(users).length}):**\n${list}`);
    }
  }

  if (message.channel.id === FIND_IP_CHANNEL_ID || message.channel.id === ADMIN_CHANNEL_ID) {
    if (command === '!findip') {
      const target = args[1];
      const found  = Object.values(users).find(u => u.name.toLowerCase() === (target||'').toLowerCase());
      if (found) return message.reply(`🎯 **${found.name}** | IP: \`${found.ip}\``);
      return message.reply(`❓ **${target}** not found.`);
    }
  }

if (message.channel.id === CHAT_CHANNEL_ID) {
    io.emit('chat message', {
      sender:  "Admin", // Yahan fix kar diya gaya hai
      message: message.content,
      id:      'd-' + Date.now(),
      isVip:   true,
      type:    'text'
    });
  }
});

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const userIP = getIP(socket);
  let currentUserName = '';

  if (bannedIPs[userIP] && Date.now() < bannedIPs[userIP]) {
    socket.emit('ban_alert', '🚫 Your IP is banned!');
    return socket.disconnect();
  }

  // ── JOIN ───────────────────────────────────────────────────────────────────
  socket.on('join', (data) => {
    let username = ((typeof data === 'object' ? data.name : data) || '').trim();
    const bio     = (typeof data === 'object' ? data.bio  : '') || 'No bio';
    const isGuest = typeof data === 'object' ? !!data.isGuest : false;
    const avatar  = typeof data === 'object' ? (data.avatar || null) : null;

    if (isGuest) {
      username = 'Guest_' + Math.floor(Math.random() * 90000 + 10000);
    }

    if (!username) return;
    const nameLower = username.toLowerCase();

    if (blacklisted.has(nameLower))
      return socket.emit('ban_alert', '⛔ Aapka account blacklist kar diya gaya hai.');

    if (!isGuest && bannedUsernames.has(nameLower))
      return socket.emit('duplicate', `"${username}" username available nahi hai.`);

    if (Object.values(users).some(u => u.name.toLowerCase() === nameLower))
      return socket.emit('duplicate', `"${username}" abhi koi use kar raha hai!`);

    currentUserName = username;
    users[socket.id] = { name: username, ip: userIP, bio, isVip: vips.has(nameLower), isGuest, avatar, joinedAt: Date.now() };

    if (!isGuest) { bannedUsernames.add(nameLower); saveBanned(); }

    // Personal room for DMs
    socket.join(`user:${nameLower}`);

    socket.emit('joined', { username, isGuest });
    io.emit('user list', buildUserList());
    io.emit('system message', `${username}${isGuest ? ' 👻' : ''} joined the chat`);
    updateDiscordStatus();

    const joinEmbed = new EmbedBuilder()
      .setColor(isGuest ? '#888888' : '#2ecc71')
      .setTitle(`🚀 ${username} joined!`)
      .addFields(
        { name: '👤 User',  value: `**${username}**`,  inline: true },
        { name: '📍 IP',    value: `\`${userIP}\``,    inline: true },
        { name: '🎭 Type',  value: isGuest ? '`👻 Guest`' : '`Member`', inline: true },
        { name: '📝 Bio',   value: bio,                inline: false }
      )
      .setTimestamp();
    client.channels.cache.get(STATUS_CHANNEL_ID)?.send({ embeds: [joinEmbed] });
  });

  // ── GROUP CHAT ─────────────────────────────────────────────────────────────
  socket.on('chat message', (data) => {
    if (!currentUserName) return;
    const u = users[socket.id];

    if (u?.isGuest && data.type !== 'text')
      return socket.emit('system message', '👻 Guests can only send text. Register to unlock more!');

    const payload = {
      id:      Date.now().toString() + Math.random().toString(36).substr(2, 4),
      message: data.message,
      sender:  currentUserName,
      type:    data.type || 'text',
      replyTo: data.replyTo || null,
      isVip:   vips.has(currentUserName.toLowerCase()),
      isGuest: u?.isGuest || false
    };

    if (shadowBanned.has(currentUserName.toLowerCase())) {
      socket.emit('chat message', payload);
    } else {
      io.emit('chat message', payload);
      if (data.type === 'text')
        client.channels.cache.get(CHAT_CHANNEL_ID)?.send(`**${currentUserName}**: ${data.message}`);
    }
  });

  // ── DIRECT MESSAGE ────────────────────────────────────────────────────────
  socket.on('dm', (data) => {
    if (!currentUserName) return;
    const u = users[socket.id];
    if (u?.isGuest) return socket.emit('dm_error', '👻 Guests cannot DM. Please register!');

    const { to, message, type } = data;
    if (!to || !message) return;

    const payload = {
      id:        Date.now().toString() + Math.random().toString(36).substr(2, 4),
      from:      currentUserName,
      to:        to,
      message:   message,
      type:      type || 'text',
      timestamp: Date.now()
    };

    // To recipient
    socket.to(`user:${to.toLowerCase()}`).emit('dm', payload);
    // Back to sender
    socket.emit('dm', payload);
  });

  // ── DM TYPING ─────────────────────────────────────────────────────────────
  socket.on('dm_typing', ({ to }) => {
    if (!currentUserName || !to) return;
    socket.to(`user:${to.toLowerCase()}`).emit('dm_typing', { from: currentUserName });
  });

  // ── GROUP TYPING ──────────────────────────────────────────────────────────
  socket.on('typing', (data) => {
    socket.broadcast.emit('typing', { user: data.user || currentUserName });
  });

  // ── DELETE ────────────────────────────────────────────────────────────────
  socket.on('delete message', (id) => {
    if (!currentUserName) return;
    io.emit('delete message', id);
  });

  // ── UPDATE PROFILE ────────────────────────────────────────────────────────
  socket.on('update profile', (data) => {
    const u = users[socket.id];
    if (!u || u.isGuest) return;
    if (data.bio    !== undefined) u.bio    = data.bio;
    if (data.avatar !== undefined) u.avatar = data.avatar;
    io.emit('user list', buildUserList());
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (currentUserName) {
      const wasGuest = users[socket.id]?.isGuest;
      lastSeenMap[currentUserName.toLowerCase()] = Date.now();
      delete users[socket.id];
      io.emit('user list', buildUserList());
      io.emit('user_last_seen', { name: currentUserName, lastSeen: lastSeenMap[currentUserName.toLowerCase()] });
      io.emit('system message', `${currentUserName} left the chat`);
      updateDiscordStatus();
    }
  });
});

// ── Static + Start ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 4000;

client.on('ready', () => {
  console.log('✅ Kiko Bot Online!');
  updateDiscordStatus();
});

client.login(DISCORD_TOKEN).then(() => {
  http.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
});
