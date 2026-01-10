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
`);

const insertDrop = db.prepare("INSERT OR REPLACE INTO drops(drop_id, link, created_at) VALUES(?,?,?)");
const getDrop = db.prepare("SELECT * FROM drops WHERE drop_id = ?");
const tryClaim = db.prepare(`INSERT INTO claims(message_id, drop_id, user_id, claimed_at) VALUES(?,?,?,?)`);
const getClaim = db.prepare("SELECT * FROM claims WHERE message_id = ?");
const setTicketId = db.prepare("UPDATE claims SET ticket_channel_id = ? WHERE message_id = ?");

const CONFIG = {
  dropsChannelId: process.env.DROPS_CHANNEL_ID,
  ticketsCategoryId: process.env.TICKETS_CATEGORY_ID,
  staffRoleName: process.env.STAFF_ROLE_NAME || "RUN",
  ticketPrefix: "claim",
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

function resolveStaffRoleId(guild) {
  const role = guild.roles.cache.find(r => r.name.toLowerCase() === CONFIG.staffRoleName.toLowerCase());
  if (!role) throw new Error(`Rôle staff "${CONFIG.staffRoleName}" introuvable.`);
  return role.id;
}

async function createTicket(guild, user, link) {
  const category = guild.channels.cache.get(CONFIG.ticketsCategoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error("Catégorie tickets introuvable / invalide.");
  }

  const staffRoleId = resolveStaffRoleId(guild);

  const safeName = `${CONFIG.ticketPrefix}-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
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
    .setDescription(`**Utilisateur :** <@${user.id}>\n**Lien :** ${link}\n\n🔒 Ticket privé (toi + staff).`);

  await ticket.send({
    content: `<@${user.id}> <@&${staffRoleId}>`,
    embeds: [embed],
  });

  return ticket;
}

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
    .setDescription("Clique **Claim**. Le premier qui clique reçoit le lien dans un **ticket**.")
    .addFields({ name: "Statut", value: "🟢 Disponible", inline: true });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`claim:${dropId}`).setLabel("Claim").setStyle(ButtonStyle.Success)
  );

  await interaction.reply({ content: "✅ Drop posté.", ephemeral: true });
  await interaction.channel.send({ embeds: [embed], components: [row] });
});

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
      .spliceFields(0, 1, { name: "Statut", value: `🔴 Claimé par <@${interaction.user.id}>`, inline: true })
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

client.login(process.env.DISCORD_TOKEN);
