// ============================================================
// STARTUP
// ============================================================

const http = require("http");

// ============================================================
// RENDER HEALTH CHECK SERVER
// ============================================================

const PORT = Number(process.env.PORT) || 10000;

const healthServer = http.createServer(
  (req, res) => {
    // --------------------------------------------------------
    // HEALTH CHECK
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      req.url === "/health"
    ) {
      const discordReady =
        client.isReady();

      res.writeHead(
        discordReady ? 200 : 503,
        {
          "Content-Type":
            "application/json",
          "Cache-Control":
            "no-store",
        }
      );

      res.end(
        JSON.stringify({
          status:
            discordReady
              ? "ok"
              : "starting",
          discord:
            discordReady
              ? "connected"
              : "connecting",
          uptime:
            Math.floor(
              process.uptime()
            ),
          timestamp:
            new Date().toISOString(),
        })
      );

      return;
    }

    // --------------------------------------------------------
    // SIMPLE ROOT ENDPOINT
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      req.url === "/"
    ) {
      res.writeHead(200, {
        "Content-Type":
          "text/plain",
      });

      res.end(
        "KIC India Qualifiers Verification Bot is online."
      );

      return;
    }

    // --------------------------------------------------------
    // NOT FOUND
    // --------------------------------------------------------

    res.writeHead(404, {
      "Content-Type":
        "application/json",
    });

    res.end(
      JSON.stringify({
        error: "Not Found",
      })
    );
  }
);

healthServer.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `🌐 Health server listening on 0.0.0.0:${PORT}`
    );

    console.log(
      `💚 Health endpoint: /health`
    );
  }
);


require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");

const ExcelJS = require("exceljs");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// ============================================================
// CONFIG
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const VERIFICATION_CHANNEL_ID =
  process.env.VERIFICATION_CHANNEL_ID;

const VERIFIED_CHANNEL_ID =
  process.env.VERIFIED_CHANNEL_ID;

const REGISTRATION_FORM_URL =
  process.env.REGISTRATION_FORM_URL ||
  "https://docs.google.com/forms/d/e/1FAIpQLSfpjC5ora3AAVxygNFCerxVDbVH1Dxi5VuD2UyBAM4Lz9Mn8A/viewform";

const DATA_FILE =
  process.env.DATA_FILE ||
  "./data/verifications.json";

const DOWNLOAD_ACCESS_IDS = (
  process.env.DOWNLOAD_ACCESS_IDS || ""
)
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

// Technical limits only.
// These are not displayed as "1-7" to users.
const MIN_TEAM_MEMBERS = 1;
const MAX_TEAM_MEMBERS = 7;

// Verification session timeout.
const SESSION_TIMEOUT_MS =
  30 * 60 * 1000;

// ============================================================
// ENV VALIDATION
// ============================================================

if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN is missing.");
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error("❌ CLIENT_ID is missing.");
  process.exit(1);
}

if (!GUILD_ID) {
  console.error("❌ GUILD_ID is missing.");
  process.exit(1);
}

if (!VERIFICATION_CHANNEL_ID) {
  console.error(
    "❌ VERIFICATION_CHANNEL_ID is missing."
  );
  process.exit(1);
}

if (!VERIFIED_CHANNEL_ID) {
  console.error(
    "❌ VERIFIED_CHANNEL_ID is missing."
  );
  process.exit(1);
}

// ============================================================
// CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ============================================================
// IN-MEMORY DATA
// ============================================================
//
// Keeping verification data in memory means 100+ users
// don't repeatedly read the JSON file while interacting.
//
// The file is still persisted to disk.
// Writes are serialized to prevent simultaneous writes
// from corrupting the JSON file.
// ============================================================

let verifications = [];

let dataReady = false;

let writeQueue = Promise.resolve();

async function ensureDataDirectory() {
  const directory = path.dirname(
    DATA_FILE
  );

  await fsp.mkdir(directory, {
    recursive: true,
  });
}

async function loadVerificationData() {
  await ensureDataDirectory();

  try {
    const raw =
      await fsp.readFile(
        DATA_FILE,
        "utf8"
      );

    const parsed = JSON.parse(raw);

    verifications = Array.isArray(parsed)
      ? parsed
      : [];

    dataReady = true;

    console.log(
      `📦 Loaded ${verifications.length} verification record(s).`
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      verifications = [];

      await fsp.writeFile(
        DATA_FILE,
        "[]",
        "utf8"
      );

      dataReady = true;

      console.log(
        "📦 Created new verification data file."
      );

      return;
    }

    console.error(
      "❌ Failed to load verification data:",
      error
    );

    process.exit(1);
  }
}

function saveVerificationData() {
  const snapshot = JSON.stringify(
    verifications,
    null,
    2
  );

  // Serialize writes.
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      await ensureDataDirectory();

      const tempFile =
        `${DATA_FILE}.tmp`;

      await fsp.writeFile(
        tempFile,
        snapshot,
        "utf8"
      );

      await fsp.rename(
        tempFile,
        DATA_FILE
      );
    });

  return writeQueue;
}

