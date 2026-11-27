
require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    Events
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// =============================
// CONFIG
// =============================

const PREFIX = "-";

const TOKEN = process.env.TOKEN;
const JAIL_ROLE_ID = process.env.JAIL_ROLE_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

const WARN_ROLE_IDS = [
    process.env.WARN_ROLE_1,
    process.env.WARN_ROLE_2,
    process.env.WARN_ROLE_3
];

const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

const MAX_TIMEOUT = 28 * 24 * 60 * 60 * 1000;

if (
    !TOKEN ||
    !JAIL_ROLE_ID ||
    !LOG_CHANNEL_ID ||
    WARN_ROLE_IDS.some(id => !id)
) {
    console.error("تأكد من إعداد TOKEN و JAIL_ROLE_ID و LOG_CHANNEL_ID ورتب التحذير في .env");
    process.exit(1);
}

// =============================
// CLIENT
// =============================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// =============================
// DATABASE
// =============================

const jailFile = path.join(__dirname, "jail-data.json");
const warningFile = path.join(__dirname, "warnings-data.json");

function loadDatabase(file) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, "{}");
    }

    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        console.error("خطأ في قراءة قاعدة البيانات:", file);
        process.exit(1);
    }
}

function saveDatabase(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 4));
}

let jailDatabase = loadDatabase(jailFile);
let warningDatabase = loadDatabase(warningFile);

// =============================
// HELPERS
// =============================

function isStaff(member) {
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return true;
    }

    return member.roles.cache.some(role =>
        STAFF_ROLE_IDS.includes(role.id)
    );
}

function getTarget(message, argument) {
    const mentioned = message.mentions.members.first();

    if (mentioned) return mentioned;

    const id = argument?.replace(/[<@!>]/g, "");

    if (!/^\d{17,20}$/.test(id || "")) return null;

    return message.guild.members.cache.get(id) || null;
}

function getReason(args, startIndex) {
    return args.slice(startIndex).join(" ").trim() || "لم يتم تحديد سبب";
}

async function sendLog(guild, title, color, fields) {
    try {
        const channel = await guild.channels.fetch(LOG_CHANNEL_ID);

        if (!channel || !channel.isTextBased()) return;

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(color)
            .addFields(fields)
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error("خطأ إرسال اللوق:", error);
    }
}

function makeEmbed(title, description, color = 0x3498db) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
}

function parseDuration(value) {
    const match = /^(\d+)(s|m|h|d)$/i.exec(value || "");

    if (!match) return null;

    const amount = Number(match[1]);

    const units = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000
    };

    const duration = amount * units[match[2].toLowerCase()];

    if (!Number.isSafeInteger(duration)) return null;
    if (duration < 1000 || duration > MAX_TIMEOUT) return null;

    return duration;
}

function formatDuration(ms) {
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);

    return [
        days ? `${days} يوم` : "",
        hours ? `${hours} ساعة` : "",
        minutes ? `${minutes} دقيقة` : "",
        seconds ? `${seconds} ثانية` : ""
    ].filter(Boolean).join(" و ") || "أقل من ثانية";
}

async function getBotMember(guild) {
    return guild.members.me || guild.members.fetch(client.user.id);
}

function checkTargetHierarchy(staff, target) {
    if (target.id === staff.id) {
        return "لا يمكنك تنفيذ الأمر على نفسك.";
    }

    if (target.id === target.guild.ownerId) {
        return "عذراً، لا يمكنك تنفيذ الأمر على مالك السيرفر.";
    }

    if (
        staff.id !== target.guild.ownerId &&
        target.roles.highest.position >= staff.roles.highest.position
    ) {
        return "عذراً، لا يمكنك تنفيذ الأمر على هذا الشخص لأن رتبته أعلى منك أو مساوية لرتبتك.";
    }

    return null;
}

// =============================
// WARNING ROLE SYSTEM
// =============================

