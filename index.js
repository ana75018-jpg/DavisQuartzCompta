// ══════════════════════════════════════════════════════
// DAVIS QUARTZ — Bot lecteur Discord → Supabase
// ══════════════════════════════════════════════════════
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ── Config ────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;

const CHANNELS = {
  SERVICE:  process.env.CH_SERVICE,   // #logs-service
  EXPORT:   process.env.CH_EXPORT,    // #logs-export
  IG:       process.env.CH_IG,        // #logs-ig
  FRAIS:    process.env.CH_FRAIS,     // #note-de-frais
};

// ── Clients ───────────────────────────────────────────
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ]
});

// ── Utilitaires ───────────────────────────────────────
function getWeekNum(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function parseEmbedFields(embed) {
  const fields = {};
  (embed.fields || []).forEach(f => {
    const key = f.name.replace(/[^\w]/g, '').toLowerCase();
    fields[key] = f.value.replace(/\*\*/g, '').replace(/<@!?\d+>/g, '').trim();
  });
  // Aussi chercher dans description (format "clé:valeur" sur chaque ligne)
  if (embed.description) {
    embed.description.split('\n').forEach(line => {
      const m = line.match(/^[•\-\*]?\s*(.+?)\s*:\s*(.+)$/);
      if (m) {
        const key = m[1].replace(/[^\w]/g, '').toLowerCase();
        fields[key] = m[2].replace(/\*\*/g, '').trim();
      }
    });
  }
  return fields;
}

function extractName(str) {
  if (!str) return '';
  // Supprimer mentions Discord, parenthèses
  return str.replace(/<@!?\d+>/g, '').replace(/\(.*?\)/g, '').replace(/DM=.*/,'').trim();
}

function extractMoney(str) {
  if (!str) return 0;
  const m = str.match(/[\d,.]+/);
  return m ? parseFloat(m[0].replace(',', '.')) : 0;
}

// ── Parseurs par channel ──────────────────────────────

// #logs-service → "X a commencé/terminé son service"
async function parseService(msg) {
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || '').toLowerCase();
    const desc  = embed.description || '';
    const type  = title.includes('commenc') ? 'debut' : title.includes('termin') ? 'fin' : null;
    if (!type) continue;

    // Extraire le nom : "Carlos Distevia a commencé son service"
    const nomMatch = desc.match(/^(.+?)\s+a\s+(commenc|termin)/i);
    const nom = nomMatch ? nomMatch[1].trim() : desc.split('\n')[0].trim();
    const ts  = msg.createdAt;

    const row = {
      id:        msg.id + '_' + type,
      nom,
      type,
      timestamp: ts.toISOString(),
      semaine:   getWeekNum(ts),
      message_id: msg.id,
    };

    const { error } = await sb.from('discord_services').upsert(row, { onConflict: 'id' });
    if (error) console.error('[SERVICE] Supabase error:', error.message);
    else console.log(`[SERVICE] ${type === 'debut' ? '▶' : '■'} ${nom} — ${ts.toLocaleTimeString('fr-FR')}`);
  }
}

// #logs-export → embed "Export de cartons"
async function parseExport(msg) {
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || embed.author?.name || '').toLowerCase();
    if (!title.includes('export')) continue;

    const desc = embed.description || '';
    
    // Parser la description ligne par ligne
    // Format: "• Employé : @Kayla Moreno - DM=🚫 ( Kayla Moreno )"
    //         "• Discord : 31227736515..."
    //         "• ID perso : 95786"
    //         "• Quantité exportée : 1 cartons"
    //         "• Total semaine : 1 cartons"
    //         "• Date : 07/06/2026"
    //         "• Objectif hebdo : 200 cartons"
    const lines = desc.split('\n').map(l=>l.trim()).filter(Boolean);
    const data = {};
    lines.forEach(line => {
      const m = line.match(/[•\-\*]?\s*(.+?)\s*:\s*(.+)/);
      if (m) {
        const key = m[1].toLowerCase()
          .replace(/[éèê]/g,'e').replace(/[àâ]/g,'a')
          .replace(/[^a-z0-9]/g,'');
        data[key] = m[2].trim();
      }
    });

    // Aussi chercher dans les fields si présents
    (embed.fields||[]).forEach(f => {
      const key = f.name.toLowerCase()
        .replace(/[éèê]/g,'e').replace(/[àâ]/g,'a')
        .replace(/[^a-z0-9]/g,'');
      data[key] = f.value;
    });

    // Extraire les valeurs
    const nomRaw = data['employe'] || data['identite'] || data['nom'] || '';
    // Nettoyer : enlever mentions Discord, DM=🚫, parenthèses avec pseudo
    const nom = nomRaw
      .replace(/<@!?\d+>/g,'')
      .replace(/DM=\S*/g,'')
      .replace(/\(([^)]+)\)/g, (m,p) => p.trim()) // garder le nom entre parenthèses
      .replace(/@\S+/g,'')
      .trim();

    const idPerso  = data['idperso'] || data['identiteperso'] || data['idperso'] || '';
    const quantite = parseInt((data['quantiteexportee']||data['quantiteexporte']||data['quantite']||'0').replace(/[^\d]/g,''))||0;
    const totalSem = parseInt((data['totalsemaine']||data['total']||'0').replace(/[^\d]/g,''))||0;
    const dateStr  = data['date'] || '';
    const objectif = parseInt((data['objectifhebdo']||data['objectif']||'0').replace(/[^\d]/g,''))||0;
    const ts = msg.createdAt;

    if (!nom || quantite === 0) {
      console.log(`[EXPORT] Ignoré - nom:"${nom}" quantite:${quantite} desc:${desc.substring(0,100)}`);
      continue;
    }

    const row = {
      id:            msg.id,
      nom:           nom || nomRaw,
      id_perso:      idPerso,
      quantite,
      total_semaine: totalSem,
      objectif,
      date:          dateStr,
      timestamp:     ts.toISOString(),
      semaine:       getWeekNum(ts),
      message_id:    msg.id,
    };

    const { error } = await sb.from('discord_exports').upsert(row, { onConflict: 'id' });
    if (error) console.error('[EXPORT] Supabase error:', error.message);
    else console.log(`[EXPORT] 📦 ${nom} — ${quantite} cartons (total sem: ${totalSem})`);
  }
}

