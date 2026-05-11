// ── 1. CONFIGURATION & MODULES ──────────────────────────────────────────────
require('dotenv').config();
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const fs = require("fs");
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');

// ── 2. GLOBAL STATE & PERSISTENCE ───────────────────────────────────────────
let users = {};          
let shadowBanned = new Set();
let vips = new Set();
const ADMIN_NAME = 'Yashwant'; 

const BANNED_FILE = path.join(__dirname, 'banned-usernames.json');
let bannedUsernames = new Set();

if (fs.existsSync(BANNED_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(BANNED_FILE, 'utf8'));
        bannedUsernames = new Set(data);
    } catch (e) { console.error("Error loading ban list:", e); }
}

function saveBanned() {
    fs.writeFileSync(BANNED_FILE, JSON.stringify([...bannedUsernames]), 'utf8');
}

// ── 3. DISCORD BOT SETUP ────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const CLIENT_ID          = process.env.CLIENT_ID;
const CHAT_CHANNEL_ID    = '1485501926152863957'; 
const STATUS_CHANNEL_ID  = '1485502261097398312'; 
const MOD_LOG_CHANNEL_ID = '1503383670558294137'; 
const CONTROL_CHANNEL_ID = '1485501424891727952'; 

// ── 4. REGISTER SLASH COMMANDS (FIXED SlashCommandBuilder) ──────────────────
const commands = [
    new SlashCommandBuilder()
        .setName('ann')
        .setDescription('Send a global announcement')
        .addStringOption(opt => opt.setName('message').setDescription('Announcement text').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a user from web chat')
        .addStringOption(opt => opt.setName('username').setDescription('Username to kick').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Permanently ban a username')
        .addStringOption(opt => opt.setName('username').setDescription('Username to ban').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('vip')
        .setDescription('Assign VIP status to a user')
        .addStringOption(opt => opt.setName('username').setDescription('Username for VIP').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('online')
        .setDescription('Show all online web users')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (err) { console.error(err); }
})();

// ── 5. HELPERS ──────────────────────────────────────────────────────────────
function getIP(socket) {
    const raw = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    return (raw || '127.0.0.1').split(',')[0].trim();
}

function buildUserList() {
    return Object.values(users).map(u => ({
        name: u.name,
        bio: u.bio,
        isVip: u.isVip
    }));
}

async function updateDiscordStatus() {
    try {
        const count = Object.keys(users).length;
        client.user?.setActivity(`${count} Strangers Online`, { type: ActivityType.Watching });
        const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
        if (channel && channel.isTextBased()) {
            // Optional: Update channel name if it's a voice/stage channel or special
            await channel.setName(`🟢-active-${count}`).catch(() => {});
        }
    } catch (e) { console.log("Status Update Error:", e.message); }
}

// ── 6. DISCORD INTERACTION (SLASH COMMANDS) ─────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.channelId !== CONTROL_CHANNEL_ID) {
        return interaction.reply({ content: '❌ Use commands in the Admin Control channel!', ephemeral: true });
    }

    const { commandName, options } = interaction;

    if (commandName === 'ann') {
        const msg = options.getString('message');
        io.emit('announcement', msg);
        await interaction.reply(`📢 Announcement Sent: **${msg}**`);
    }

    if (commandName === 'kick') {
        const target = options.getString('username').toLowerCase();
        const sid = Object.keys(users).find(id => users[id].name.toLowerCase() === target);
        if (sid) {
            io.to(sid).emit('duplicate', '👢 You were kicked by an admin.');
            io.sockets.sockets.get(sid)?.disconnect();
            await interaction.reply(`✅ **${target}** has been kicked.`);
        } else await interaction.reply('❓ User online nahi hai.');
    }

    if (commandName === 'ban') {
        const target = options.getString('username').toLowerCase();
        bannedUsernames.add(target);
        saveBanned();
        const sid = Object.keys(users).find(id => users[id].name.toLowerCase() === target);
        if (sid) io.sockets.sockets.get(sid)?.disconnect();
        await interaction.reply(`🚫 **${target}** has been permanently banned.`);
    }

    if (commandName === 'vip') {
        const target = options.getString('username').toLowerCase();
        vips.add(target);
        io.emit('vip_update', target);
        await interaction.reply(`💎 **${target}** is now a VIP!`);
    }

    if (commandName === 'online') {
        const list = Object.values(users).map(u => `• ${u.name}`).join('\n') || 'No one online.';
        await interaction.reply(`**Web Users Online (${Object.keys(users).length}):**\n${list}`);
    }
});