async function updateWarningRole(guild, target, count) {
    const botMember = await getBotMember(guild);

    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return "البوت لا يملك صلاحية Manage Roles.";
    }

    const roles = [];

    for (const roleId of WARN_ROLE_IDS) {
        const role = await guild.roles.fetch(roleId).catch(() => null);

        if (!role) {
            return `لم أجد رتبة التحذير ذات ID: ${roleId}`;
        }

        if (
            role.managed ||
            role.position >= botMember.roles.highest.position
        ) {
            return `رتبة ${role.name} يجب أن تكون أسفل أعلى رتبة للبوت.`;
        }

        roles.push(role);
    }

    const selectedRole = roles[Math.min(count, 3) - 1];

    try {
        const oldWarningRoles = roles.filter(role =>
            target.roles.cache.has(role.id) &&
            role.id !== selectedRole.id
        );

        if (oldWarningRoles.length) {
            await target.roles.remove(
                oldWarningRoles,
                "Update warning level"
            );
        }

        if (!target.roles.cache.has(selectedRole.id)) {
            await target.roles.add(
                selectedRole,
                `Warning level ${Math.min(count, 3)}`
            );
        }

        return null;
    } catch (error) {
        console.error("WARNING ROLE ERROR:", error);
        return "تم تسجيل التحذير، لكن تعذر تغيير رتبة التحذير. تحقق من صلاحيات البوت وترتيب الرتب.";
    }
}

// =============================
// JAIL SYSTEM
// =============================

async function executeJail(guild, targetId, staffId, reason) {
    const target = await guild.members.fetch(targetId).catch(() => null);
    const staff = await guild.members.fetch(staffId).catch(() => null);

    if (!target || !staff) {
        return "لم أتمكن من العثور على العضو أو الإداري.";
    }

    if (!isStaff(staff)) {
        return "ليس لديك صلاحية استخدام النظام.";
    }

    const hierarchyError = checkTargetHierarchy(staff, target);
    if (hierarchyError) return hierarchyError;

    const key = `${guild.id}_${target.id}`;

    if (jailDatabase[key]) {
        return "هذا العضو مسجون بالفعل.";
    }

    const botMember = await getBotMember(guild);
    const jailRole = await guild.roles.fetch(JAIL_ROLE_ID);

    if (!jailRole) return "رتبة السجين غير موجودة.";

    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return "البوت يحتاج صلاحية Manage Roles.";
    }

    if (jailRole.managed || jailRole.position >= botMember.roles.highest.position) {
        return "رتبة السجين يجب أن تكون أسفل أعلى رتبة للبوت.";
    }

    const rolesToSave = target.roles.cache
        .filter(role => role.id !== guild.id && !role.managed)
        .map(role => role.id);

    const unmanageable = target.roles.cache.some(role =>
        role.id !== guild.id &&
        !role.managed &&
        role.position >= botMember.roles.highest.position
    );

    if (unmanageable) {
        return "لا يستطيع البوت سحب بعض رتب العضو بسبب ترتيب الرتب.";
    }

    try {
        await target.roles.remove(rolesToSave, `Jail by ${staff.user.tag}: ${reason}`);
        await target.roles.add(jailRole, `Jail: ${reason}`);

        jailDatabase[key] = {
            guildId: guild.id,
            userId: target.id,
            staffId: staff.id,
            reason,
            roles: rolesToSave,
            date: Date.now()
        };

        saveDatabase(jailFile, jailDatabase);

        await sendLog(guild, "🔒 سجن عضو", 0xe74c3c, [
            { name: "العضو", value: `${target}`, inline: true },
            { name: "الإداري", value: `${staff}`, inline: true },
            { name: "السبب", value: reason }
        ]);

        return `تم سجن ${target} بنجاح.`;
    } catch (error) {
        console.error(error);
        await target.roles.add(rolesToSave).catch(() => {});
        return "حدث خطأ أثناء السجن. تأكد من صلاحيات البوت وترتيب الرتب.";
    }
}

// =============================
// UNJAIL SYSTEM
// =============================

async function executeUnjail(guild, target, staff) {
    if (!isStaff(staff)) return "ليس لديك صلاحية.";

    const hierarchyError = checkTargetHierarchy(staff, target);
    if (hierarchyError) return hierarchyError;

    const key = `${guild.id}_${target.id}`;
    const data = jailDatabase[key];

    if (!data) return "هذا العضو غير مسجون في النظام.";

    const botMember = await getBotMember(guild);
    const jailRole = await guild.roles.fetch(JAIL_ROLE_ID);

    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return "البوت يحتاج صلاحية Manage Roles.";
    }

    if (!jailRole || jailRole.position >= botMember.roles.highest.position) {
        return "رتبة السجين أعلى من رتبة البوت أو غير موجودة.";
    }

    try {
        const rolesToRestore = [];

        for (const roleId of data.roles) {
            const role = await guild.roles.fetch(roleId).catch(() => null);

            if (
                role &&
                !role.managed &&
                role.position < botMember.roles.highest.position
            ) {
                rolesToRestore.push(role);
            }
        }

        await target.roles.add(rolesToRestore, "Restore roles after jail");
        await target.roles.remove(jailRole, "Unjail");

        delete jailDatabase[key];
        saveDatabase(jailFile, jailDatabase);

        await sendLog(guild, "🔓 فك سجن عضو", 0x2ecc71, [
            { name: "العضو", value: `${target}`, inline: true },
            { name: "الإداري", value: `${staff}`, inline: true },
            { name: "السبب السابق", value: data.reason }
        ]);

        return `تم فك سجن ${target} وإرجاع الرتب المتاحة بنجاح.`;
    } catch (error) {
        console.error(error);
        return "تعذر فك السجن بالكامل. راجع صلاحيات البوت وترتيب الرتب.";
    }
}

