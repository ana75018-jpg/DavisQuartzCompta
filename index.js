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
    // Format "→ Clé: valeur" ou "• Clé: valeur" ou "Clé: valeur"
    const m = line.match(/^[→•\-\*🔷🔹📦📊📅🎯💼🆔👤🧾🟡🔵🟠⚪🏷️💵🔗📋🆔📌🔢💳⏱️✅❌🎫🏦]?\s*\*?\*?([^:]+?)\*?\*?\s*:\s*(.+)/);
    if (m) {
      const key = m[1].trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
      data[key] = m[2].trim();
    }
  });
  return data;
}

// Parse embed fields (format field.name / field.value)
function parseFields(fields) {
  const data = {};
  (fields || []).forEach(f => {
    const key = (f.name || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[→•\s]/g, '')
      .replace(/[^a-z0-9]/g, '');
    const val = (f.value || '').trim();
    data[key] = val;
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

    // Format nouveau : "Kayla Moreno a commencé/terminé son service."
    // Format ancien : même
    const nomMatch = desc.match(/^(.+?)\s+a\s+(commenc|termin)/i);
    const nom = nomMatch ? nomMatch[1].trim().replace(/["""]/g, "'") : desc.split('\n')[0].trim();

    // Timestamp : footer "Début/Fin de service le 13/06/2026 à 13:42"
    let ts = msg.createdAt;
    const footer = embed.footer?.text || '';
    const dateMatch = footer.match(/(\d{2})\/(\d{2})\/(\d{4})\s+à\s+(\d{2}):(\d{2})/);
    if (dateMatch) {
      const [, day, month, year, hour, min] = dateMatch;
      ts = new Date(`${year}-${month}-${day}T${hour}:${min}:00`);
    }

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
    // Essayer fields d'abord (nouveau format), sinon description
    let data = {};
    if (embed.fields && embed.fields.length > 0) {
      data = parseFields(embed.fields);
    } else {
      data = parseDesc(desc);
    }
    // Aussi parser la description si elle contient des lignes → Clé: valeur
    const descData = parseDesc(desc);
    Object.assign(data, descData);

    // Nom : "→ Nom: Marlon Clark"
    const nomRaw = data['nom'] || data['employe'] || data['employee'] || data['identite'] || '';
    const nom = extractNom(nomRaw);

    // Quantité exportée cette transaction
    const qStr = data['quantiteexportee'] || data['quantiteexporte'] || data['quantite'] || data['cartons'] || '0';
    const quantite = parseInt(qStr.replace(/[^\d]/g, '')) || 0;

    // Total semaine
    const totalStr = data['totalsemaine'] || data['total'] || '0';
    const totalSem = parseInt(totalStr.replace(/[^\d]/g, '')) || 0;

    // Character ID / Source
    const idPerso = data['characterid'] || data['idperso'] || data['idpersonnage'] || data['source'] || '';

    const ts = msg.createdAt;
    if (!nom) { console.log('[EXPORT] Nom vide, ignoré. data:', JSON.stringify(data)); continue; }

    const row = { id: msg.id, nom, id_perso: idPerso, quantite, total_semaine: totalSem, timestamp: ts.toISOString(), semaine: getWeekNum(ts), message_id: msg.id };
    const { error } = await sb.from('discord_exports').upsert(row, { onConflict: 'id' });
    if (error) console.error('[EXPORT] ERR:', error.message);
    else console.log(`[EXPORT] 📦 ${nom} — ${quantite} cartons (total sem: ${totalSem})`);
  }
}

async function parseIG(msg) {
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || '').toLowerCase();
    if (!title.includes('inventor')) continue;
    const action = title.includes('remove') ? 'remove' : 'add';

    // Les données sont dans les fields de l'embed
    const data = {};
    (embed.fields || []).forEach(f => {
      const key = (f.name || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
      // La valeur est format "clé:valeur"
      const val = (f.value || '').trim();
      const m = val.match(/^[a-z]+:(.+)$/i);
      data[key] = m ? m[1].trim() : val;
    });


    const row = {
      id:           (data['uuid'] || msg.id) + '_' + action + '_' + msg.createdAt.getTime(),
      discord_id:   data['discord'] || '',
      nom:          data['name'] || '',
      proper_name:  data['propername'] || '',
      character_id: data['characterid'] || '',
      source:       data['source'] || '',
      owner:        data['owner'] || '',
      item:         (data['item'] || '').toLowerCase(),
      count:        parseInt((data['count'] || '0').replace(/[^\d]/g, '')) || 0,
      action,
      date:         data['date'] || '',
      timestamp:    msg.createdAt.toISOString(),
      message_id:   msg.id,
    };

    if (!row.item) {
      
      continue;
    }

    const { error } = await sb.from('discord_inventaire').upsert(row, { onConflict: 'id' });
    if (error) console.error('[IG] ERR:', error.message);
  }
}

async function parseFrais(msg) {
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || '').toLowerCase();
    if (!title.includes('note') && !title.includes('frais') && !title.includes('ndf')) continue;

    const desc = embed.description || '';
    // Merger fields + description
    let data = {};
    if (embed.fields && embed.fields.length > 0) {
      data = parseFields(embed.fields);
    }
    const descData = parseDesc(desc);
    Object.assign(data, descData);

    // Nom : priorité à "Identité" (vrai nom RP) sur "Employé" (pseudo Discord)
    const nomRaw = data['identite'] || data['nom'] || data['employe'] || data['employee'] || '';
    const nom = extractNom(nomRaw);

    // Montant : "600$"
    const montant = parseMontant(data['montant'] || data['amount'] || '0');

    // Raison
    const raison = data['raison'] || data['description'] || data['motif'] || '';

    // Statut depuis le champ + réactions boutons ✅/❌
    let statut = 'En attente';
    const statutRaw = (data['statut'] || data['status'] || '').toLowerCase();
    if (statutRaw.includes('pay')) statut = 'Payee';
    if (statutRaw.includes('approuv') || statutRaw.includes('accept')) statut = 'Approuve';
    if (statutRaw.includes('refus')) statut = 'Refuse';
    if (title.includes('pay')) statut = 'Payee';

    // Réactions Discord (boutons ✅ Accepter / ❌ Refuser)
    try {
      const reactions = msg.reactions.cache;
      if (reactions.get('✅')?.count > 0) statut = 'Approuve';
      if (reactions.get('❌')?.count > 0 || reactions.get('🚫')?.count > 0) statut = 'Refuse';
    } catch(e) {}

    // Aussi chercher dans les components (boutons)
    try {
      for (const row of (msg.components || [])) {
        for (const comp of (row.components || [])) {
          const label = (comp.label || '').toLowerCase();
          if (label.includes('accept') && comp.disabled) statut = 'Approuve';
          if (label.includes('refus') && comp.disabled) statut = 'Refuse';
        }
      }
    } catch(e) {}

    const payeePar = data['payeepar'] || data['payepar'] || '';
    if (!nom) { console.log('[FRAIS] Nom vide, ignoré. data:', JSON.stringify(data)); continue; }

    const row = { id: msg.id, nom, montant, raison, statut, payee_par: payeePar, timestamp: msg.createdAt.toISOString(), semaine: getWeekNum(msg.createdAt), message_id: msg.id };
    const { error } = await sb.from('discord_frais').upsert(row, { onConflict: 'id' });
    if (error) console.error('[FRAIS] ERR:', error.message);
    else console.log(`[FRAIS] 🧾 ${nom} — ${montant}$ (${statut})`);
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
      // pas de log intermédiaire pour éviter SIGTERM
      await sleep(500); // pause entre chaque batch pour éviter le crash
      if (msgs.size < 100 || total >= 500) break;
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