// ── 7. DISCORD CHAT MIRRORING ───────────────────────────────────────────────
client.on('messageCreate', (message) => {
    if (message.author.bot || message.channel.id !== CHAT_CHANNEL_ID) return;
    if (message.content.startsWith('/')) return;

    io.emit('chat message', {
        id: 'd-' + Date.now(),
        sender: 'Admin',
        message: message.content,
        type: 'text',
        isVip: true,
        createdAt: new Date()
    });
});

// ── 8. SOCKET.IO (WEB LOGIC) ────────────────────────────────────────────────
io.on('connection', (socket) => {
    const userIP = getIP(socket);
    let currentUserName = '';

    socket.on('join', (data) => {
        const name = (data.name || '').trim();
        const bio = (data.bio || 'No bio').trim();
        const nameLower = name.toLowerCase();

        if (bannedUsernames.has(nameLower)) return socket.emit('duplicate', 'You are banned from this chat.');
        if (Object.values(users).some(u => u.name.toLowerCase() === nameLower)) return socket.emit('duplicate', 'Name is already in use.');

        currentUserName = name;
        users[socket.id] = { 
            name, 
            bio, 
            ip: userIP, 
            isVip: vips.has(nameLower) || name === ADMIN_NAME 
        };
        
        socket.join(`user:${nameLower}`);
        socket.emit('joined');
        io.emit('user list', buildUserList());
        io.emit('system message', `${name} joined the chat`);
        updateDiscordStatus();

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle('📥 New Join')
            .setDescription(`**Name:** ${name}\n**IP:** \`${userIP}\`\n**Bio:** ${bio}`)
            .setTimestamp();
        client.channels.cache.get(MOD_LOG_CHANNEL_ID)?.send({ embeds: [embed] });
    });

    socket.on('chat message', (data) => {
        if (!currentUserName) return;
        const payload = { 
            ...data, 
            sender: currentUserName, 
            isVip: users[socket.id]?.isVip || false, 
            createdAt: new Date() 
        };
        
        if (!shadowBanned.has(currentUserName.toLowerCase())) {
            socket.broadcast.emit('chat message', payload);
            if (payload.type === 'text') {
                client.channels.cache.get(CHAT_CHANNEL_ID)?.send(`**${currentUserName}**: ${payload.message}`);
            }
        } else {
            socket.emit('chat message', payload);
        }
    });

    socket.on('private message', (data) => {
        if (!currentUserName) return;
        socket.to(`user:${data.receiver.toLowerCase()}`).emit('private message', { 
            ...data, 
            sender: currentUserName, 
            createdAt: new Date() 
        });
    });

    socket.on('report user', (data) => {
        const embed = new EmbedBuilder()
            .setColor('#ff4757')
            .setTitle('🚩 New Report')
            .addFields(
                { name: 'Target', value: data.reportedUser, inline: true },
                { name: 'Reason', value: data.reason, inline: true },
                { name: 'Reporter', value: data.reportedBy, inline: true },
                { name: 'Description', value: data.description || 'No details' }
            )
            .setTimestamp();
        client.channels.cache.get(MOD_LOG_CHANNEL_ID)?.send({ embeds: [embed] });
    });

    socket.on('typing', () => socket.broadcast.emit('typing', { user: currentUserName }));
    socket.on('delete message', (id) => io.emit('delete message', id));

    socket.on('disconnect', () => {
        if (currentUserName) {
            io.emit('system message', `${currentUserName} left the chat`);
            delete users[socket.id];
            io.emit('user list', buildUserList());
            updateDiscordStatus();
        }
    });
});

// ── 9. START SERVER ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 4000;

client.on('ready', () => {
    console.log(`✅ Discord Bot logged in as ${client.user.tag}`);
    updateDiscordStatus();
});

client.login(DISCORD_TOKEN).catch(err => console.error("Discord Login Error:", err));

http.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