// =============================
// WARNING SYSTEM
// =============================

async function giveWarning(message, target, reason) {
    const key = `${message.guild.id}_${target.id}`;

    if (!warningDatabase[key]) {
        warningDatabase[key] = [];
    }

    warningDatabase[key].push({
        reason,
        staffId: message.author.id,
        date: Date.now()
    });

    saveDatabase(warningFile, warningDatabase);

    const count = warningDatabase[key].length;

    const roleError = await updateWarningRole(
        message.guild,
        target,
        count
    );

    await message.reply({
        embeds: [
            makeEmbed(
                "⚠️ تم إعطاء تحذير",
                `**العضو:** ${target}\n` +
                `**الإداري:** ${message.author}\n` +
                `**السبب:** ${reason}\n` +
                `**عدد التحذيرات:** ${count}\n` +
                `**رتبة التحذير:** ${Math.min(count, 3)}`,
                0xf1c40f
            )
        ]
    });

    if (roleError) {
        await message.channel.send(`⚠️ ${roleError}`);
    }

    await sendLog(message.guild, "⚠️ تحذير جديد", 0xf1c40f, [
        { name: "العضو", value: `${target}`, inline: true },
        { name: "الإداري", value: `${message.author}`, inline: true },
        { name: "السبب", value: reason },
        { name: "عدد التحذيرات", value: `${count}` },
        { name: "مستوى التحذير", value: `${Math.min(count, 3)}` }
    ]);
}

// =============================
// TIMEOUT SYSTEM
// =============================

async function giveTimeout(message, target, duration, reason) {
    const hierarchyError = checkTargetHierarchy(message.member, target);
    if (hierarchyError) return message.reply(hierarchyError);

    if (target.id === client.user.id) {
        return message.reply("لا يمكن إعطاء هذا العضو تايم.");
    }

    const botMember = await getBotMember(message.guild);

    if (!botMember.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply("البوت يحتاج صلاحية Moderate Members.");
    }

    if (target.roles.highest.position >= botMember.roles.highest.position) {
        return message.reply("رتبة العضو أعلى من رتبة البوت أو مساوية لها.");
    }

    try {
        await target.timeout(duration, reason);

        await message.reply({
            embeds: [
                makeEmbed(
                    "⏳ تم إعطاء تايم",
                    `**العضو:** ${target}\n` +
                    `**الإداري:** ${message.author}\n` +
                    `**المدة:** ${formatDuration(duration)}\n` +
                    `**السبب:** ${reason}`,
                    0xe67e22
                )
            ]
        });

        await sendLog(message.guild, "⏳ تايم جديد", 0xe67e22, [
            { name: "العضو", value: `${target}`, inline: true },
            { name: "الإداري", value: `${message.author}`, inline: true },
            { name: "المدة", value: formatDuration(duration) },
            { name: "السبب", value: reason }
        ]);
    } catch (error) {
        console.error(error);
        await message.reply("فشل إعطاء التايم. تحقق من صلاحيات البوت.");
    }
}

// =============================
// INTERACTIVE JAIL MENU
// =============================

async function showJailMenu(message, target) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`jail_reason_${message.author.id}_${target.id}`)
        .setPlaceholder("اختر سبب السجن")
        .addOptions([
            {
                label: "السب أو القذف",
                description: "السجن بسبب السب أو القذف",
                value: "السب أو القذف",
                emoji: "🤬"
            },
            {
                label: "نشر وترويج",
                description: "السجن بسبب النشر والترويج",
                value: "نشر وترويج",
                emoji: "📢"
            },
            {
                label: "سبب آخر",
                description: "اكتب سبباً آخر للسجن",
                value: "OTHER",
                emoji: "📝"
            }
        ]);

    const row = new ActionRowBuilder().addComponents(menu);

    await message.reply({
        content: `🔒 اختر سبب سجن العضو ${target}`,
        components: [row]
    });
}

