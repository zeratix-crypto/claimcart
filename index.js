require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");

const Database = require("better-sqlite3");
const db = new Database("claimbot.sqlite");

// ======================
// DB
// ======================
db.exec(`
CREATE TABLE IF NOT EXISTS drops (
  drop_id TEXT PRIMARY KEY,
  link TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  message_id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ticket_channel_id TEXT,
  claimed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_messages (
  source_message_id TEXT PRIMARY KEY,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

const insertDrop = db.prepare(
  "INSERT OR REPLACE INTO drops(drop_id, link, created_at) VALUES(?,?,?)"
);
const getDrop = db.prepare("SELECT * FROM drops WHERE drop_id = ?");
const tryClaim = db.prepare(
  "INSERT INTO claims(message_id, drop_id, user_id, claimed_at) VALUES(?,?,?,?)"
);
const getClaim = db.prepare("SELECT * FROM claims WHERE message_id = ?");
const setTicketId = db.prepare(
  "UPDATE claims SET ticket_channel_id = ? WHERE message_id = ?"
);

const getSource = db.prepare(
  "SELECT source_message_id, processed FROM source_messages WHERE source_message_id = ?"
);
const upsertSource = db.prepare(
  "INSERT INTO source_messages(source_message_id, processed, created_at) VALUES(?, ?, ?) " +
    "ON CONFLICT(source_message_id) DO UPDATE SET processed=excluded.processed"
);
const markProcessed = db.prepare(
  "UPDATE source_messages SET processed = 1 WHERE source_message_id = ?"
);

// ======================
// CONFIG (Railway Variables)
// ======================
const CONFIG = {
  dropsChannelId: process.env.DROPS_CHANNEL_ID, // salon #cart
  ticketsCategoryId: process.env.TICKETS_CATEGORY_ID, // catégorie tickets
  staffRoleName: process.env.STAFF_ROLE_NAME || "RUN",
  webhookInChannelId: process.env.WEBHOOK_IN_CHANNEL_ID, // salon #webhook-in
  ticketPrefix: "claim",
};

// ======================
// Client
// ======================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ======================
// Helpers VETRO (robustes, sans toucher VETRO)
// ======================
function normalize(str) {
  return String(str || "").toLowerCase().trim();
}

function extractUrlFromText(text) {
  if (!text) return null;
  const t = String(text);

  const md = t.match(/\((https?:\/\/[^)]+)\)/i);
  if (md?.[1]) return md[1];

  const angle = t.match(/<\s*(https?:\/\/[^>\s]+)\s*>/i);
  if (angle?.[1]) return angle[1];

  const raw = t.match(/https?:\/\/\S+/i);
  return raw?.[0] ? raw[0].replace(/[)>.,!?]+$/g, "") : null;
}

function pickFieldLoose(embed, keywords) {
  if (!embed?.fields) return null;
  const keys = keywords.map(k => normalize(k));

  for (const f of embed.fields) {
    const n = normalize(f.name);
    if (keys.some(k => n.includes(k))) return f.value ?? null;
  }

  for (const f of embed.fields) {
    const v = normalize(f.value);
    if (keys.some(k => v.includes(k))) return f.value ?? null;
  }

  return null;
}

function extractCookiesLinkFromVetro(msg) {
  const e = msg.embeds?.[0];
  if (!e) return null;

  // 1) fields "cookies"
  if (Array.isArray(e.fields)) {
    for (const f of e.fields) {
      const name = normalize(f.name);
      const value = String(f.value || "");

      if (name.includes("cookies") || normalize(value).includes("cookies")) {
        const u = extractUrlFromText(value);
        if (u) return u;
      }
    }
  }

  // 2) embed.url
  if (e.url && normalize(e.url).startsWith("http")) return e.url;

  // 3) description si contient cookies
  if (e.description && normalize(e.description).includes("cookies")) {
    const u = extractUrlFromText(e.description);
    if (u) return u;
  }

  return null;
}

function prettifyTicket(ticketRaw) {
  if (!ticketRaw) return null;

  let t = String(ticketRaw).trim().replace(/\r\n/g, "\n");
  t = t
    .replace(/(\bCat:)/gi, "\n$1")
    .replace(/(\bZone:)/gi, "\n$1")
    .replace(/(\bRow:)/gi, "\n$1")
    .replace(/(\bSeat[s]?:)/gi, "\n$1")
    .replace(/(\bSection:)/gi, "\n$1")
    .trim();

  t = t
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean)
    .join("\n");

  return t;
}

function buildPublicDropFieldsFromVetro(msg) {
  const e = msg.embeds?.[0];
  if (!e) return { title: "🎁 Nouveau drop", thumbnail: null, fields: [] };

  const event = pickFieldLoose(e, ["event"]);
  const price = pickFieldLoose(e, ["price", "prix"]);
  const quantity = pickFieldLoose(e, ["quantity", "qty", "qte", "quantité"]);
  const ticketRaw = pickFieldLoose(e, ["ticket", "tickets"]);
  const ticket = prettifyTicket(ticketRaw);

  const fields = [];
  if (event) fields.push({ name: "Event", value: String(event), inline: false });
  if (price) fields.push({ name: "Price", value: String(price), inline: true });
  if (quantity) fields.push({ name: "Quantity", value: String(quantity), inline: true });
  if (ticket) fields.push({ name: "Ticket", value: String(ticket), inline: false });

  return {
    title: e.title || "🎁 Nouveau drop",
    thumbnail: e.thumbnail?.url || null,
    fields,
  };
}

// prêt dès qu'on a cookies link + au moins 2 infos (souvent Quantity manque)
function isVetroMessageReady(msg) {
  const e = msg.embeds?.[0];
  if (!e) return false;

  const cookies = extractCookiesLinkFromVetro(msg);
  if (!cookies) return false;

  const pub = buildPublicDropFieldsFromVetro(msg);
  return pub.fields.length >= 2;
}

// ======================
// Tickets
// ======================
function resolveStaffRoleId(guild) {
  const role = guild.roles.cache.find(
    (r) => r.name.toLowerCase() === CONFIG.staffRoleName.toLowerCase()
  );
  if (!role) throw new Error(`Rôle staff "${CONFIG.staffRoleName}" introuvable.`);
  return role.id;
}

async function createTicket(guild, user, cookiesLink) {
  const category = guild.channels.cache.get(CONFIG.ticketsCategoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error("Catégorie tickets introuvable / invalide.");
  }

  const staffRoleId = resolveStaffRoleId(guild);

  const safeName = `${CONFIG.ticketPrefix}-${user.username}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  const channelName = `${safeName}-${user.id.slice(-4)}`;

  const ticket = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      {
        id: user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.AttachFiles,
        ],
      },
      {
        id: staffRoleId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels,
        ],
      },
      {
        id: guild.members.me.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels,
        ],
      },
    ],
  });

  const embed = new EmbedBuilder()
    .setTitle("✅ Claim validé")
    .setDescription(
      `**Utilisateur :** <@${user.id}>\n\n🔒 Ticket privé (toi + staff).\n\n✅ **Cookies link :**\n${cookiesLink}`
    );

  await ticket.send({
    content: `<@${user.id}> <@&${staffRoleId}>`,
    embeds: [embed],
  });

  return ticket;
}