// ============================================================
// SESSION STORAGE
// ============================================================
//
// Every Discord user gets their own session.
//
// 100 users = 100 independent sessions.
// Nobody waits for another user's verification flow.
// ============================================================

const pendingVerifications =
  new Map();

// ============================================================
// BASIC HELPERS
// ============================================================

function isAdmin(member) {
  if (!member) return false;

  return member.permissions?.has(
    PermissionFlagsBits.Administrator
  );
}

function hasDownloadAccess(member) {
  if (!member) return false;

  if (isAdmin(member)) {
    return true;
  }

  return DOWNLOAD_ACCESS_IDS.includes(
    member.id
  );
}

function hasAlreadySubmitted(userId) {
  return verifications.some(
    (verification) =>
      verification.submittedBy?.id ===
      userId
  );
}

function cleanTeamName(value) {
  return String(value || "").trim();
}

function getUsername(user) {
  return (
    user.username ||
    "Unknown"
  );
}

function getDisplayName(user) {
  return (
    user.globalName ||
    user.displayName ||
    user.username ||
    "Unknown User"
  );
}

function formatDate(date) {
  return new Intl.DateTimeFormat(
    "en-US",
    {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    }
  ).format(date);
}

function getSpoilerMention(userId) {
  return `||<@${userId}>||`;
}

function getNextVerificationId() {
  let highest = 0;

  for (const verification of verifications) {
    const match = String(
      verification.verificationId || ""
    ).match(/(\d+)$/);

    if (!match) continue;

    const number = Number(match[1]);

    if (number > highest) {
      highest = number;
    }
  }

  return `VER-${String(
    highest + 1
  ).padStart(4, "0")}`;
}

// ============================================================
// TEAM MEMBER DATA COMPATIBILITY
// ============================================================

function getVerificationTeamMembers(
  verification
) {
  if (
    Array.isArray(
      verification.teamMembers
    )
  ) {
    return verification.teamMembers;
  }

  // Compatibility with older records.
  if (
    Array.isArray(
      verification.pocIds
    )
  ) {
    return verification.pocIds.map(
      (id) => ({
        id,
        username: "",
        displayName: "",
      })
    );
  }

  return [];
}

// ============================================================
// DUPLICATE MEMBER CHECK
// ============================================================

function getAlreadyRegisteredMember(
  memberId
) {
  for (const verification of verifications) {
    const members =
      getVerificationTeamMembers(
        verification
      );

    const exists = members.some(
      (member) =>
        member.id === memberId ||
        member === memberId
    );

    if (exists) {
      return verification;
    }
  }

  return null;
}

// ============================================================
// PUBLIC VERIFICATION PANEL
// ============================================================

function createVerificationPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(
      "KIC India Qualifiers"
    )
    .setDescription(
      [
        "### Team Discord Verification Confirmation",
        "",
        "**Team Name :**",
        "Registered Team Name.",
        "",
        "**Team Members :**",
        "Select the registered team member(s) from the Discord server.",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        "⚠️ **Important Disclaimer**",
        "",
        `> This data needs to be in accordance to the data submited by your team in the [registration form](${REGISTRATION_FORM_URL}).`,
        "> The Captain / POC mentioned in the form should be tagged.",
        "> Changing IGNs and/or POC not being present in the server 48 hours before the R-1 of your participating qualifier can lead to disqualification.",
        "> Only the registered POCs will be added to the matchrooms.",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        "**Team Verification System ◉ Honor of Kings India**",
      ].join("\n")
    );

  const verifyButton =
    new ButtonBuilder()
      .setCustomId(
        "verify_team"
      )
      .setLabel(
        "Verify Team"
      )
      .setEmoji("✅")
      .setStyle(
        ButtonStyle.Primary
      );

  const downloadButton =
    new ButtonBuilder()
      .setCustomId(
        "download_all_updated_list"
      )
      .setLabel(
        "Download All Updated List"
      )
      .setEmoji("📥")
      .setStyle(
        ButtonStyle.Secondary
      );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        verifyButton,
        downloadButton
      ),
    ],
  };
}

// ============================================================
// TEAM NAME MODAL
// ============================================================

function createTeamModal() {
  const modal =
    new ModalBuilder()
      .setCustomId(
        "team_name_modal"
      )
      .setTitle(
        "KIC India Qualifiers"
      );

  const teamNameInput =
    new TextInputBuilder()
      .setCustomId(
        "team_name"
      )
      .setLabel(
        "Team Name"
      )
      .setPlaceholder(
        "Enter your official team name"
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(true)
      .setMaxLength(100);

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      teamNameInput
    )
  );

  return modal;
}

// ============================================================
// TEAM MEMBER SELECT MENU
// ============================================================

function createTeamMemberSelector() {
  const selector =
    new UserSelectMenuBuilder()
      .setCustomId(
        "team_member_selector"
      )
      .setPlaceholder(
        "Select the registered team member(s)"
      )
      .setMinValues(
        MIN_TEAM_MEMBERS
      )
      .setMaxValues(
        MAX_TEAM_MEMBERS
      );

  return new ActionRowBuilder().addComponents(
    selector
  );
}