// =============================
// COMMANDS
// =============================

client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();
    const twoWordCommand = `${command} ${(args[0] || "").toLowerCase()}`;
    const staff = message.member;

    // HELP COMMAND FOR EVERYONE

    if (command === "اوامر") {
        const embed = makeEmbed(
            "ABY | نظام الأوامر",
            [
                "`-اوامر`",
                "`-تحذير @العضو السبب`",
                "`-تحذيرات @العضو`",
                "`-سجن @العضو`",
                "`-فك سجن @العضو`",
                "`-تايم @العضو 10m السبب`",
                "`-فك تايم @العضو`",
                "",
                "**المدد:** 30s / 10m / 2h / 1d",
                "**أسباب السجن:** السب أو القذف، نشر وترويج، سبب آخر"
            ].join("\n"),
            0x5865f2
        );

        return message.reply({ embeds: [embed] });
    }

    if (!isStaff(staff)) {
        return message.reply("ليس لديك صلاحية استخدام أوامر الإدارة.");
    }

    try {
        // WARNING

        if (command === "تحذير") {
            if (!staff.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                return message.reply("تحتاج صلاحية Manage Messages.");
            }

            const target = getTarget(message, args[0]);

            if (!target) {
                return message.reply("الاستخدام: -تحذير @العضو السبب");
            }

            const hierarchyError = checkTargetHierarchy(staff, target);
            if (hierarchyError) return message.reply(hierarchyError);

            const reason = getReason(args, 1);
            return giveWarning(message, target, reason);
        }

        // WARNING COUNT

        if (command === "تحذيرات") {
            const target = getTarget(message, args[0]);

            if (!target) {
                return message.reply("الاستخدام: -تحذيرات @العضو");
            }

            const key = `${message.guild.id}_${target.id}`;
            const warnings = warningDatabase[key] || [];

            const description = warnings.length
                ? warnings.map((warning, index) =>
                    `**${index + 1}.** ${warning.reason}\nالإداري: <@${warning.staffId}>`
                ).join("\n\n")
                : "لا توجد تحذيرات لهذا العضو.";

            return message.reply({
                embeds: [
                    makeEmbed(
                        `تحذيرات ${target.user.tag}`,
                        `**المجموع: ${warnings.length}**\n\n${description}`,
                        0xf1c40f
                    )
                ]
            });
        }

        // JAIL

        if (command === "سجن") {
            if (!staff.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
                return message.reply("تحتاج صلاحية Manage Roles.");
            }

            const target = getTarget(message, args[0]);

            if (!target) {
                return message.reply("الاستخدام: -سجن @العضو");
            }

            const hierarchyError = checkTargetHierarchy(staff, target);
            if (hierarchyError) return message.reply(hierarchyError);

            return showJailMenu(message, target);
        }

        // UNJAIL

        if (twoWordCommand === "فك سجن") {
            if (!staff.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
                return message.reply("تحتاج صلاحية Manage Roles.");
            }

            const target = getTarget(message, args[1]);

            if (!target) {
                return message.reply("الاستخدام: -فك سجن @العضو");
            }

            const result = await executeUnjail(message.guild, target, staff);
            return message.reply(result);
        }

        // TIMEOUT

        if (command === "تايم") {
            if (!staff.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                return message.reply("تحتاج صلاحية Moderate Members.");
            }

            const target = getTarget(message, args[0]);

            if (!target) {
                return message.reply("الاستخدام: -تايم @العضو 10m السبب");
            }

            const duration = parseDuration(args[1]);

            if (!duration) {
                return message.reply(
                    "المدة غير صحيحة.\nمثال: 30s أو 10m أو 2h أو 1d.\nالحد الأقصى 28 يوماً."
                );
            }

            const reason = getReason(args, 2);
            return giveTimeout(message, target, duration, reason);
        }

        // REMOVE TIMEOUT

        if (twoWordCommand === "فك تايم") {
            if (!staff.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                return message.reply("تحتاج صلاحية Moderate Members.");
            }

            const target = getTarget(message, args[1]);

            if (!target) {
                return message.reply("الاستخدام: -فك تايم @العضو");
            }

            const hierarchyError = checkTargetHierarchy(staff, target);
            if (hierarchyError) return message.reply(hierarchyError);

            if (!target.communicationDisabledUntilTimestamp) {
                return message.reply("هذا العضو ليس لديه تايم حالياً.");
            }

            await target.timeout(null, `Timeout removed by ${message.author.tag}`);
            await message.reply(`تم فك التايم عن ${target} بنجاح.`);

            return sendLog(message.guild, "✅ فك تايم", 0x2ecc71, [
                { name: "العضو", value: `${target}`, inline: true },
                { name: "الإداري", value: `${message.author}`, inline: true }
            ]);
        }

    } catch (error) {
        console.error("COMMAND ERROR:", error);
        return message.reply("حدث خطأ غير متوقع أثناء تنفيذ الأمر.");
    }
});