// ======================
// Slash Commands
// ======================
async function registerCommands() {
  const data = [
    {
      name: "drop",
      description: "Poster un drop avec bouton Claim (envoi du lien dans un ticket).",
      options: [{ name: "lien", type: 3, description: "Lien à claim", required: true }],
    },
  ];
  await client.application.commands.set(data);
}

client.once("ready", async () => {
  console.log(`✅ Connecté: ${client.user.tag}`);
  await registerCommands();
  console.log("✅ Commande /drop prête");
});

// ======================
// /drop (manuel) - pas de lien public
// ======================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "drop") return;

  if (interaction.channelId !== CONFIG.dropsChannelId) {
    await interaction.reply({ content: "❌ Utilise /drop dans le salon drops.", ephemeral: true });
    return;
  }

  const link = interaction.options.getString("lien", true);
  if (!/^https?:\/\//i.test(link)) {
    await interaction.reply({ content: "❌ Lien invalide (http/https).", ephemeral: true });
    return;
  }

  const dropId = `${Date.now()}_${interaction.user.id}`;
  insertDrop.run(dropId, link, Date.now());

  const embed = new EmbedBuilder()
    .setTitle("🎁 Nouveau drop")
    .setDescription("Clique **Claim**. Le premier qui clique reçoit le lien dans un **ticket** Clique seulement si tu a l'extension, Si tu clique tu dois payer 10 euro par tickets.")
    .addFields({ name: "Statut", value: "🟢 Disponible", inline: true });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`claim:${dropId}`).setLabel("Claim").setStyle(ButtonStyle.Success)
  );

  await interaction.reply({ content: "✅ Drop posté.", ephemeral: true });
  await interaction.channel.send({ embeds: [embed], components: [row] });
});