// #logs-ig → embed "inventory - add"
async function parseIG(msg) {
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || '').toLowerCase();
    if (!title.includes('inventor')) continue;

    const desc = embed.description || '';
    const fields = {};
    desc.split('\n').forEach(line => {
      const m = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (m) fields[m[1].toLowerCase()] = m[2].trim();
    });

    const row = {
      id:           msg.id,
      discord_id:   fields['discord'] || '',
      nom:          fields['name'] || '',
      proper_name:  fields['propername'] || '',
      character_id: fields['characterid'] || '',
      item:         fields['item'] || '',
      count:        parseInt(fields['count'] || '0'),
      date:         fields['date'] || '',
      timestamp:    msg.createdAt.toISOString(),
      message_id:   msg.id,
    };

    if (!row.item) continue;

    const { error } = await sb.from('discord_inventaire').upsert(row, { onConflict: 'id' });
    if (error) console.error('[IG] Supabase error:', error.message);
    else console.log(`[IG] 📦 ${row.proper_name} — ${row.count}x ${row.item}`);
  }
}

// #note-de-frais → embed "NOUVELLE NOTE DE FRAIS"
async function parseFrais(msg) {
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || '').toLowerCase();
    if (!title.includes('note') && !title.includes('frais') && !title.includes('ndf')) continue;

    const fields = parseEmbedFields(embed);
    const nom     = extractName(fields['employe'] || fields['identite'] || fields['identit'] || '');
    const montant = extractMoney(fields['montant'] || fields['amount'] || '0');
    const raison  = fields['raison'] || fields['description'] || fields['motif'] || '';
    const statut  = fields['statut'] || fields['status'] || 'En attente';
    const dateStr = fields['crele'] || fields['date'] || fields['createle'] || '';
    const ndfId   = fields['ndf'] || msg.id;
    const ts      = msg.createdAt;

    if (!nom && !montant) continue;

    // Vérifier les réactions pour statut
    let statutFinal = statut;
    try {
      const reactions = msg.reactions.cache;
      if (reactions.get('✅') && reactions.get('✅').count > 0) statutFinal = 'Approuvé';
      if (reactions.get('🚫') && reactions.get('🚫').count > 0) statutFinal = 'Refusé';
    } catch(e) {}

    const row = {
      id:         msg.id,
      nom,
      montant,
      raison,
      statut:     statutFinal,
      date:       dateStr,
      ndf_id:     ndfId,
      timestamp:  ts.toISOString(),
      semaine:    getWeekNum(ts),
      message_id: msg.id,
    };

    const { error } = await sb.from('discord_frais').upsert(row, { onConflict: 'id' });
    if (error) console.error('[FRAIS] Supabase error:', error.message);
    else console.log(`[FRAIS] 🧾 ${nom} — ${montant}$ (${statutFinal})`);
  }
}

// ── Historique au démarrage (200 derniers messages par channel) ───────────────
async function fetchHistory(channelId, parser) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    let lastId = null;
    let total  = 0;
    while (true) {
      const opts = { limit: 100 };
      if (lastId) opts.before = lastId;
      const msgs = await channel.messages.fetch(opts);
      if (!msgs.size) break;
      for (const msg of msgs.values()) await parser(msg);
      total += msgs.size;
      lastId = msgs.last().id;
      if (msgs.size < 100 || total >= 200) break;
    }
    console.log(`[HISTORY] ${channel.name} — ${total} messages traités`);
  } catch (e) {
    console.error(`[HISTORY] Erreur channel ${channelId}:`, e.message);
  }
}

// ── Événements Discord ────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  console.log('📡 Chargement de l\'historique...');
  await fetchHistory(CHANNELS.SERVICE, parseService);
  await fetchHistory(CHANNELS.EXPORT,  parseExport);
  await fetchHistory(CHANNELS.IG,      parseIG);
  await fetchHistory(CHANNELS.FRAIS,   parseFrais);
  console.log('✅ Historique chargé — en écoute temps réel');
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot && msg.embeds.length === 0) return;
  const id = msg.channelId;
  if (id === CHANNELS.SERVICE) await parseService(msg);
  if (id === CHANNELS.EXPORT)  await parseExport(msg);
  if (id === CHANNELS.IG)      await parseIG(msg);
  if (id === CHANNELS.FRAIS)   await parseFrais(msg);
});

// Réactions sur #note-de-frais → update statut
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.channelId !== CHANNELS.FRAIS) return;
  const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  await parseFrais(msg);
});

client.login(DISCORD_TOKEN);