// =============================
// MENU INTERACTIONS
// =============================

client.on(Events.InteractionCreate, async interaction => {
    try {
        if (
            interaction.isStringSelectMenu() &&
            interaction.customId.startsWith("jail_reason_")
        ) {
            const parts = interaction.customId.split("_");
            const staffId = parts[2];
            const targetId = parts[3];

            if (interaction.user.id !== staffId) {
                return interaction.reply({
                    content: "هذه القائمة ليست لك.",
                    ephemeral: true
                });
            }

            const guildStaff = await interaction.guild.members.fetch(staffId);
            const target = await interaction.guild.members.fetch(targetId).catch(() => null);

            if (!isStaff(guildStaff)) {
                return interaction.reply({
                    content: "لم تعد تملك صلاحية الإدارة.",
                    ephemeral: true
                });
            }

            if (!target) {
                return interaction.reply({
                    content: "لم أتمكن من العثور على العضو.",
                    ephemeral: true
                });
            }

            const hierarchyError = checkTargetHierarchy(guildStaff, target);
            if (hierarchyError) {
                return interaction.reply({
                    content: hierarchyError,
                    ephemeral: true
                });
            }

            const selected = interaction.values[0];

            if (selected === "OTHER") {
                const modal = new ModalBuilder()
                    .setCustomId(`jail_modal_${staffId}_${targetId}`)
                    .setTitle("سبب السجن");

                const input = new TextInputBuilder()
                    .setCustomId("jail_reason_input")
                    .setLabel("اكتب سبب السجن")
                    .setPlaceholder("اكتب السبب هنا")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(500);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(input)
                );

                return interaction.showModal(modal);
            }

            await interaction.deferReply({ ephemeral: true });

            const result = await executeJail(
                interaction.guild,
                targetId,
                staffId,
                selected
            );

            return interaction.editReply(result);
        }

        // OTHER REASON MODAL

        if (
            interaction.isModalSubmit() &&
            interaction.customId.startsWith("jail_modal_")
        ) {
            const parts = interaction.customId.split("_");
            const staffId = parts[2];
            const targetId = parts[3];

            if (interaction.user.id !== staffId) {
                return interaction.reply({
                    content: "هذه العملية ليست لك.",
                    ephemeral: true
                });
            }

            const guildStaff = await interaction.guild.members.fetch(staffId);
            const target = await interaction.guild.members.fetch(targetId).catch(() => null);

            if (!isStaff(guildStaff)) {
                return interaction.reply({
                    content: "لم تعد تملك صلاحية الإدارة.",
                    ephemeral: true
                });
            }

            if (!target) {
                return interaction.reply({
                    content: "لم أتمكن من العثور على العضو.",
                    ephemeral: true
                });
            }

            const hierarchyError = checkTargetHierarchy(guildStaff, target);
            if (hierarchyError) {
                return interaction.reply({
                    content: hierarchyError,
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            const reason = interaction.fields
                .getTextInputValue("jail_reason_input")
                .trim();

            const result = await executeJail(
                interaction.guild,
                targetId,
                staffId,
                reason
            );

            return interaction.editReply(result);
        }

    } catch (error) {
        console.error("INTERACTION ERROR:", error);

        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({
                content: "حدث خطأ أثناء تنفيذ العملية.",
                ephemeral: true
            }).catch(() => {});
        } else {
            await interaction.reply({
                content: "حدث خطأ أثناء تنفيذ العملية.",
                ephemeral: true
            }).catch(() => {});
        }
    }
});

// =============================
// READY
// =============================

client.once(Events.ClientReady, () => {
    console.log("================================");
    console.log(`ABY BOT ONLINE: ${client.user.tag}`);
    console.log("Administration System Ready");
    console.log("================================");

    client.user.setPresence({
        activities: [
            {
                name: "ABY | نظام الإدارة",
                type: 0
            }
        ],
        status: "online"
    });
});

// =============================
// LOGIN
// =============================

client.login(TOKEN).catch(error => {
    console.error("BOT LOGIN FAILED:", error);
});
