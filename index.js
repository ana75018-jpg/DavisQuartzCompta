// DAVIS QUARTZ — Bot lecteur Discord → Supabase
const { Client, GatewayIntentBits, Events, Partials } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;

const CHANNELS = {
  SERVICE: process.env.CH_SERVICE,
  EXPORT:  process.env.CH_EXPORT,
  IG:      process.env.CH_IG,
  FRAIS:   process.env.CH_FRAIS,
};

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

function getWeekNum(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function extractNom(str) {
  if (!str) return '';
  return str
    .replace(/<@!?\d+>/g, '')
    .replace(/DM=\S*/gi, '')
    .replace(/\(([^)]+)\)/, (_, p) => ' ' + p)
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMontant(str) {
  if (!str) return 0;
  const m = str.match(/[\d,.]+/);
  return m ? parseFloat(m[0].replace(',', '.')) : 0;
}

function parseDesc(desc) {
  const data = {};
  (desc || '').split('\n').forEach(line => {
    const m = line.match(/[•\-\*🔷🔹📦📊📅🎯💼🆔👤]?\s*\*?\*?([^:]+?)\*?\*?\s*:\s*(.+)/);
    if (m) {
      const key = m[1].trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
      data[key] = m[2].trim();
    }
  });
  return data;
}

// ── Parseurs ──────────────────────────────────────────

async function parseService(msg) {
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || '').toLowerCase();
    const desc  = embed.description || '';
    const type  = title.includes('commenc') ? 'debut' : title.includes('termin') ? 'fin' : null;
    if (!type) continue;
    const nomMatch = desc.match(/^(.+?)\s+a\s+(commenc|termin)/i);
    const nom = nomMatch ? nomMatch[1].trim() : desc.split('\n')[0].trim();
    const ts  = msg.createdAt;
    const row = { id: msg.id+'_'+type, nom, type, timestamp: ts.toISOString(), semaine: getWeekNum(ts), message_id: msg.id };
    const { error } = await sb.from('discord_services').upsert(row, { onConflict: 'id' });
    if (error) console.error('[SERVICE] ERR:', error.message);
    else console.log(`[SERVICE] ${type==='debut'?'▶':'■'} ${nom} — ${ts.toLocaleTimeString('fr-FR')}`);
  }
}

async function parseExport(msg) {
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || embed.author?.name || '').toLowerCase();
    if (!title.includes('export')) continue;
    
    const desc = embed.description || '';
    const data = parseDesc(desc);
    
    // Chercher le nom dans différentes clés possibles
    const nomRaw = data['employe'] || data['employee'] || data['identite'] || data['nom'] || '';
    const nom = extractNom(nomRaw);
    
    // Chercher la quantité
    const qStr = data['quantiteexportee'] || data['quantiteexporte'] || data['quantite'] || data['cartons'] || '0';
    const quantite = parseInt(qStr.replace(/[^\d]/g, '')) || 0;
    
    const totalStr = data['totalsemaine'] || data['total'] || '0';
    const totalSem = parseInt(totalStr.replace(/[^\d]/g, '')) || 0;
    
    const idPerso = data['idperso'] || data['idpersonnage'] || '';
    const dateStr = data['date'] || '';
    const ts = msg.createdAt;

    if (!nom) { console.log('[EXPORT] Nom vide, ignoré. nomRaw:', nomRaw); continue; }

    const row = { id: msg.id, nom, id_perso: idPerso, quantite, total_semaine: totalSem, date: dateStr, timestamp: ts.toISOString(), semaine: getWeekNum(ts), message_id: msg.id };
    const { error } = await sb.from('discord_exports').upsert(row, { onConflict: 'id' });
    if (error) console.error('[EXPORT] ERR:', error.message);
    else console.log(`[EXPORT] 📦 ${nom} — ${quantite} cartons`);
  }
}

async function parseIG(msg) {
  // Faab'Hook peut envoyer soit des embeds soit du texte brut
  const toProcess = [];

  // Cas 1 : embeds Discord
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || embed.author?.name || '').toLowerCase();
    if (title.includes('inventor')) {
      toProcess.push({ title, desc: embed.description || '' });
    }
  }

  // Cas 2 : texte brut du message (pas d'embed)
  if (!toProcess.length && msg.content) {
    const content = msg.content;
    const titleMatch = content.match(/^(inventory\s*-\s*(?:add|remove))/im);
    if (titleMatch) {
      toProcess.push({ title: titleMatch[1].toLowerCase(), desc: content });
    }
  }

  for (const { title, desc } of toProcess) {
    const action = title.includes('remove') ? 'remove' : 'add';
    const data = parseDesc(desc);

    const row = {
      id:           data['uuid'] || msg.id,
      discord_id:   data['discord'] || '',
      nom:          data['name'] || '',
      proper_name:  data['propername'] || '',
      character_id: data['characterid'] || '',
      source:       data['source'] || '',
      owner:        data['owner'] || '',
      item:         data['item'] || '',
      count:        parseInt((data['count']||'0').replace(/[^\d]/g,''))||0,
      action,
      date:         data['date'] || '',
      timestamp:    msg.createdAt.toISOString(),
      message_id:   msg.id,
    };

    if (!row.item) {
      console.log('[IG] Ignoré - pas de item. data:', JSON.stringify(data).substring(0,100));
      continue;
    }

    const { error } = await sb.from('discord_inventaire').upsert(row, { onConflict: 'id' });
    if (error) console.error('[IG] ERR:', error.message);
    else console.log(`[IG] ${action==='add'?'➕':'➖'} ${row.proper_name} — ${row.count}x ${row.item} (${row.owner})`);
  }
}