// ============================================================
// TEAM MEMBER BUTTONS
// ============================================================

function createTeamMemberButtons() {
  const backButton =
    new ButtonBuilder()
      .setCustomId(
        "back_to_team_name"
      )
      .setLabel("Back")
      .setEmoji("◀️")
      .setStyle(
        ButtonStyle.Secondary
      );

  const continueButton =
    new ButtonBuilder()
      .setCustomId(
        "continue_to_disclaimer"
      )
      .setLabel("Continue")
      .setEmoji("➡️")
      .setStyle(
        ButtonStyle.Primary
      );

  return new ActionRowBuilder().addComponents(
    backButton,
    continueButton
  );
}

// ============================================================
// TEAM MEMBER SCREEN
// ============================================================

function createTeamMemberSelectionMessage(
  teamName,
  selectedIds = []
) {
  const selectedText =
    selectedIds.length > 0
      ? selectedIds
          .map(
            (id) => `<@${id}>`
          )
          .join(", ")
      : "None selected yet.";

  const embed =
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(
        "👥 Team Members"
      )
      .setDescription(
        [
          `**Team Name:** ${teamName}`,
          "",
          "Please select the registered team member(s) from the Discord server.",
          "",
          "**Selected Members**",
          selectedText,
        ].join("\n")
      );

  return {
    embeds: [embed],
    components: [
      createTeamMemberSelector(),
      createTeamMemberButtons(),
    ],
  };
}

// ============================================================
// FINAL REVIEW / DISCLAIMER
// ============================================================

function createDisclaimerMessage(
  teamName,
  teamMemberIds
) {
  const membersText =
    teamMemberIds.length > 0
      ? teamMemberIds
          .map(
            (id) => `<@${id}>`
          )
          .join(", ")
      : "None";

  const embed =
    new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle(
        "⚠️ Final Verification Review"
      )
      .setDescription(
        [
          "**Team Name**",
          teamName,
          "",
          "**Team Members**",
          membersText,
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "",
          "⚠️ **Important Disclaimer**",
          "",
          `> This data needs to be in accordance to the data submited by your team in the [registration form](${REGISTRATION_FORM_URL}).`,
          "> The Captain / POC mentioned in the form should be tagged.",
          "> Changing IGNs and/or POC not being present in the server 48 hours before the R-1 of your participating qualifier can lead to disqualification.",
          "> Only the registered POCs will be added to the matchrooms.",
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "",
          "**Team Member Responsibility**",
          "",
          "You are solely responsible for verifying and selecting the correct team member(s) for your team.",
          "By submitting this verification, you confirm that all team member details provided by you are correct and authorized.",
          "If an incorrect team member is tagged/selected or any issue arises due to incorrect team member information, the Organizer will not be held responsible or liable.",
          "",
          "Please review the information carefully before confirming.",
        ].join("\n")
      );

  const backButton =
    new ButtonBuilder()
      .setCustomId(
        "back_to_team_members"
      )
      .setLabel("Back")
      .setEmoji("◀️")
      .setStyle(
        ButtonStyle.Secondary
      );

  const confirmButton =
    new ButtonBuilder()
      .setCustomId(
        "confirm_verification"
      )
      .setLabel("Confirm")
      .setEmoji("✅")
      .setStyle(
        ButtonStyle.Success
      );

  const cancelButton =
    new ButtonBuilder()
      .setCustomId(
        "cancel_verification"
      )
      .setLabel("Cancel")
      .setEmoji("❌")
      .setStyle(
        ButtonStyle.Danger
      );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        backButton,
        confirmButton,
        cancelButton
      ),
    ],
  };
}

// ============================================================
// SUCCESS MESSAGE
// ============================================================

function createSuccessMessage(
  teamName
) {
  const embed =
    new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(
        "✅ Verification Successful"
      )
      .setDescription(
        [
          `Your team **${teamName}** has been successfully verified.`,
          "",
          "The verification record has been submitted successfully.",
          "",
          "If you need to make any correction or encounter an issue, please contact Support.",
          "You will not be able to submit another verification.",
        ].join("\n")
      );

  return {
    embeds: [embed],
    components: [],
  };
}

// ============================================================
// CANCEL MESSAGE
// ============================================================

function createCancelMessage() {
  const embed =
    new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(
        "❌ Verification Cancelled"
      )
      .setDescription(
        "Your verification session has been cancelled. You can start again from the verification panel."
      );

  return {
    embeds: [embed],
    components: [],
  };
}

// ============================================================
// VERIFIED TEAM EMBED
// ============================================================