// ======================
// Bouton Claim
// ======================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("claim:")) return;

  const dropId = interaction.customId.split(":")[1];
  const publicMessage = interaction.message;

  const existing = getClaim.get(publicMessage.id);
  if (existing) {
    await interaction.reply({ content: "❌ Trop tard : déjà claim.", ephemeral: true });
    return;
  }

  try {
    tryClaim.run(publicMessage.id, dropId, interaction.user.id, Date.now());
  } catch {
    await interaction.reply({ content: "❌ Trop tard : déjà claim.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const drop = getDrop.get(dropId);
  if (!drop) {
    await interaction.editReply("⚠️ Drop introuvable.");
    return;
  }

  try {
    const ticket = await createTicket(interaction.guild, interaction.user, drop.link);
    setTicketId.run(ticket.id, publicMessage.id);

    const updatedEmbed = EmbedBuilder.from(publicMessage.embeds[0])
      .spliceFields(0, 1, {
        name: "Statut",
        value: `🔴 Claimé par <@${interaction.user.id}>`,
        inline: true,
      })
      .setFooter({ text: `Claimed by ${interaction.user.tag}` });

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(interaction.customId)
        .setLabel("Claimed")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );

    await publicMessage.edit({ embeds: [updatedEmbed], components: [disabledRow] });
    await interaction.editReply(`✅ Ticket créé : <#${ticket.id}>`);
  } catch (err) {
    console.error(err);
    await interaction.editReply("⚠️ Erreur création ticket (permissions/catégorie).");
  }
});

// ======================
// Auto Drop (sans toucher VETRO)
// ======================
const retryTimers = new Map(); // msgId -> true

async function handleVetroMessage(msg) {
  try {
    if (!CONFIG.webhookInChannelId) return;
    if (msg.channelId !== CONFIG.webhookInChannelId) return;

    // On se base sur un critère solide: embed contient cookies link
    // (webhook ou pas, on s'en fout)
    const sourceId = msg.id;

    const src = getSource.get(sourceId);
    if (src?.processed === 1) return;

    if (!src) upsertSource.run(sourceId, 0, Date.now());

    if (!isVetroMessageReady(msg)) return;

    const cookiesLink = extractCookiesLinkFromVetro(msg);
    if (!cookiesLink) return;

    const pub = buildPublicDropFieldsFromVetro(msg);

    const dropId = `${Date.now()}_auto`;
    insertDrop.run(dropId, cookiesLink, Date.now());

    const dropChannel = await client.channels.fetch(CONFIG.dropsChannelId);
    if (!dropChannel) return;

    const embed = new EmbedBuilder()
      .setTitle(pub.title)
      .setDescription("Clique **Claim**. Le premier qui clique reçoit le lien dans un **ticket**.")
      .addFields({ name: "Statut", value: "🟢 Disponible", inline: true })
      .addFields(pub.fields);

    if (pub.thumbnail) embed.setThumbnail(pub.thumbnail);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim:${dropId}`).setLabel("Claim").setStyle(ButtonStyle.Success)
    );

    await dropChannel.send({ embeds: [embed], components: [row] });
    markProcessed.run(sourceId);
  } catch (err) {
    console.error("handleVetroMessage error:", err);
  }
}

client.on("messageCreate", async (msg) => {
  await handleVetroMessage(msg);

  if (!retryTimers.has(msg.id)) {
    retryTimers.set(msg.id, true);

    const delays = [1500, 4000, 8000];
    for (const d of delays) {
      setTimeout(async () => {
        try {
          const fresh = await msg.channel.messages.fetch(msg.id).catch(() => null);
          if (fresh) await handleVetroMessage(fresh);
        } catch {}
      }, d);
    }
  }
});

client.on("messageUpdate", async (_oldMsg, newMsg) => {
  try {
    if (newMsg.partial) newMsg = await newMsg.fetch();
  } catch {}
  await handleVetroMessage(newMsg);
});

client.login(process.env.DISCORD_TOKEN);
