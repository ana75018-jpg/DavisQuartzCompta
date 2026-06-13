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
  FRAIS2:  process.env.CH_FRAIS2,
};

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
function isFraisChannel(id) {
  return id === CHANNELS.FRAIS || (CHANNELS.FRAIS2 && id === CHANNELS.FRAIS2);
}
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
  let s = str.replace(/`/g, '').replace(/\*\*/g, '').replace(/DM=\S*/gi, '').trim();
  // Format "Kayla Moreno" → direct
  // Format "<@ID> (pseudo)" → prendre le pseudo entre parenthèses en dernier recours
  // Format "@Kayla Moreno - (pseudo)" → prendre avant la mention
  const beforeMention = s.match(/^([^<@][^<]*?)\s*(?:<@|@)/);
  if (beforeMention && beforeMention[1].trim().length > 1) return beforeMention[1].trim();
  // Retirer les mentions Discord
  s = s.replace(/<@!?\d+>/g, '').trim();
  // Retirer les @pseudo
  s = s.replace(/@\w+/g, '').trim();
  // S'il reste quelque chose entre parenthèses, le prendre (pseudo Discord)
  const inParens = s.match(/\(([^)]+)\)/);
  if (inParens) s = inParens[1].trim();
  return s.replace(/\s+/g, ' ').trim();
}

function parseMontant(str) {
  if (!str) return 0;
  const m = str.match(/[\d,.]+/);
  return m ? parseFloat(m[0].replace(',', '.')) : 0;
}

function parseDesc(desc) {
  const data = {};
  (desc || '').split('\n').forEach(line => {
    // Nettoyer les emojis et caractères spéciaux en début de ligne
    const cleaned = line.replace(/^[\s\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}🔷🔹📦📊📅🎯💼🆔👤🧾🟡🔵🟠⚪🏷️💵🔗📋📌🔢💳⏱️✅❌🎫🏦🧑🎮🏭💰📈🎯🔑]+/u, '').trim();
    // Format "→ Clé: valeur" ou "Clé: valeur"
    const m = cleaned.match(/^→?\s*\*?\*?([^:]+?)\*?\*?\s*:\s*(.+)/);
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
  console.log(`[EXPORT-DEBUG] Message reçu, embeds: ${msg.embeds.length}`);
  for (const embed of (msg.embeds || [])) {
    const title = (embed.title || embed.author?.name || '').toLowerCase();
    console.log(`[EXPORT-DEBUG] Titre: "${title}" | fields: ${embed.fields?.length||0}`);
    if (!title.includes('export')) { console.log('[EXPORT-DEBUG] Ignoré'); continue; }

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

    // ── Duty / setStatus → Service ──────────────────────
    if (title.includes('setstatus') || title.includes('duty')) {
      const data = {};
      (embed.fields || []).forEach(f => {
        const key = (f.name || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, '');
        const val = (f.value || '').trim();
        // Format "name:Littlestitch_9" → extraire valeur après ":"
        const m = val.match(/^[a-z]+:(.+)$/i);
        data[key] = m ? m[1].trim() : val;
      });

      const nom = data['propername'] || data['name'] || '';
      const statusRaw = data['status'] || '';
      const type = statusRaw === 'true' ? 'debut' : statusRaw === 'false' ? 'fin' : null;
      if (!nom || !type) continue;

      // Timestamp depuis le champ date
      let ts = msg.createdAt;
      const dateRaw = data['date'] || '';
      const dateMatch = dateRaw.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
      if (dateMatch) {
        const [, day, month, year, h, min, sec] = dateMatch;
        ts = new Date(`${year}-${month}-${day}T${h}:${min}:${sec}`);
      }

      const row = { id: msg.id+'_'+type, nom, type, timestamp: ts.toISOString(), semaine: getWeekNum(ts), message_id: msg.id };
      const { error } = await sb.from('discord_services').upsert(row, { onConflict: 'id' });
      if (error) console.error('[SERVICE-IG] ERR:', error.message);
      else console.log(`[SERVICE-IG] ${type==='debut'?'▶':'■'} ${nom} — ${ts.toLocaleTimeString('fr-FR')}`);
      continue;
    }

    // ── Export de Cartons ────────────────────────────────
    if (title.includes('export')) {
      const data = {};
      (embed.fields || []).forEach(f => {
        const key = (f.name || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, '');
        const val = (f.value || '').trim();
        const m = val.match(/^[→•]?\s*[^:]+:\s*(.+)$/i);
        data[key] = m ? m[1].trim() : val;
      });
      // Aussi parser la description
      const descData = parseDesc(embed.description || '');
      Object.assign(data, descData);

      const nomRaw = data['nom'] || data['name'] || data['employe'] || '';
      const nom = extractNom(nomRaw);
      const qStr = data['quantiteexportee'] || data['quantiteexporte'] || data['quantite'] || '0';
      const quantite = parseInt(qStr.replace(/[^\d]/g, '')) || 0;
      const totalStr = data['totalsemaine'] || data['total'] || '0';
      const totalSem = parseInt(totalStr.replace(/[^\d]/g, '')) || 0;
      const idPerso = data['characterid'] || data['source'] || '';
      const ts = msg.createdAt;

      if (!nom) { console.log('[EXPORT-IG] Nom vide, ignoré. data:', JSON.stringify(data)); continue; }

      const row = { id: msg.id, nom, id_perso: idPerso, quantite, total_semaine: totalSem, timestamp: ts.toISOString(), semaine: getWeekNum(ts), message_id: msg.id };
      const { error } = await sb.from('discord_exports').upsert(row, { onConflict: 'id' });
      if (error) console.error('[EXPORT-IG] ERR:', error.message);
      else console.log(`[EXPORT-IG] 📦 ${nom} — ${quantite} cartons (total sem: ${totalSem})`);
      continue;
    }


    const action = title.includes('remove') ? 'remove' : 'add';

    const data = {};
    (embed.fields || []).forEach(f => {
      const key = (f.name || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
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

    if (!row.item) continue;

    const { error } = await sb.from('discord_inventaire').upsert(row, { onConflict: 'id' });
    if (error) console.error('[IG] ERR:', error.message);
  }
}

async function parseFrais(msg) {
  const allSources = [];
  
  if (msg.embeds && msg.embeds.length) {
    allSources.push(...msg.embeds.map(e => ({
      title: e.title || '',
      description: e.description || '',
      fields: e.fields || []
    })));
  }
  if (msg.content && msg.content.length > 10) {
    allSources.push({ title: msg.content, description: msg.content, fields: [] });
  }

  console.log(`[FRAIS-PARSE] msg ${msg.id} — ${allSources.length} source(s), titres: ${allSources.map(s=>JSON.stringify(s.title)).join(', ')}`);
  if (!allSources.length) { console.log('[FRAIS-PARSE] Aucune source, abandon'); return; }

  for (const embed of allSources) {
    const titleRaw = embed.title || '';
    // Nettoyage robuste de tous les emojis Unicode
    const title = titleRaw.toLowerCase()
      .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{2700}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '')
      .replace(/[*_~]/g, '').trim();
    
    const matchesFrais = title.includes('note') || title.includes('frais') || title.includes('ndf')
      || title.includes('nouvelle') || title.includes('accept') || title.includes('refus');
    console.log(`[FRAIS-PARSE] titre nettoyé: "${title}" | match: ${matchesFrais} | fields: ${embed.fields?.length||0}`);
    if (!matchesFrais) continue;

    // Parser description d'abord, puis fields par-dessus (fields = prioritaires, pas écrasés)
    let data = parseDesc(embed.description || '');
    if (embed.fields && embed.fields.length > 0) {
      Object.assign(data, parseFields(embed.fields));
    }

    console.log(`[FRAIS-PARSE] data keys: ${Object.keys(data).join(', ')}`);

    const nomRaw = data['identite'] || data['employe'] || data['nom'] || data['employee'] || '';
    const nom = extractNom(nomRaw);
    const montant = parseMontant(data['montant'] || data['amount'] || '0');
    const raison = data['raison'] || data['motif'] || '';

    // Titre = source la plus fiable pour le statut (NDF déjà traitées par le bot Secrétaire)
    let statut = 'En attente';
    if (title.includes('accept') || title.includes('approuv')) statut = 'Approuve';
    if (title.includes('refus')) statut = 'Refuse';
    if (title.includes('pay')) statut = 'Payee';
    if (statut === 'En attente') {
      const statutRaw = (data['statut'] || data['status'] || '').toLowerCase();
      if (statutRaw.includes('pay')) statut = 'Payee';
      else if (statutRaw.includes('approuv') || statutRaw.includes('accept')) statut = 'Approuve';
      else if (statutRaw.includes('refus')) statut = 'Refuse';
    }

    try {
      const reactions = msg.reactions?.cache;
      if (reactions?.get('\u2705')?.count > 0) statut = 'Approuve';
      if (reactions?.get('\u274C')?.count > 0 || reactions?.get('\uD83D\uDEAB')?.count > 0) statut = 'Refuse';
    } catch(e) {}

    try {
      for (const row of (msg.components || [])) {
        for (const comp of (row.components || [])) {
          const label = (comp.label || '').toLowerCase();
          if (label.includes('accept') && comp.disabled) statut = 'Approuve';
          if (label.includes('refus') && comp.disabled) statut = 'Refuse';
        }
      }
    } catch(e) {}

    const payeePar = extractNom(data['payeepar'] || data['payepar'] || data['acceptepar'] || data['validepar'] || '');

    console.log(`[FRAIS-PARSE] nom="${nom}" montant=${montant} statut=${statut}`);
    if (!nom || !montant) {
      console.log('[FRAIS] Ignoré — nom:', nom, 'montant:', montant, 'data:', JSON.stringify(data).slice(0,300));
      continue;
    }

    const row = { id: msg.id, nom, montant, raison, statut, payee_par: payeePar, timestamp: msg.createdAt.toISOString(), semaine: getWeekNum(msg.createdAt), message_id: msg.id };
    const { error } = await sb.from('discord_frais').upsert(row, { onConflict: 'id' });
    if (error) console.error('[FRAIS] ERR:', error.message);
    else console.log(`[FRAIS] ✅ ${nom} — ${montant}$ (${statut})`);
    break;
  }
}
// ── Historique ────────────────────────────────────────
async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchHistoryREST(channelId, parser, name, maxMessages = 200) {
  try {
    console.log(`[HISTORY-REST] Tentative ${name} (${channelId})...`);
    // Lire les messages les plus récents en premier (pas de &before = commence par les plus récents)
    let lastId = null, total = 0;
    while (true) {
      let url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100`;
      if (lastId) url += `&before=${lastId}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
      });
      if (!res.ok) { console.error(`[HISTORY-REST] HTTP ${res.status}`); break; }
      const msgs = await res.json();
      if (!msgs.length) break;
      for (const msgData of msgs) {
        const fakeMsg = {
          id: msgData.id,
          channelId,
          content: msgData.content || '',
          embeds: msgData.embeds || [],
          components: msgData.components || [],
          reactions: { cache: new Map() },
          createdAt: new Date(msgData.timestamp),
          author: { bot: msgData.author?.bot, tag: msgData.author?.username },
          fetch: async () => fakeMsg
        };
        // Pour FRAIS : ignorer les messages sans embed (optimisation)
        if (name.includes('FRAIS') && !fakeMsg.embeds.length && !fakeMsg.content) continue;
        await parser(fakeMsg);
      }
      total += msgs.length;
      lastId = msgs[msgs.length - 1].id;
      await sleep(300);
      if (msgs.length < 100 || total >= maxMessages) break;
    }
    console.log(`[HISTORY-REST] ${name}: ${total} messages traités`);
  } catch(e) {
    console.error(`[HISTORY-REST] ${name} ERREUR:`, e.message);
  }
}

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
  await fetchHistoryREST(CHANNELS.EXPORT, parseExport, 'EXPORT');
  await fetchHistory(CHANNELS.IG,      parseIG,       'IG');
  await fetchHistoryREST(CHANNELS.FRAIS, parseFrais,  'FRAIS', 500);
  if (CHANNELS.FRAIS2) await fetchHistoryREST(CHANNELS.FRAIS2, parseFrais, 'FRAIS2');
  console.log('✅ Historique chargé — écoute temps réel active');

  // Re-fetch automatique toutes les 15 minutes
  setInterval(async () => {
    console.log('[AUTO] Re-fetch périodique...');
    await fetchHistoryREST(CHANNELS.EXPORT, parseExport, 'EXPORT');
    await fetchHistoryREST(CHANNELS.FRAIS,  parseFrais,  'FRAIS', 500);
    if (CHANNELS.FRAIS2) await fetchHistoryREST(CHANNELS.FRAIS2, parseFrais, 'FRAIS2');
  }, 15 * 60 * 1000);
});

client.on(Events.MessageCreate, async (msg) => {
  const id = msg.channelId;
  const watched = Object.values(CHANNELS);
  if (watched.includes(id)) {
    console.log(`[MSG] Channel ${id} | embeds: ${msg.embeds.length} | bot: ${msg.author?.bot} | author: ${msg.author?.tag||'webhook'}`);
  }
  // Channel frais : traiter immédiatement si embed présent, sinon réessayer
  if (isFraisChannel(id)) {
    if (msg.embeds.length) {
      await parseFrais(msg);
    } else {
      let handled = false;
      for (const delay of [3000, 8000, 15000]) {
        setTimeout(async () => {
          if (handled) return;
          try {
            const fullMsg = await msg.fetch();
            console.log(`[FRAIS-FETCH] ${delay/1000}s | embeds: ${fullMsg.embeds.length}`);
            if (fullMsg.embeds.length) { handled = true; await parseFrais(fullMsg); }
          } catch(e) { console.error('[FRAIS] fetch err:', e.message); }
        }, delay);
      }
    }
    return;
  }
  // Pour le channel export : traiter même sans embed
  if (id === CHANNELS.EXPORT) { await parseExport(msg); return; }
  if (!msg.embeds.length) return;
  if (id === CHANNELS.SERVICE) await parseService(msg);
  if (id === CHANNELS.IG)      await parseIG(msg);
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (!isFraisChannel(reaction.message.channelId)) return;
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
  const channelId = newMsg.channelId;
  if (!isFraisChannel(channelId)) return;
  try {
    // Toujours fetch le message complet pour avoir les embeds
    const msg = await newMsg.fetch();
    console.log(`[FRAIS-UPDATE] Message fetché | embeds: ${msg.embeds.length} | titre: "${msg.embeds[0]?.title||''}"`);
    if (!msg.embeds.length) {
      console.log('[FRAIS-UPDATE] Pas d\'embed après fetch, ignoré');
      return;
    }
    await parseFrais(msg);
  } catch(e) {
    console.error('[FRAIS] Erreur update:', e.message);
  }
});

client.on(Events.Error, e => console.error('Discord error:', e.message));

client.login(DISCORD_TOKEN);