function createVerifiedTeamEmbed(
  verification
) {
  const embed =
    new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(
        "✅ Team Discord Verification"
      )
      .setDescription(
        [
          "**Team Name**",
          verification.teamName,
          "",
          "**Team Members**",
        ].join("\n")
      );

  const members =
    getVerificationTeamMembers(
      verification
    );

  members.forEach(
    (member, index) => {
      const username =
        member.username ||
        "Unknown";

      const displayName =
        member.displayName ||
        member.username ||
        "Unknown";

      embed.addFields({
        name: `Team Member ${index + 1}`,
        value: [
          `**${getSpoilerMention(
            member.id
          )}**`,
          `Username: \`${username}\``,
          `Display Name: \`${displayName}\``,
          `Discord ID: \`${member.id}\``,
        ].join("\n"),
        inline: false,
      });
    }
  );

  embed.addFields({
    name: "Submitted By",
    value: [
      `**${getSpoilerMention(
        verification.submittedBy.id
      )}**`,
      `Username: \`${verification.submittedBy.username}\``,
      `Display Name: \`${verification.submittedBy.displayName}\``,
      `Discord ID: \`${verification.submittedBy.id}\``,
    ].join("\n"),
    inline: false,
  });

  embed.addFields(
    {
      name: "Verified At",
      value: formatDate(
        new Date(
          verification.verifiedAt
        )
      ),
      inline: true,
    },
    {
      name: "Verification ID",
      value: `\`${verification.verificationId}\``,
      inline: true,
    }
  );

  embed.setFooter({
    text:
      "Team Verification System ◉ Honor of Kings India",
  });

  return embed;
}

// ============================================================
// EXCEL GENERATOR
// ============================================================

async function generateExcelFile() {
  // Snapshot the array so the export works against
  // a stable set while new verifications continue.
  const records = [
    ...verifications,
  ];

  const workbook =
    new ExcelJS.Workbook();

  workbook.creator =
    "Team Verification System";

  workbook.created = new Date();
  workbook.modified = new Date();

  const worksheet =
    workbook.addWorksheet(
      "Verified Teams"
    );

  const columns = [
    {
      header: "Verification ID",
      key: "verificationId",
      width: 20,
    },
    {
      header: "Team Name",
      key: "teamName",
      width: 30,
    },
  ];

  for (
    let i = 1;
    i <= MAX_TEAM_MEMBERS;
    i++
  ) {
    columns.push(
      {
        header: `Team Member ${i} Username`,
        key: `member${i}Username`,
        width: 28,
      },
      {
        header: `Team Member ${i} Display Name`,
        key: `member${i}DisplayName`,
        width: 28,
      },
      {
        header: `Team Member ${i} Discord ID`,
        key: `member${i}DiscordId`,
        width: 24,
      }
    );
  }

  columns.push(
    {
      header:
        "Submitted By Username",
      key:
        "submittedByUsername",
      width: 28,
    },
    {
      header:
        "Submitted By Display Name",
      key:
        "submittedByDisplayName",
      width: 28,
    },
    {
      header:
        "Submitted By Discord ID",
      key:
        "submittedByDiscordId",
      width: 24,
    },
    {
      header: "Verified At",
      key: "verifiedAt",
      width: 30,
    }
  );

  worksheet.columns = columns;

  const headerRow =
    worksheet.getRow(1);

  headerRow.font = {
    bold: true,
  };

  headerRow.alignment = {
    vertical: "middle",
    horizontal: "center",
    wrapText: true,
  };

  worksheet.views = [
    {
      state: "frozen",
      ySplit: 1,
    },
  ];

  for (const verification of records) {
    const row = {
      verificationId:
        verification.verificationId ||
        "",
      teamName:
        verification.teamName ||
        "",
    };

    const members =
      getVerificationTeamMembers(
        verification
      );

    for (
      let i = 1;
      i <= MAX_TEAM_MEMBERS;
      i++
    ) {
      const member =
        members[i - 1];

      row[
        `member${i}Username`
      ] =
        member?.username || "";

      row[
        `member${i}DisplayName`
      ] =
        member?.displayName || "";

      row[
        `member${i}DiscordId`
      ] =
        member?.id || "";
    }

    row.submittedByUsername =
      verification.submittedBy
        ?.username || "";

    row.submittedByDisplayName =
      verification.submittedBy
        ?.displayName || "";

    row.submittedByDiscordId =
      verification.submittedBy?.id ||
      "";

    row.verifiedAt =
      verification.verifiedAt
        ? formatDate(
            new Date(
              verification.verifiedAt
            )
          )
        : "";

    worksheet.addRow(row);
  }

  const outputDirectory =
    path.join(
      process.cwd(),
      "data",
      "exports"
    );

  await fsp.mkdir(
    outputDirectory,
    {
      recursive: true,
    }
  );

  const timestamp =
    new Date()
      .toISOString()
      .replace(
        /[:.]/g,
        "-"
      );

  const outputPath =
    path.join(
      outputDirectory,
      `KIC_Verified_Teams_${timestamp}.xlsx`
    );

  await workbook.xlsx.writeFile(
    outputPath
  );

  return outputPath;
}

// ============================================================
// SLASH COMMAND
// ============================================================

const setupCommand =
  new SlashCommandBuilder()
    .setName(
      "setup-verification"
    )
    .setDescription(
      "Create or update the KIC team verification panel."
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator.toString()
    );

// ============================================================
// REGISTER COMMAND
// ============================================================