async function parseFrais(msg) {
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || '').toLowerCase();
    if (!title.includes('note') && !title.includes('frais') && !title.includes('ndf')) continue;
    const desc = embed.description || '';
    const data = parseDesc(desc);
    const nomRaw = data['identite'] || data['employe'] || data['employee'] || data['nom'] || '';
    const nom = extractNom(nomRaw);
    const montant = parseMontant(data['montant'] || data['amount'] || '0');
    const raison = data['raison'] || data['description'] || data['motif'] || '';
    const payeePar = data['payeepar'] || data['payepar'] || '';
    
    // Statut : depuis le titre ou le champ statut
    let statut = 'En attente';
    const titleLow = title.toLowerCase();
    if(titleLow.includes('pay')) statut = 'Payee';
    const statutRaw = (data['statut'] || data['status'] || '').toLowerCase();
    if(statutRaw.includes('pay')) statut = 'Payee';
    if(statutRaw.includes('approuv') || statutRaw.includes('accept')) statut = 'Approuve';
    if(statutRaw.includes('refus')) statut = 'Refuse';
    
    const dateStr = data['creele'] || data['date'] || data['creale'] || '';
    if (!nom) { console.log('[FRAIS] Nom vide, ignoré'); continue; }
    let statutFinal = statut;
    try {
      const reactions = msg.reactions.cache;
      if (reactions.get('✅')?.count > 0) statutFinal = 'Approuve';
      if (reactions.get('🚫')?.count > 0) statutFinal = 'Refuse';
    } catch(e) {}
    const row = { id: msg.id, nom, montant, raison, statut: statutFinal, payee_par: payeePar, date: dateStr, timestamp: msg.createdAt.toISOString(), semaine: getWeekNum(msg.createdAt), message_id: msg.id };
    const { error } = await sb.from('discord_frais').upsert(row, { onConflict: 'id' });
    if (error) console.error('[FRAIS] ERR:', error.message);
    else console.log(`[FRAIS] 🧾 ${nom} — ${montant}$ (${statutFinal})`);
  }
}

// ── Historique ────────────────────────────────────────
async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchHistory(channelId, parser, name) {
  try {
    console.log(`[HISTORY] Tentative ${name} (${channelId})...`);
    const channel = await client.channels.fetch(channelId);
    if (!channel) { console.log(`[HISTORY] ${name}: channel null`); return; }
    console.log(`[HISTORY] ${name}: #${channel.name} trouvé`);
    let lastId = null, total = 0;
    while (true) {
      const opts = { limit: 100 };
      if (lastId) opts.before = lastId;
      const msgs = await channel.messages.fetch(opts);
      if (!msgs.size) break;
      for (const msg of msgs.values()) await parser(msg);
      total += msgs.size;
      lastId = msgs.last().id;
      console.log(`[HISTORY] ${name}: ${total} messages traités...`);
      await sleep(500); // pause entre chaque batch pour éviter le crash
      if (msgs.size < 100) break;
    }
    console.log(`[HISTORY] ${name}: ${total} messages traités (terminé)`);
  } catch(e) {
    console.error(`[HISTORY] ${name} ERREUR:`, e.message, '| code:', e.code);
  }
}

// ── Événements ────────────────────────────────────────
client.on(Events.ClientReady, async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  console.log('📡 Guilds:', client.guilds.cache.map(g=>g.name).join(', '));
  await fetchHistory(CHANNELS.SERVICE, parseService, 'SERVICE');
  await fetchHistory(CHANNELS.EXPORT,  parseExport,  'EXPORT');
  await fetchHistory(CHANNELS.IG,      parseIG,       'IG');
  await fetchHistory(CHANNELS.FRAIS,   parseFrais,    'FRAIS');
  console.log('✅ Historique chargé — écoute temps réel active');
});

client.on(Events.MessageCreate, async (msg) => {
  if (!msg.embeds.length) return;
  const id = msg.channelId;
  if (id === CHANNELS.SERVICE) await parseService(msg);
  if (id === CHANNELS.EXPORT)  await parseExport(msg);
  if (id === CHANNELS.IG)      await parseIG(msg);
  if (id === CHANNELS.FRAIS)   await parseFrais(msg);
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.channelId !== CHANNELS.FRAIS) return;
  console.log(`[FRAIS] Réaction ${reaction.emoji.name} de ${user.tag}`);
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    const msg = reaction.message;
    await parseFrais(msg);
  } catch(e) {
    console.error('[FRAIS] Erreur réaction:', e.message);
  }
});

// Détecter les modifications de messages NDF (statut changé par le bot Secrétaire)
client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
  if (newMsg.channelId !== CHANNELS.FRAIS) return;
  try {
    const msg = newMsg.partial ? await newMsg.fetch() : newMsg;
    if (!msg.embeds.length) return;
    const title = (msg.embeds[0]?.title || '').toLowerCase();
    if (!title.includes('frais') && !title.includes('ndf')) return;
    console.log(`[FRAIS] Message modifié — ${title}`);
    await parseFrais(msg);
  } catch(e) {
    console.error('[FRAIS] Erreur update:', e.message);
  }
});

client.on(Events.Error, e => console.error('Discord error:', e.message));

client.login(DISCORD_TOKEN);