async function registerCommands() {
  const rest =
    new REST({
      version: "10",
    }).setToken(TOKEN);

  try {
    console.log(
      "⏳ Registering slash commands..."
    );

    await rest.put(
      Routes.applicationGuildCommands(
        CLIENT_ID,
        GUILD_ID
      ),
      {
        body: [
          setupCommand.toJSON(),
        ],
      }
    );

    console.log(
      "✅ Slash commands registered."
    );
  } catch (error) {
    console.error(
      "❌ Failed to register slash commands:",
      error
    );
  }
}

// ============================================================
// SETUP PANEL
// ============================================================

async function setupVerificationPanel(
  interaction
) {
  if (
    !isAdmin(
      interaction.member
    )
  ) {
    await interaction.reply({
      content:
        "❌ You need Administrator permission to use this command.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  const channel =
    interaction.guild.channels.cache.get(
      VERIFICATION_CHANNEL_ID
    );

  if (!channel) {
    await interaction.reply({
      content:
        "❌ Verification channel could not be found. Check VERIFICATION_CHANNEL_ID.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  try {
    const messages =
      await channel.messages.fetch({
        limit: 100,
      });

    const oldPanels =
      messages.filter(
        (message) =>
          message.author.id ===
            client.user.id &&
          message.components.some(
            (row) =>
              row.components.some(
                (component) =>
                  component.customId ===
                  "verify_team"
              )
          )
      );

    for (
      const message of oldPanels.values()
    ) {
      try {
        await message.delete();
      } catch {
        // Ignore.
      }
    }

    await channel.send(
      createVerificationPanel()
    );

    await interaction.editReply({
      content:
        "✅ Team verification panel has been created successfully.",
    });
  } catch (error) {
    console.error(
      "❌ Failed to setup verification panel:",
      error
    );

    await interaction.editReply({
      content:
        "❌ Failed to create the verification panel.",
    });
  }
}

// ============================================================
// START VERIFICATION
// ============================================================

async function handleVerifyTeam(
  interaction
) {
  const userId =
    interaction.user.id;

  // Normal users can submit only once.
  // Admins are exempt.
  if (
    !isAdmin(
      interaction.member
    ) &&
    hasAlreadySubmitted(
      userId
    )
  ) {
    await interaction.reply({
      content:
        "❌ You have already submitted a team verification. You cannot submit another verification. If you need to make a correction or there is an issue, please contact Support.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  // Independent session for this user.
  pendingVerifications.set(
    userId,
    {
      teamName: "",
      teamMembers: [],
      createdAt: Date.now(),
    }
  );

  await interaction.showModal(
    createTeamModal()
  );
}

// ============================================================
// TEAM NAME SUBMISSION
// ============================================================

async function handleTeamNameModal(
  interaction
) {
  const userId =
    interaction.user.id;

  // One-time check again.
  if (
    !isAdmin(
      interaction.member
    ) &&
    hasAlreadySubmitted(
      userId
    )
  ) {
    pendingVerifications.delete(
      userId
    );

    await interaction.reply({
      content:
        "❌ You have already submitted a team verification. You cannot submit another verification. If you need to make a correction or there is an issue, please contact Support.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  const teamName =
    cleanTeamName(
      interaction.fields.getTextInputValue(
        "team_name"
      )
    );

  if (!teamName) {
    await interaction.reply({
      content:
        "❌ Please enter a valid team name.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  const oldSession =
    pendingVerifications.get(
      userId
    );

  pendingVerifications.set(
    userId,
    {
      teamName,
      teamMembers:
        oldSession?.teamMembers ||
        [],
      createdAt:
        oldSession?.createdAt ||
        Date.now(),
    }
  );

  await interaction.reply({
    ...createTeamMemberSelectionMessage(
      teamName,
      oldSession?.teamMembers ||
        []
    ),
    flags:
      MessageFlags.Ephemeral,
  });
}

// ============================================================
// TEAM MEMBER SELECTION
// ============================================================

async function handleTeamMemberSelection(
  interaction
) {
  const userId =
    interaction.user.id;

  const session =
    pendingVerifications.get(
      userId
    );

  if (!session) {
    await interaction.reply({
      content:
        "❌ Your verification session has expired. Please start again.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  const selectedIds =
    Array.isArray(
      interaction.values
    )
      ? [
          ...new Set(
            interaction.values
          ),
        ]
      : [];

  if (
    selectedIds.length <
      MIN_TEAM_MEMBERS ||
    selectedIds.length >
      MAX_TEAM_MEMBERS
  ) {
    await interaction.reply({
      content:
        "❌ Please select valid team member(s).",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  // ----------------------------------------------------------
  // DUPLICATE CHECK
  // ----------------------------------------------------------

  const duplicateMembers = [];

  for (
    const memberId of selectedIds
  ) {
    const existing =
      getAlreadyRegisteredMember(
        memberId
      );

    if (
      existing &&
      existing.submittedBy?.id !==
        userId
    ) {
      duplicateMembers.push(
        memberId
      );
    }
  }

  if (
    duplicateMembers.length > 0
  ) {
    const mentions =
      duplicateMembers
        .map(
          (id) => `<@${id}>`
        )
        .join(", ");

    await interaction.reply({
      content: [
        `❌ The following selected team member(s) are already registered on another verified team: ${mentions}`,
        "",
        "If this is incorrect, please contact Support.",
      ].join("\n"),
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  // Store this user's selection only.
  session.teamMembers =
    selectedIds;

  pendingVerifications.set(
    userId,
    session
  );

  await interaction.update(
    createTeamMemberSelectionMessage(
      session.teamName,
      session.teamMembers
    )
  );
}

// ============================================================
// CONTINUE
// ============================================================

async function handleContinueToDisclaimer(
  interaction
) {
  const userId =
    interaction.user.id;

  const session =
    pendingVerifications.get(
      userId
    );

  if (!session) {
    await interaction.reply({
      content:
        "❌ Your verification session has expired. Please start again.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  if (
    !session.teamName ||
    !Array.isArray(
      session.teamMembers
    ) ||
    session.teamMembers.length === 0
  ) {
    await interaction.reply({
      content:
        "❌ Please select the required team member(s) before continuing.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.update(
    createDisclaimerMessage(
      session.teamName,
      session.teamMembers
    )
  );
}

// ============================================================
// BACK TO TEAM NAME
// ============================================================

async function handleBackToTeamName(
  interaction
) {
  const userId =
    interaction.user.id;

  const session =
    pendingVerifications.get(
      userId
    );

  if (!session) {
    await interaction.reply({
      content:
        "❌ Your verification session has expired. Please start again.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.showModal(
    createTeamModal()
  );
}

// ============================================================
// BACK TO TEAM MEMBERS
// ============================================================

async function handleBackToTeamMembers(
  interaction
) {
  const userId =
    interaction.user.id;

  const session =
    pendingVerifications.get(
      userId
    );

  if (!session) {
    await interaction.reply({
      content:
        "❌ Your verification session has expired. Please start again.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.update(
    createTeamMemberSelectionMessage(
      session.teamName,
      session.teamMembers
    )
  );
}

// ============================================================
// FINAL CONFIRMATION
// ============================================================

async function handleConfirmVerification(
  interaction
) {
  const userId =
    interaction.user.id;

  const session =
    pendingVerifications.get(
      userId
    );

  if (!session) {
    await interaction.reply({
      content:
        "❌ Your verification session has expired. Please start again.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  // ----------------------------------------------------------
  // FINAL ONE-TIME CHECK
  // ----------------------------------------------------------

  if (
    !isAdmin(
      interaction.member
    ) &&
    hasAlreadySubmitted(
      userId
    )
  ) {
    pendingVerifications.delete(
      userId
    );

    await interaction.reply({
      content:
        "❌ You have already submitted a team verification. You cannot submit another verification. If you need to make a correction or there is an issue, please contact Support.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  if (!session.teamName) {
    await interaction.reply({
      content:
        "❌ Team name is missing. Please start again.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  if (
    !Array.isArray(
      session.teamMembers
    ) ||
    session.teamMembers.length <
      MIN_TEAM_MEMBERS ||
    session.teamMembers.length >
      MAX_TEAM_MEMBERS
  ) {
    await interaction.reply({
      content:
        "❌ Please select valid team member(s).",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  // Immediately acknowledge the Discord interaction.
  // This prevents the button from appearing stuck.
  await interaction.deferUpdate();

  try {
    const guild =
      interaction.guild;

    if (!guild) {
      throw new Error(
        "Guild unavailable."
      );
    }

    // --------------------------------------------------------
    // FETCH SELECTED MEMBERS
    // --------------------------------------------------------

    const resolvedMembers =
      await Promise.all(
        session.teamMembers.map(
          async (memberId) => {
            let member =
              guild.members.cache.get(
                memberId
              );

            if (!member) {
              try {
                member =
                  await guild.members.fetch(
                    memberId
                  );
              } catch {
                member = null;
              }
            }

            return member;
          }
        )
      );

    const missingIndex =
      resolvedMembers.findIndex(
        (member) => !member
      );

    if (
      missingIndex !== -1
    ) {
      const missingId =
        session.teamMembers[
          missingIndex
        ];

      await interaction.editReply({
        content: `❌ Could not find <@${missingId}> in this server. Please go back and select a current server member.`,
        embeds: [],
        components: [],
      });

      return;
    }

    // --------------------------------------------------------
    // FINAL DUPLICATE CHECK
    // --------------------------------------------------------

    const duplicateMembers = [];

    for (
      const member of resolvedMembers
    ) {
      const existing =
        getAlreadyRegisteredMember(
          member.id
        );

      if (
        existing &&
        existing.submittedBy?.id !==
          userId
      ) {
        duplicateMembers.push(
          member
        );
      }
    }

    if (
      duplicateMembers.length > 0
    ) {
      const mentions =
        duplicateMembers
          .map(
            (member) =>
              `<@${member.id}>`
          )
          .join(", ");

      await interaction.editReply({
        content: [
          `❌ The following selected team member(s) are already registered on another verified team: ${mentions}`,
          "",
          "If this is incorrect, please contact Support.",
        ].join("\n"),
        embeds: [],
        components: [],
      });

      return;
    }

    // --------------------------------------------------------
    // CREATE VERIFICATION RECORD
    // --------------------------------------------------------

    const verification = {
      verificationId:
        getNextVerificationId(),

      teamName:
        session.teamName,

      teamMembers:
        resolvedMembers.map(
          (member) => ({
            id: member.user.id,
            username:
              getUsername(
                member.user
              ),
            displayName:
              getDisplayName(
                member.user
              ),
          })
        ),

      // Compatibility with old data.
      pocIds:
        resolvedMembers.map(
          (member) =>
            member.user.id
        ),

      submittedBy: {
        id:
          interaction.user.id,
        username:
          getUsername(
            interaction.user
          ),
        displayName:
          getDisplayName(
            interaction.user
          ),
      },

      verifiedAt:
        new Date().toISOString(),
    };

    // --------------------------------------------------------
    // STORE IN MEMORY FIRST
    // --------------------------------------------------------
    //
    // This makes the new verification immediately available
    // to other users while the disk write is queued.
    // --------------------------------------------------------

    verifications.push(
      verification
    );

    // Persist asynchronously.
    // Other verification sessions do not wait for this write.
    const persistencePromise =
      saveVerificationData();

    // --------------------------------------------------------
    // PUBLIC VERIFIED CHANNEL
    // --------------------------------------------------------

    const verifiedChannel =
      guild.channels.cache.get(
        VERIFIED_CHANNEL_ID
      );

    if (verifiedChannel) {
      const memberMentions =
        resolvedMembers.map(
          (member) =>
            member.user.id
        );

      // De-duplicate the mention set: if the submitter is
      // also one of the selected team members, their ID
      // would otherwise appear twice and Discord rejects
      // the request with
      // allowed_mentions.users[...][SET_TYPE_ALREADY_CONTAINS_VALUE].
      const allowedMentionUsers = [
        ...new Set([
          ...memberMentions,
          interaction.user.id,
        ]),
      ];

      await verifiedChannel.send(
        {
          content:
            "⚠️ If any information appears incorrect, please contact the tournament organizers via <#1545348043467915334>.",

          embeds: [
            createVerifiedTeamEmbed(
              verification
            ),
          ],

          allowedMentions: {
            users: allowedMentionUsers,
          },
        }
      );
    } else {
      console.error(
        "❌ VERIFIED_CHANNEL_ID channel not found."
      );
    }

    // --------------------------------------------------------
    // OPTIONAL TEAM ROLE
    // --------------------------------------------------------

    const createTeamRoles =
      String(
        process.env.CREATE_TEAM_ROLES ||
          "false"
      ).toLowerCase() ===
      "true";

    if (createTeamRoles) {
      try {
        let teamRole =
          guild.roles.cache.find(
            (role) =>
              role.name ===
              session.teamName
          );

        if (!teamRole) {
          teamRole =
            await guild.roles.create(
              {
                name:
                  session.teamName,
                reason:
                  "KIC India Qualifiers team verification",
              }
            );
        }

        // Role assignments are independent.
        await Promise.all(
          resolvedMembers.map(
            async (member) => {
              try {
                if (
                  !member.roles.cache.has(
                    teamRole.id
                  )
                ) {
                  await member.roles.add(
                    teamRole,
                    "KIC India Qualifiers team verification"
                  );
                }
              } catch (error) {
                console.error(
                  `❌ Failed to assign team role to ${member.user.tag}:`,
                  error
                );
              }
            }
          )
        );
      } catch (error) {
        console.error(
          "❌ Team role creation failed:",
          error
        );
      }
    }

    // Wait for persistence only after
    // the actual verification has completed.
    //
    // This does NOT block other users' sessions.
    try {
      await persistencePromise;
    } catch (error) {
      console.error(
        "❌ Failed to persist verification:",
        error
      );
    }

    // --------------------------------------------------------
    // REMOVE USER SESSION
    // --------------------------------------------------------

    pendingVerifications.delete(
      userId
    );

    // --------------------------------------------------------
    // PRIVATE SUCCESS MESSAGE
    // --------------------------------------------------------

    await interaction.editReply(
      createSuccessMessage(
        session.teamName
      )
    );
  } catch (error) {
    console.error(
      "❌ Verification submission failed:",
      error
    );

    // If data was already inserted in memory but
    // a later Discord operation failed, keep the record.
    // This avoids silently losing a successful submission.

    pendingVerifications.delete(
      userId
    );

    await interaction.editReply({
      content:
        "❌ Something went wrong while completing the verification. Please contact Support.",
      embeds: [],
      components: [],
    });
  }
}

// ============================================================
// CANCEL
// ============================================================

async function handleCancelVerification(
  interaction
) {
  pendingVerifications.delete(
    interaction.user.id
  );

  await interaction.update(
    createCancelMessage()
  );
}

// ============================================================
// DOWNLOAD ALL UPDATED LIST
// ============================================================

async function handleDownloadAllUpdatedList(
  interaction
) {
  if (
    !hasDownloadAccess(
      interaction.member
    )
  ) {
    await interaction.reply({
      content:
        "❌ **Access Denied**\nYou do not have permission to download the verification list.",
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  let outputPath = null;

  try {
    outputPath =
      await generateExcelFile();

    await interaction.editReply({
      content:
        "📥 **Verification list generated successfully.**",
      files: [
        outputPath,
      ],
    });

    // Delete local temporary export later.
    setTimeout(
      async () => {
        try {
          await fsp.unlink(
            outputPath
          );
        } catch {
          // Ignore.
        }
      },
      60_000
    );
  } catch (error) {
    console.error(
      "❌ Excel generation failed:",
      error
    );

    await interaction.editReply({
      content:
        "❌ Failed to generate the verification list. Please try again later.",
    });
  }
}

// ============================================================
// INTERACTION HANDLER
// ============================================================

client.on(
  "interactionCreate",
  async (interaction) => {
    try {
      // ======================================================
      // SLASH COMMAND
      // ======================================================

      if (
        interaction.isChatInputCommand()
      ) {
        if (
          interaction.commandName ===
          "setup-verification"
        ) {
          await setupVerificationPanel(
            interaction
          );
        }

        return;
      }

      // ======================================================
      // BUTTONS
      // ======================================================

      if (
        interaction.isButton()
      ) {
        switch (
          interaction.customId
        ) {
          case "verify_team":
            await handleVerifyTeam(
              interaction
            );
            break;

          case "download_all_updated_list":
            await handleDownloadAllUpdatedList(
              interaction
            );
            break;

          case "back_to_team_name":
            await handleBackToTeamName(
              interaction
            );
            break;

          case "continue_to_disclaimer":
            await handleContinueToDisclaimer(
              interaction
            );
            break;

          case "back_to_team_members":
            await handleBackToTeamMembers(
              interaction
            );
            break;

          case "confirm_verification":
            await handleConfirmVerification(
              interaction
            );
            break;

          case "cancel_verification":
            await handleCancelVerification(
              interaction
            );
            break;

          default:
            break;
        }

        return;
      }

      // ======================================================
      // MODALS
      // ======================================================

      if (
        interaction.isModalSubmit()
      ) {
        if (
          interaction.customId ===
          "team_name_modal"
        ) {
          await handleTeamNameModal(
            interaction
          );
        }

        return;
      }

      // ======================================================
      // USER SELECT MENU
      // ======================================================

      if (
        interaction.isUserSelectMenu() &&
        interaction.customId ===
          "team_member_selector"
      ) {
        await handleTeamMemberSelection(
          interaction
        );

        return;
      }
    } catch (error) {
      console.error(
        "❌ Interaction error:",
        error
      );

      try {
        if (
          interaction.replied
        ) {
          await interaction.followUp(
            {
              content:
                "❌ Something went wrong. Please try again or contact Support.",
              flags:
                MessageFlags.Ephemeral,
            }
          );
        } else if (
          interaction.deferred
        ) {
          await interaction.editReply(
            {
              content:
                "❌ Something went wrong. Please try again or contact Support.",
              embeds: [],
              components: [],
            }
          );
        } else {
          await interaction.reply(
            {
              content:
                "❌ Something went wrong. Please try again or contact Support.",
              flags:
                MessageFlags.Ephemeral,
            }
          );
        }
      } catch {
        // Ignore secondary errors.
      }
    }
  }
);

// ============================================================
// SESSION CLEANUP
// ============================================================
//
// Cleanup is lightweight and only touches the Map.
// It does not read/write the JSON file.
// ============================================================

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        userId,
        session,
      ] of pendingVerifications.entries()
    ) {
      if (
        now -
          session.createdAt >
        SESSION_TIMEOUT_MS
      ) {
        pendingVerifications.delete(
          userId
        );
      }
    }
  },
  5 * 60 * 1000
);

// ============================================================
// READY
// ============================================================

client.once(
  "ready",
  async () => {
    console.log(
      `✅ Logged in as ${client.user.tag}`
    );

    console.log(
      `🏆 Verification Channel: ${VERIFICATION_CHANNEL_ID}`
    );

    console.log(
      `👀 Verified Channel: ${VERIFIED_CHANNEL_ID}`
    );

    console.log(
      `📋 Registration Form: ${REGISTRATION_FORM_URL}`
    );

    console.log(
      `📥 Download Access IDs: ${
        DOWNLOAD_ACCESS_IDS.length
          ? DOWNLOAD_ACCESS_IDS.join(
              ", "
            )
          : "None configured"
      }`
    );

    console.log(
      "⚡ Concurrent verification mode: ENABLED"
    );

    await registerCommands();
  }
);

// ============================================================
// STARTUP
// ============================================================

(async () => {
  await loadVerificationData();

  if (!dataReady) {
    console.error(
      "❌ Verification data was not initialized."
    );

    process.exit(1);
  }

  await client.login(TOKEN);
})();