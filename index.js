const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    ChannelType,
    CheckboxBuilder,
    Client,
    EmbedBuilder,
    FileUploadBuilder,
    GatewayIntentBits,
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    Partials,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const Groq = require('groq-sdk');
const { DEFAULT_STORE_SETTINGS, buildWelcomePayload, getGuildSettings, startDashboard } = require('./dashboard');
require('dotenv').config();

// Inicializa a IA Groq
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const TICKET_SETTINGS_PATH = path.join(__dirname, 'ticket-settings.json');
const GIVEAWAY_DATA_PATH = path.join(__dirname, 'giveaways.json');
const TICKET_TRANSCRIPTS_PATH = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), '.kkjj-store'),
    'ticket-transcripts',
);
const AI_MEMORY_PATH = path.join(__dirname, 'ai-memory.json');
const MAX_AI_HISTORY_MESSAGES = 20;
const ticketCallCooldowns = new Map();
const ticketClaimLocks = new Set();
let aiMemoryWriteQueue = Promise.resolve();
let giveawayWriteQueue = Promise.resolve();
let giveaways = {};
const giveawayFinishLocks = new Set();
const giveawayMessageQueues = new Map();

const PREFIX_COMMANDS = [
    { names: '!ping', description: 'Verifica se o bot está respondendo.' },
    { names: '!aviso', description: 'Abre o formulário para criar um aviso.' },
    { names: '!logtickets', description: 'Configura este canal para logs de abertura e encerramento de tickets.' },
    { names: '!logticketopen', description: 'Configura este canal para logs de abertura de tickets.' },
    { names: '!logticketclose', description: 'Configura este canal para logs de encerramento e históricos de tickets.' },
    { names: '!logentrada', description: 'Configura este canal para logs de entrada de membros.' },
    { names: '!logsaida', description: 'Configura este canal para logs de saída de membros.' },
    { names: '!logmembros', description: 'Configura este canal para logs de entrada e saída de membros.' },
    { names: '!ticket', description: 'Publica o painel de atendimento neste canal.' },
    { names: '!pix', description: 'Abre o formulário para enviar a chave Pix em um ticket aberto.' },
    { names: '!sorteio @responsavel', description: 'Abre o formulário para criar um sorteio neste canal.' },
    { names: '!encerrarsorteio', description: 'Encerra imediatamente o sorteio cuja publicação você respondeu.' },
    { names: '!loja / !store', description: 'Publica as informações da loja.' },
    { names: '!termos', description: 'Exibe os termos e condições de compra.' },
    { names: '!comands [#canal]', description: 'Publica esta lista de comandos no canal indicado ou neste canal.' },
];

function getAiConversationKey(message) {
    return `${message.guildId || 'dm'}:${message.channelId}`;
}

async function getRecentChannelContext(message, limit = 12) {
    if (!message.channel || typeof message.channel.messages?.fetch !== 'function') {
        return [];
    }

    try {
        const recentMessages = await message.channel.messages.fetch({ limit });
        return [...recentMessages.values()]
            .filter(msg => msg.id !== message.id && !msg.author.bot)
            .reverse()
            .map(msg => ({
                role: 'user',
                content: `${msg.author.username}: ${msg.content || '[mensagem sem texto]'}`,
            }));
    } catch (error) {
        console.error('Erro ao buscar contexto recente do canal da IA:', error);
        return [];
    }
}

async function readAiMemory() {
    try {
        const memory = JSON.parse(await fs.readFile(AI_MEMORY_PATH, 'utf8'));
        if (!memory || Array.isArray(memory) || typeof memory !== 'object') {
            throw new Error('O arquivo de memória da IA tem um formato inválido.');
        }
        return memory;
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

async function getAiConversation(key) {
    await aiMemoryWriteQueue;
    const memory = await readAiMemory();
    const conversation = memory[key];
    if (!Array.isArray(conversation)) return [];
    return conversation.filter(entry =>
        entry &&
        (entry.role === 'user' || entry.role === 'assistant') &&
        typeof entry.content === 'string'
    ).slice(-MAX_AI_HISTORY_MESSAGES);
}

async function updateAiMemory(key, conversation) {
    const write = aiMemoryWriteQueue.catch(() => {}).then(async () => {
        const memory = await readAiMemory();
        if (conversation) {
            memory[key] = conversation.slice(-MAX_AI_HISTORY_MESSAGES);
        } else {
            delete memory[key];
        }
        const temporaryPath = `${AI_MEMORY_PATH}.tmp`;
        await fs.writeFile(temporaryPath, JSON.stringify(memory, null, 2), 'utf8');
        await fs.rename(temporaryPath, AI_MEMORY_PATH);
    });
    aiMemoryWriteQueue = write;
    await write;
}

async function readTicketSettings() {
    try {
        return JSON.parse(await fs.readFile(TICKET_SETTINGS_PATH, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

function getTicketLogChannelId(settings, guildId, type) {
    const guildSettings = settings[guildId];
    if (typeof guildSettings === 'string') return guildSettings;
    if (!guildSettings || typeof guildSettings !== 'object') return null;
    return guildSettings[type] || null;
}

async function findMemberLogChannel(guild, type) {
    const settings = await readTicketSettings();
    const channelId = getTicketLogChannelId(settings, guild.id, type);
    if (!channelId) return null;
    const channel = await guild.channels.fetch(channelId);
    return channel && channel.isTextBased() && typeof channel.send === 'function'
        ? channel
        : null;
}

async function findTicketLogChannel(guild, type) {
    const settings = await readTicketSettings();
    const channelId = getTicketLogChannelId(settings, guild.id, type);
    if (!channelId) return null;

    const channel = await guild.channels.fetch(channelId);
    return channel && channel.isTextBased() && typeof channel.send === 'function'
        ? channel
        : null;
}

async function findTicketStaff(guild) {
    const config = await getGuildSettings(guild.id);
    const roleIds = Array.isArray(config.ticketStaffRoleIds) ? config.ticketStaffRoleIds : [];
    if (roleIds.length === 0) {
        throw new Error('Nenhum cargo de atendimento foi configurado. Selecione os cargos na aba “Pix e pagamentos” do painel.');
    }
    await guild.roles.fetch();
    const staffRoles = roleIds.map(roleId => guild.roles.cache.get(roleId));
    if (staffRoles.some(role => !role)) {
        throw new Error('Um cargo de atendimento configurado não existe mais. Atualize a seleção de cargos no painel.');
    }
    return staffRoles;
}

async function logTicketOpened(channel, owner, staff, category) {
    const logChannel = await findTicketLogChannel(channel.guild, 'open');
    if (!logChannel) {
        throw new Error('O canal de logs de abertura configurado não existe ou não aceita mensagens.');
    }

    const embed = new EmbedBuilder()
        .setColor('#8B5CF6')
        .setTitle('🎫 Novo ticket aberto')
        .setDescription(`Canal: <#${channel.id}>\nCliente: <@${owner.id}>\nCategoria: **${category}**\nCargos de atendimento: ${staff.map(role => `<@&${role.id}>`).join(' ')}`)
        .setTimestamp();
    await logChannel.send({
        embeds: [embed],
        allowedMentions: { roles: staff.map(role => role.id) },
    });
}

async function isTicketStaff(member) {
    if (!member?.guild || !member.roles?.cache) return false;
    const config = await getGuildSettings(member.guild.id);
    const roleIds = Array.isArray(config.ticketStaffRoleIds) ? config.ticketStaffRoleIds : [];
    return roleIds.some(roleId => member.roles.cache.has(roleId));
}

async function isInteractionTicketStaff(interaction) {
    const config = await getGuildSettings(interaction.guild.id);
    const roleIds = Array.isArray(config.ticketStaffRoleIds) ? config.ticketStaffRoleIds : [];
    const memberRoles = interaction.member?.roles;
    return Array.isArray(memberRoles)
        ? roleIds.some(roleId => memberRoles.includes(roleId))
        : roleIds.some(roleId => memberRoles?.cache?.has(roleId));
}

async function updateTicketAssignee(channel, ticketMessage, assignee) {
    const currentEmbed = ticketMessage.embeds[0];
    if (!currentEmbed) throw new Error('Não encontrei o formulário inicial deste ticket para atualizar o atendente.');

    const oldTopic = channel.topic || '';
    const newTopic = /(?:^|\s\|\s)kkjj-ticket-assignee:\d+/.test(oldTopic)
        ? oldTopic.replace(/kkjj-ticket-assignee:\d+/, `kkjj-ticket-assignee:${assignee.id}`)
        : `${oldTopic} | kkjj-ticket-assignee:${assignee.id}`;
    const updatedEmbed = EmbedBuilder.from(currentEmbed);
    const fields = currentEmbed.fields
        .filter(field => field.name !== 'Atendente')
        .map(field => ({ name: field.name, value: field.value, inline: field.inline }));
    fields.push({ name: 'Atendente', value: `<@${assignee.id}>` });

    await channel.setTopic(newTopic, `Ticket assumido por ${assignee.user.tag}`);
    try {
        await ticketMessage.edit({
            embeds: [updatedEmbed.setFields(fields)],
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        try {
            await channel.setTopic(oldTopic, 'Revertendo atendente após falha ao atualizar o ticket.');
        } catch (restoreError) {
            console.error('Não consegui reverter o atendente no tópico após falha ao atualizar a mensagem:', restoreError);
        }
        throw error;
    }
}

function extractGroqText(message) {
    const content = message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
        const text = content
            .map(part => {
                if (typeof part === 'string' && part.trim()) return part.trim();
                if (part && typeof part === 'object') {
                    if (typeof part.text === 'string' && part.text.trim()) return part.text.trim();
                    if (typeof part.value === 'string' && part.value.trim()) return part.value.trim();
                }
                return '';
            })
            .join(' ')
            .trim();
        if (text) return text;
    }
    if (content && typeof content === 'object') {
        if (typeof content.text === 'string' && content.text.trim()) return content.text.trim();
        if (typeof content.value === 'string' && content.value.trim()) return content.value.trim();
    }
    if (typeof message?.reasoning === 'string' && message.reasoning.trim()) return message.reasoning.trim();
    if (typeof message?.refusal === 'string' && message.refusal.trim()) return message.refusal.trim();
    return '';
}

function buildChatFallback(prompt) {
    const trimmed = prompt.replace(/\s+/g, ' ').trim();
    if (!trimmed) return 'Claro! Estou aqui para ajudar.';
    return `Entendi sua mensagem sobre: "${trimmed.slice(0, 180)}${trimmed.length > 180 ? '...' : ''}". Posso ajudar, mas preciso de mais contexto para responder com precisão.`;
}

async function loadGiveaways() {
    try {
        const storedGiveaways = JSON.parse(await fs.readFile(GIVEAWAY_DATA_PATH, 'utf8'));
        if (!storedGiveaways || Array.isArray(storedGiveaways) || typeof storedGiveaways !== 'object') {
            throw new Error('O arquivo de sorteios tem um formato inválido.');
        }
        let migratedLegacyEntries = false;
        for (const [messageId, giveaway] of Object.entries(storedGiveaways)) {
            if (!/^\d{17,20}$/.test(messageId) ||
                !giveaway || typeof giveaway !== 'object' ||
                !/^\d{17,20}$/.test(giveaway.guildId || '') ||
                !/^\d{17,20}$/.test(giveaway.channelId || '') ||
                typeof giveaway.prize !== 'string' ||
                !/^\d{17,20}$/.test(giveaway.hostId || '') ||
                typeof giveaway.hostTag !== 'string' ||
                !/^\d{17,20}$/.test(giveaway.responsibleId || '') ||
                !Number.isFinite(giveaway.endsAt) ||
                !['active', 'ended'].includes(giveaway.status) ||
                !Array.isArray(giveaway.entries)) {
                throw new Error(`O sorteio ${messageId} contém dados inválidos.`);
            }
            const users = new Set();
            const codes = new Set();
            for (const entry of giveaway.entries) {
                if (!entry || !/^\d{17,20}$/.test(entry.userId || '') || users.has(entry.userId)) {
                    throw new Error(`O sorteio ${messageId} contém participantes inválidos ou repetidos.`);
                }
                users.add(entry.userId);
                if (typeof entry.code === 'string' && /^[A-Z0-9]{6}$/.test(entry.code)) {
                    if (codes.has(entry.code)) {
                        throw new Error(`O sorteio ${messageId} contém códigos repetidos.`);
                    }
                    codes.add(entry.code);
                    continue;
                }
                if (!Number.isSafeInteger(entry.number) || entry.number < 1) {
                    throw new Error(`O sorteio ${messageId} contém um código de participação inválido.`);
                }
                entry.code = generateGiveawayCode(codes);
                delete entry.number;
                migratedLegacyEntries = true;
            }
            if (giveaway.winnerId && !giveaway.winnerCode) {
                const legacyWinner = giveaway.entries.find(entry =>
                    entry.userId === giveaway.winnerId || entry.number === giveaway.winnerNumber
                );
                giveaway.winnerCode = legacyWinner?.code || null;
                delete giveaway.winnerNumber;
                migratedLegacyEntries = true;
            }
            if (typeof giveaway.resultAnnounced !== 'boolean') {
                giveaway.resultAnnounced = false;
                migratedLegacyEntries = true;
            }
        }
        giveaways = storedGiveaways;
        if (migratedLegacyEntries) {
            const temporaryPath = `${GIVEAWAY_DATA_PATH}.tmp`;
            await fs.writeFile(temporaryPath, JSON.stringify(giveaways, null, 2), 'utf8');
            await fs.rename(temporaryPath, GIVEAWAY_DATA_PATH);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            giveaways = {};
            return;
        }
        throw error;
    }
}

function generateGiveawayCode(existingCodes = new Set()) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let attempt = 0; attempt < 100; attempt += 1) {
        let code = '';
        for (let index = 0; index < 6; index += 1) {
            code += characters[crypto.randomInt(characters.length)];
        }
        if (!existingCodes.has(code)) return code;
    }
    throw new Error('Não consegui gerar um código único para o participante do sorteio.');
}

async function updateGiveaways(update) {
    const write = giveawayWriteQueue.catch(() => {}).then(async () => {
        const previous = JSON.stringify(giveaways);
        try {
            const result = await update();
            const temporaryPath = `${GIVEAWAY_DATA_PATH}.tmp`;
            await fs.writeFile(temporaryPath, JSON.stringify(giveaways, null, 2), 'utf8');
            await fs.rename(temporaryPath, GIVEAWAY_DATA_PATH);
            return result;
        } catch (error) {
            giveaways = JSON.parse(previous);
            throw error;
        }
    });
    giveawayWriteQueue = write;
    return write;
}

function parseGiveawayDuration(value) {
    const match = value.trim().match(/^([1-9]\d*)\s*(m|h|d)$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    const unitMilliseconds = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase()];
    const duration = amount * unitMilliseconds;
    return Number.isSafeInteger(duration) && duration >= 60_000 && duration <= 30 * 86_400_000
        ? duration
        : null;
}

function buildGiveawayEmbed(giveaway, ended = false) {
    const embed = new EmbedBuilder()
        .setColor(ended ? '#6B7280' : '#8B5CF6')
        .setTitle(ended ? '🎉 Sorteio encerrado' : '🎉 SORTEIO')
        .setDescription([
            `🎁 **Prêmio:** ${giveaway.prize}`,
            `👤 **Responsável:** <@${giveaway.responsibleId}>`,
            `👥 **Participantes:** ${giveaway.entries.length}`,
            ended ? '**Status:** Encerrado' : `⏰ **Termina:** <t:${Math.floor(giveaway.endsAt / 1000)}:R>`,
            ended && giveaway.winnerId ? `🏆 **Vencedor:** <@${giveaway.winnerId}> (código ${giveaway.winnerCode})` : '',
            ended && !giveaway.winnerId ? '😕 Ninguém participou deste sorteio.' : '',
        ].filter(Boolean).join('\n'))
        .setFooter({ text: `Organizado por ${giveaway.hostTag}` })
        .setTimestamp();
    return embed;
}

function buildGiveawayJoinRow(giveawayId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`kkjj:giveaway:join:${giveawayId}`)
            .setLabel('Participar do sorteio')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🎟️')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`kkjj:giveaway:my-code:${giveawayId}`)
            .setLabel('Ver meu número')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔎'),
    );
}

async function finishGiveaway(giveawayId, force = false) {
    if (giveawayFinishLocks.has(giveawayId)) return;
    giveawayFinishLocks.add(giveawayId);
    try {
        const result = await updateGiveaways(() => {
            const giveaway = giveaways[giveawayId];
            if (!giveaway || (giveaway.status === 'active' && !force && giveaway.endsAt > Date.now()) ||
                (giveaway.status === 'ended' && giveaway.resultAnnounced) ||
                !['active', 'ended'].includes(giveaway.status)) return null;
            if (giveaway.status === 'active') {
                const winner = giveaway.entries.length
                    ? giveaway.entries[crypto.randomInt(giveaway.entries.length)]
                    : null;
                giveaway.status = 'ended';
                giveaway.winnerId = winner?.userId || null;
                giveaway.winnerCode = winner?.code || null;
            }
            return { ...giveaway, entries: [...giveaway.entries] };
        });
        if (!result) return;

        try {
            const channel = await client.channels.fetch(result.channelId);
            if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
                throw new Error('O canal do sorteio não está disponível para publicar o resultado.');
            }
            try {
                await refreshGiveawayMessage(giveawayId);
            } catch (error) {
                console.error(`Não consegui atualizar o painel do sorteio encerrado ${giveawayId}:`, error);
            }
            const mentions = [result.winnerId, result.responsibleId].filter(Boolean);
            const uniqueMentions = [...new Set(mentions)];
            await channel.send({
                content: result.winnerId
                    ? `🎉 Parabéns <@${result.winnerId}>! Você ganhou **${result.prize}** com o código **${result.winnerCode}**!\nResponsável pelo sorteio: <@${result.responsibleId}>.`
                    : `🎉 O sorteio de **${result.prize}** foi encerrado sem participantes.\nResponsável: <@${result.responsibleId}>.`,
                allowedMentions: { users: uniqueMentions },
            });
            await updateGiveaways(() => {
                const giveaway = giveaways[giveawayId];
                if (giveaway?.status === 'ended') giveaway.resultAnnounced = true;
            });
        } catch (error) {
            console.error(`Erro ao publicar o resultado do sorteio ${giveawayId}:`, error);
        }
    } finally {
        giveawayFinishLocks.delete(giveawayId);
    }
}

async function finishOverdueGiveaways() {
    const overdueIds = Object.entries(giveaways)
        .filter(([, giveaway]) =>
            (giveaway.status === 'active' && giveaway.endsAt <= Date.now()) ||
            (giveaway.status === 'ended' && !giveaway.resultAnnounced)
        )
        .map(([giveawayId]) => giveawayId);
    for (const giveawayId of overdueIds) {
        await finishGiveaway(giveawayId);
    }
}

async function refreshGiveawayMessage(giveawayId) {
    const previousUpdate = giveawayMessageQueues.get(giveawayId) || Promise.resolve();
    const update = previousUpdate.catch(() => {}).then(async () => {
        const giveaway = giveaways[giveawayId];
        if (!giveaway) return;
        const snapshot = { ...giveaway, entries: [...giveaway.entries] };
        const channel = await client.channels.fetch(snapshot.channelId);
        if (!channel || !channel.isTextBased() || typeof channel.messages?.fetch !== 'function') {
            throw new Error('O canal do sorteio não está disponível para atualizar o painel.');
        }
        const message = await channel.messages.fetch(giveawayId);
        await message.edit({
            embeds: [buildGiveawayEmbed(snapshot, snapshot.status === 'ended')],
            components: [buildGiveawayJoinRow(giveawayId, snapshot.status !== 'active')],
            allowedMentions: { parse: [] },
        });
    });
    giveawayMessageQueues.set(giveawayId, update);
    try {
        await update;
    } finally {
        if (giveawayMessageQueues.get(giveawayId) === update) {
            giveawayMessageQueues.delete(giveawayId);
        }
    }
}

async function confirmTicketPayment(guild, channel, actor) {
    const ownerId = channel.topic?.match(/kkjj-ticket-owner:(\d+)/)?.[1];
    if (!ownerId ||
        channel.topic.includes('kkjj-ticket-status:closed') ||
        channel.topic.includes('kkjj-ticket-status:customer-closed')) {
        throw new Error('Este ticket não está mais aberto.');
    }

    const config = await getGuildSettings(guild.id);
    if (!config.futureCustomerRoleId || !config.customerRoleId) {
        throw new Error('Configure os cargos Futuro Cliente e Cliente na aba Pix e pagamentos do painel.');
    }
    if (config.futureCustomerRoleId === config.customerRoleId) {
        throw new Error('Os cargos Futuro Cliente e Cliente precisam ser diferentes.');
    }
    if ([config.verifiedRoleId, config.pendingRoleId].includes(config.customerRoleId)) {
        throw new Error('O cargo Cliente precisa ser diferente dos cargos de verificação.');
    }

    const [futureCustomerRole, customerRole, customer] = await Promise.all([
        guild.roles.fetch(config.futureCustomerRoleId),
        guild.roles.fetch(config.customerRoleId),
        guild.members.fetch(ownerId),
    ]);
    const botMember = guild.members.me;
    if (!futureCustomerRole || !customerRole) {
        throw new Error('Um dos cargos configurados não existe mais.');
    }
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ||
        futureCustomerRole.position >= botMember.roles.highest.position ||
        customerRole.position >= botMember.roles.highest.position) {
        throw new Error('O bot precisa de Gerenciar cargos, e ambos os cargos precisam estar abaixo do cargo mais alto dele.');
    }
    if (customer.roles.cache.has(customerRole.id) && !customer.roles.cache.has(futureCustomerRole.id)) {
        return { customer, alreadyConfirmed: true };
    }
    if (!customer.roles.cache.has(futureCustomerRole.id)) {
        throw new Error(`<@${customer.id}> não possui o cargo Futuro Cliente. Nenhum cargo foi alterado.`);
    }

    let auditLogged = true;
    try {
        const auditEmbed = new EmbedBuilder()
            .setColor('#22C55E')
            .setTitle('Pagamento confirmado')
            .setDescription(`Cliente: <@${customer.id}>\nConfirmado por: <@${actor.id}>`)
            .setTimestamp();
        await channel.send({
            embeds: [auditEmbed],
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        auditLogged = false;
        console.error('Não consegui registrar a confirmação do pagamento no histórico do ticket:', error);
    }

    await customer.roles.add(customerRole, `Pagamento confirmado por ${actor.tag} no ticket.`);
    try {
        await customer.roles.remove(futureCustomerRole, `Pagamento confirmado por ${actor.tag} no ticket.`);
    } catch (error) {
        console.error('Cliente recebeu o cargo Cliente, mas não consegui remover Futuro Cliente:', error);
        throw new Error(`<@${customer.id}> recebeu o cargo Cliente, mas não consegui remover Futuro Cliente. Confira a hierarquia e as permissões do bot.`);
    }
    return { customer, alreadyConfirmed: false, auditLogged };
}

async function createTicketTranscript(channel, { action, actor, reason }) {
    const logChannel = await findTicketLogChannel(channel.guild, 'close');
    if (!logChannel) {
        throw new Error('Canal de logs de encerramento não configurado. Use !logticketclose no canal desejado.');
    }

    const fetchedMessages = [];
    let before;
    while (true) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (batch.size === 0) break;
        fetchedMessages.push(...batch.values());
        before = batch.last().id;
        if (batch.size < 100) break;
    }
    fetchedMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const ownerId = channel.topic?.match(/kkjj-ticket-owner:(\d+)/)?.[1] || 'desconhecido';
    const categoryId = channel.topic?.match(/(?:^|\s\|\s)categoria:([^ |]+)/)?.[1] || 'não especificado';
    const categoryLabels = {
        compra: '🛒 Compra',
        suporte: '🛠️ Suporte',
        duvida: '❓ Dúvida',
    };
    const category = categoryLabels[categoryId] || categoryId;
    const openedAt = channel.createdTimestamp;
    const actionAt = Date.now();
    const actionLabel = action === 'encerrado pela equipe' ? 'Finalizado em' : 'Cliente saiu em';
    const transcriptLines = [
        `Ticket: #${channel.name} (${channel.id})`,
        `Servidor: ${channel.guild.name} (${channel.guild.id})`,
        `Tipo: ${category}`,
        `Aberto em: ${new Date(openedAt).toISOString()}`,
        `${actionLabel}: ${new Date(actionAt).toISOString()}`,
        `Cliente: ${ownerId}`,
        `Ação: ${action}`,
        `Responsável pela ação: ${actor.tag} (${actor.id})`,
        `Motivo: ${reason}`,
        '',
    ];

    for (const ticketMessage of fetchedMessages) {
        const date = new Date(ticketMessage.createdTimestamp).toISOString();
        const content = ticketMessage.content || (ticketMessage.embeds.length ? '[mensagem com embed]' : '');
        transcriptLines.push(`[${date}] ${ticketMessage.author.tag} (${ticketMessage.author.id}): ${content}`);
        for (const attachment of ticketMessage.attachments.values()) {
            transcriptLines.push(`  Anexo: ${attachment.name || 'arquivo'} — ${attachment.url}`);
        }
    }

    const transcript = transcriptLines.join('\n');
    const maxPartBytes = 7 * 1024 * 1024;
    const parts = [];
    let currentPart = '';
    for (const line of transcript.split('\n')) {
        const nextLine = `${line}\n`;
        if (currentPart && Buffer.byteLength(currentPart + nextLine, 'utf8') > maxPartBytes) {
            parts.push(currentPart);
            currentPart = '';
        }
        currentPart += nextLine;
    }
    if (currentPart) parts.push(currentPart);

    const embedLog = new EmbedBuilder()
        .setColor(action === 'encerrado pela equipe' ? '#EF4444' : '#F59E0B')
        .setTitle(action === 'encerrado pela equipe' ? 'Ticket encerrado' : 'Cliente saiu do ticket')
        .addFields(
            { name: 'Tipo', value: category, inline: true },
            { name: 'Aberto em', value: `<t:${Math.floor(openedAt / 1000)}:F>`, inline: true },
            { name: actionLabel, value: `<t:${Math.floor(actionAt / 1000)}:F>`, inline: true },
            { name: 'Cliente', value: `<@${ownerId}>`, inline: true },
            { name: 'Ação por', value: `<@${actor.id}>`, inline: true },
            { name: 'Motivo', value: reason },
        )
        .setTimestamp();

    await fs.mkdir(TICKET_TRANSCRIPTS_PATH, { recursive: true });
    const transcriptId = crypto.randomUUID();
    for (let i = 0; i < parts.length; i++) {
        const transcriptPath = path.join(TICKET_TRANSCRIPTS_PATH, `ticket-${transcriptId}-part-${i + 1}.txt`);
        await fs.writeFile(transcriptPath, parts[i], 'utf8');
    }

    const downloadButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`kkjj:ticket:transcript:${transcriptId}:${parts.length}`)
            .setLabel('Baixar histórico')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📥'),
    );
    await logChannel.send({
        embeds: [embedLog],
        components: [downloadButton],
        allowedMentions: { parse: [] },
    });
}

function createTranscriptPartSelector(transcriptId, partCount, page) {
    const pageSize = 25;
    const firstPart = page * pageSize;
    const lastPart = Math.min(firstPart + pageSize, partCount);
    const selector = new StringSelectMenuBuilder()
        .setCustomId(`kkjj:ticket:transcript-select:${transcriptId}:${partCount}:${page}`)
        .setPlaceholder('Selecione a parte do histórico')
        .addOptions(Array.from({ length: lastPart - firstPart }, (_, offset) => {
            const part = firstPart + offset + 1;
            return { label: `Parte ${part} de ${partCount}`, value: String(part) };
        }));
    const rows = [new ActionRowBuilder().addComponents(selector)];
    if (partCount > pageSize) {
        const navigation = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`kkjj:ticket:transcript-page:${transcriptId}:${partCount}:${Math.max(0, page - 1)}`)
                .setLabel('Anterior')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`kkjj:ticket:transcript-page:${transcriptId}:${partCount}:${Math.min(Math.ceil(partCount / pageSize) - 1, page + 1)}`)
                .setLabel('Próxima')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(lastPart === partCount),
        );
        rows.push(navigation);
    }
    return rows;
}

async function sendTranscriptPart(interaction, transcriptId, part, useEditReply = false) {
    const transcriptPath = path.join(TICKET_TRANSCRIPTS_PATH, `ticket-${transcriptId}-part-${part}.txt`);
    try {
        await fs.access(transcriptPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error('Este arquivo de histórico não foi encontrado no armazenamento do bot.');
        }
        throw error;
    }
    const attachment = new AttachmentBuilder(transcriptPath, {
        name: `ticket-transcript-${part}.txt`,
    });
    const payload = {
        content: '📥 Histórico do ticket:',
        files: [attachment],
        allowedMentions: { parse: [] },
    };
    return useEditReply
        ? interaction.editReply(payload)
        : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once('clientReady', async () => {
    console.log(`Bot online como ${client.user.tag}!`);
    try {
        const commands = await client.application.commands.fetch();
        const pixCommand = commands.find(command => command.name === 'pix');
        await pixCommand?.delete();
    } catch (error) {
        console.error('Erro ao remover o comando antigo /pix:', error);
    }
    try {
        const testCommand = (await client.application.commands.fetch()).find(command => command.name === 'teste');
        await testCommand?.delete();
    } catch (error) {
        console.error('Erro ao remover o comando antigo /teste:', error);
    }
    try {
        await loadGiveaways();
        await finishOverdueGiveaways();
        const giveawayTimer = setInterval(() => {
            finishOverdueGiveaways().catch(error => {
                console.error('Erro ao verificar sorteios vencidos:', error);
            });
        }, 15_000);
        giveawayTimer.unref();
    } catch (error) {
        console.error('Erro ao carregar ou iniciar os sorteios salvos:', error);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const commandListInput = message.content.trim();
    if (/^!comands(?:\s|$)/i.test(commandListInput)) {
        const commandListMatch = commandListInput.match(/^!comands(?:\s+<#(\d+)>)?$/i);
        if (!message.guild || message.channel.type !== ChannelType.GuildText) {
            return message.reply('❌ Use `!comands` em um canal de texto do servidor.');
        }
        if (!commandListMatch) {
            return message.reply('❌ Use `!comands` ou `!comands #canal` para publicar a lista.');
        }
        if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return message.reply('❌ Você precisa da permissão Gerenciar servidor para publicar a lista de comandos.');
        }

        const targetChannelId = commandListMatch[1];
        let targetChannel = message.channel;
        if (targetChannelId) {
            try {
                targetChannel = await message.guild.channels.fetch(targetChannelId);
            } catch (error) {
                console.error('Erro ao localizar o canal indicado para !comands:', error);
                return message.reply('❌ Não consegui localizar o canal indicado.');
            }
        }

        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
            return message.reply('❌ Escolha um canal de texto deste servidor.');
        }

        const botPermissions = targetChannel.permissionsFor(message.guild.members.me);
        if (!botPermissions?.has(PermissionFlagsBits.SendMessages) ||
            !botPermissions?.has(PermissionFlagsBits.EmbedLinks)) {
            return message.reply('❌ Preciso das permissões Enviar mensagens e Inserir links no canal escolhido.');
        }

        const commandList = new EmbedBuilder()
            .setColor('#8B5CF6')
            .setTitle('📚 Comandos do bot KKJJ Store')
            .setDescription(PREFIX_COMMANDS
                .map(command => `**${command.names}** — ${command.description}`)
                .join('\n'))
            .setFooter({ text: 'Lista atualizada dos comandos disponíveis' })
            .setTimestamp();

        try {
            await targetChannel.send({
                embeds: [commandList],
                allowedMentions: { parse: [] },
            });
            if (targetChannel.id !== message.channel.id) {
                return message.reply(`✅ Lista de comandos enviada para <#${targetChannel.id}>.`);
            }
            return;
        } catch (error) {
            console.error('Erro ao publicar a lista de comandos:', error);
            return message.reply('❌ Não consegui publicar a lista de comandos. Verifique as permissões do bot no canal escolhido.');
        }
    }

    if (/^!sorteio(?:\s|$)/i.test(message.content.trim())) {
        const match = message.content.trim().match(/^!sorteio\s+<@!?(\d+)>$/i);
        if (!message.guild || message.channel.type !== ChannelType.GuildText) {
            return message.reply('❌ Use `!sorteio @responsável` em um canal de texto do servidor.');
        }
        if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return message.reply('❌ Você precisa da permissão Gerenciar servidor para criar um sorteio.');
        }
        const botPermissions = message.channel.permissionsFor(message.guild.members.me);
        if (!botPermissions?.has(PermissionFlagsBits.ManageMessages)) {
            return message.reply('❌ Preciso da permissão Gerenciar mensagens para remover o comando e deixar apenas o sorteio no canal.');
        }
        if (!match) {
            return message.reply('❌ Use `!sorteio @responsável` e mencione quem será marcado no resultado.');
        }

        let responsible;
        try {
            responsible = await message.guild.members.fetch(match[1]);
        } catch (error) {
            console.error('Erro ao localizar o responsável pelo sorteio:', error);
            return message.reply('❌ Não consegui localizar essa pessoa neste servidor.');
        }
        if (responsible.user.bot) {
            return message.reply('❌ O responsável pelo sorteio precisa ser uma pessoa, não um bot.');
        }

        const setupButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`kkjj:giveaway:setup:${message.author.id}:${responsible.id}`)
                .setLabel('Configurar sorteio')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎁'),
        );
        let setupMessage;
        try {
            setupMessage = await message.reply({
                content: `🎉 Clique para configurar o sorteio. Responsável pelo resultado: <@${responsible.id}>.`,
                components: [setupButton],
                allowedMentions: { parse: [] },
            });
            await message.delete();
            return setupMessage;
        } catch (error) {
            console.error('Erro ao preparar ou remover a mensagem inicial do sorteio:', error);
            if (setupMessage) {
                try {
                    await setupMessage.delete();
                } catch (cleanupError) {
                    console.error('Não consegui remover o painel de configuração incompleto do sorteio:', cleanupError);
                }
            }
            try {
                return await message.reply('❌ Não consegui limpar a mensagem inicial do sorteio. Verifique minhas permissões e tente novamente.');
            } catch (replyError) {
                console.error('Não consegui informar a falha ao iniciar o sorteio:', replyError);
                return;
            }
        }
    }

    if (/^!encerrarsorteio$/i.test(message.content.trim())) {
        if (!message.guild || message.channel.type !== ChannelType.GuildText) {
            return message.reply('❌ Use `!encerrarsorteio` no canal do sorteio.');
        }
        if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return message.reply('❌ Você precisa da permissão Gerenciar servidor para encerrar um sorteio.');
        }
        const giveawayMessageId = message.reference?.messageId;
        if (!giveawayMessageId) {
            return message.reply('❌ Responda à publicação do sorteio com `!encerrarsorteio` para encerrá-lo.');
        }

        const giveaway = giveaways[giveawayMessageId];
        if (!giveaway ||
            giveaway.guildId !== message.guild.id ||
            giveaway.channelId !== message.channel.id ||
            giveaway.status !== 'active') {
            return message.reply('❌ A mensagem respondida não é um sorteio ativo deste canal.');
        }

        try {
            await finishGiveaway(giveawayMessageId, true);
            const finishedGiveaway = giveaways[giveawayMessageId];
            if (finishedGiveaway?.status !== 'ended') {
                return message.reply('❌ Não consegui encerrar o sorteio. Tente novamente.');
            }
            return message.reply(
                finishedGiveaway.resultAnnounced
                    ? '✅ Sorteio encerrado; o resultado foi publicado.'
                    : '✅ Sorteio encerrado. O resultado será publicado assim que o bot conseguir acessar o canal.',
            );
        } catch (error) {
            console.error(`Erro ao encerrar manualmente o sorteio ${giveawayMessageId}:`, error);
            return message.reply('❌ Não consegui encerrar o sorteio agora. Tente novamente.');
        }
    }

    // Comando !ping
    if (message.content === '!ping') {
        return message.reply('Pong! 🏓');
    }

    if (message.content.trim() === '!aviso') {
        if (!message.guild || message.channel.type !== ChannelType.GuildText) {
            return message.reply('❌ Use este comando em um canal de texto do servidor.');
        }
        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return message.reply('❌ Você precisa da permissão Gerenciar servidor para publicar avisos.');
        }
        const botPermissions = message.channel.permissionsFor(message.guild.members.me);
        if (!botPermissions?.has(PermissionFlagsBits.ManageMessages)) {
            return message.reply('❌ Preciso da permissão Gerenciar mensagens neste canal para remover o painel depois da publicação.');
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('kkjj:announcement:open')
                .setLabel('Escrever aviso')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📢')
        );
        const panelMessage = await message.channel.send({
            content: '📣 **Criar um aviso da KKJJ Store**\nClique no botão abaixo para preencher o título e a mensagem. O aviso será publicado neste canal.',
            components: [row],
        });
        await message.delete();
        return panelMessage;
    }

    const ticketLogCommand = message.content.trim();
    if (['!logtickets', '!logticketopen', '!logticketclose', '!logentrada', '!logsaida', '!logmembros'].includes(ticketLogCommand)) {
        if (!message.guild || message.channel.type !== ChannelType.GuildText) {
            return message.reply('❌ Use este comando no canal de texto que deve receber os logs.');
        }
        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return message.reply('❌ Você precisa da permissão Gerenciar servidor para configurar o canal de logs.');
        }

        try {
            const settings = await readTicketSettings();
            const currentSettings = settings[message.guild.id];
            const channels = typeof currentSettings === 'string'
                ? { open: currentSettings, close: currentSettings, join: null, leave: null }
                : {
                    open: currentSettings?.open || null,
                    close: currentSettings?.close || null,
                    join: currentSettings?.join || null,
                    leave: currentSettings?.leave || null,
                };
            if (ticketLogCommand === '!logtickets') {
                channels.open = message.channel.id;
                channels.close = message.channel.id;
            } else if (ticketLogCommand === '!logmembros') {
                channels.join = message.channel.id;
                channels.leave = message.channel.id;
            } else if (ticketLogCommand === '!logentrada' || ticketLogCommand === '!logsaida') {
                channels[ticketLogCommand === '!logentrada' ? 'join' : 'leave'] = message.channel.id;
            } else {
                channels[ticketLogCommand === '!logticketopen' ? 'open' : 'close'] = message.channel.id;
            }
            settings[message.guild.id] = channels;
            await fs.writeFile(TICKET_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
            const botPermissions = message.channel.permissionsFor(message.guild.members.me);
            const needsTranscriptPermissions = ticketLogCommand === '!logticketclose' || ticketLogCommand === '!logtickets';
            if (!botPermissions?.has(PermissionFlagsBits.SendMessages) ||
                !botPermissions?.has(PermissionFlagsBits.EmbedLinks) ||
                (needsTranscriptPermissions && !botPermissions?.has(PermissionFlagsBits.AttachFiles))) {
                const requiredPermissions = needsTranscriptPermissions
                    ? '**Enviar mensagens**, **Anexar arquivos** e **Inserir links**'
                    : '**Enviar mensagens** e **Inserir links**';
                return message.reply(`⚠️ Salvei este canal como destino, mas preciso das permissões ${requiredPermissions} para registrar os logs.`);
            }
            const confirmations = {
                '!logticketopen': 'aberturas dos tickets',
                '!logticketclose': 'encerramentos e históricos dos tickets',
                '!logtickets': 'aberturas, encerramentos e históricos dos tickets',
                '!logentrada': 'entradas de membros',
                '!logsaida': 'saídas de membros',
                '!logmembros': 'entradas e saídas de membros',
            };
            const confirmation = confirmations[ticketLogCommand];
            return message.reply(`✅ Este canal foi configurado para receber ${confirmation}.`);
        } catch (error) {
            console.error('Erro ao configurar o canal de logs dos tickets:', error);
            return message.reply('❌ Não consegui salvar o canal de logs. Verifique as permissões de escrita do bot.');
        }
    }

    // Publica o painel de tickets no canal em que o comando foi usado.
    if (message.content.trim() === '!ticket') {
        if (!message.guild || message.channel.type !== ChannelType.GuildText) {
            return message.reply('❌ Este comando só pode ser usado em um canal de texto do servidor.');
        }

        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return message.reply('❌ Você precisa da permissão Gerenciar servidor para publicar o painel de tickets.');
        }

        const embedTicket = new EmbedBuilder()
            .setColor('#8B5CF6')
            .setAuthor({ name: '🛒  ＫＫＪＪ 𝖦𝗋𝖺𝗉𝗁𝗂𝖼𝗌 𝖲𝖳𝖮𝖱𝖤' })
            .setDescription('Precisa de ajuda? Abra um ticket privado e escolha o assunto. Nossa equipe atenderá você por lá.')
            .addFields(
                { name: '🛠️ Suporte', value: 'Ajuda com um produto ou pedido.', inline: false },
                { name: '❓ Dúvidas', value: 'Perguntas sobre mods gráficos, maps, modpacks e outros.', inline: false },
                { name: '🛒 Compras', value: 'Disponibilidade, preços e pedidos; pagamento via Pix.', inline: false },
                { name: '🔒 Atendimento privado', value: 'Só você e a equipe de vendas poderão ver o ticket. Nunca envie senhas, códigos de acesso ou informações pessoais.', inline: false }
            );

        const botoesTicket = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('kkjj:ticket:open')
                .setLabel('Abrir ticket')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎫'),
            new ButtonBuilder()
                .setCustomId('kkjj:ticket:my')
                .setLabel('Meus tickets')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('📨')
        );

        try {
            await message.channel.send({ embeds: [embedTicket], components: [botoesTicket] });
            return message.reply('✅ Painel de atendimento publicado neste canal.');
        } catch (error) {
            console.error('Erro ao publicar o painel de tickets:', error);
            return message.reply('❌ Não consegui publicar o painel. Verifique se tenho permissão para enviar mensagens e embeds neste canal.');
        }
    }

    if (message.content.trim() === '!pix') {
        if (!message.guild || message.channel.type !== ChannelType.GuildText) {
            return message.reply('❌ Use `!pix` dentro de um ticket de texto do servidor.');
        }
        if (!await isTicketStaff(message.member)) {
            return message.reply('❌ Apenas a equipe de atendimento configurada pode enviar a chave Pix.');
        }
        if (!message.channel.topic?.match(/kkjj-ticket-owner:(\d+)/) ||
            message.channel.topic.includes('kkjj-ticket-status:closed') ||
            message.channel.topic.includes('kkjj-ticket-status:customer-closed')) {
            return message.reply('❌ Use `!pix` dentro de um ticket aberto.');
        }

        const button = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`kkjj:pix:open:${message.guild.id}:${message.channel.id}:${message.author.id}`)
                .setLabel('Inserir chave Pix')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('💳'),
        );
        const botPermissions = message.channel.permissionsFor(message.guild.members.me);
        if (!botPermissions?.has(PermissionFlagsBits.ManageMessages)) {
        return message.reply('❌ Para ocultar o comando `!pix`, preciso da permissão Gerenciar mensagens neste canal.');
        }

        let promptMessage;
        try {
        promptMessage = await message.channel.send({
            content: 'Clique para abrir o formulário Pix deste ticket. Somente você pode usar este botão.',
            components: [button],
        });
        await message.delete();
        return promptMessage;
        } catch (error) {
        console.error('Não consegui ocultar o comando !pix:', error);
        if (promptMessage) {
            try {
                await promptMessage.delete();
            } catch (cleanupError) {
                console.error('Não consegui remover o botão Pix após falha ao ocultar o comando:', cleanupError);
            }
        }
        return message.reply('❌ Não consegui ocultar o comando `!pix`. Confira se o bot tem permissão Gerenciar mensagens.');
        }
    }

    // Comando !loja / !store
    if (message.content === '!loja' || message.content === '!store') {
        try {
            const settings = message.guild ? await getGuildSettings(message.guild.id) : {};
            const value = key => settings[key] ?? DEFAULT_STORE_SETTINGS[key];
            const embedLoja = new EmbedBuilder().setColor('#2b2d31').setTimestamp();
            if (value('storeTitle')) embedLoja.setTitle(value('storeTitle'));
            if (value('storeDescription')) embedLoja.setDescription(value('storeDescription'));
            const fields = [1, 2, 3, 4]
                .map(index => ({
                    name: value(`storeField${index}Title`),
                    value: value(`storeField${index}Value`),
                }))
                .filter(field => field.name && field.value);
            if (fields.length) embedLoja.addFields(fields);
            if (value('storeImageUrl')) embedLoja.setImage(value('storeImageUrl'));
            if (value('storeFooter')) embedLoja.setFooter({ text: value('storeFooter') });
            return message.channel.send({
                embeds: [embedLoja],
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.error('Erro ao publicar a mensagem da loja:', error);
            return message.reply('❌ Não consegui carregar ou publicar a mensagem da loja. Verifique o painel e as permissões do canal.');
        }
    }

    // Comando !termos
    if (message.content === '!termos') {
        try {
            const embedTermos = new EmbedBuilder()
                .setColor('#8B5CF6')
                .setAuthor({ name: '🛒  ＫＫＪＪ 𝖦𝗋𝖺𝗉𝗁𝗂𝖼𝗌 𝖲𝖳𝖮𝖱𝖤' })
                .setTitle('📜 Termos e Condições de Compra')
                .setDescription('Leia estas condições antes de comprar. Ao realizar um pedido, você declara que leu e compreendeu os termos abaixo.')
                .addFields(
                    {
                        name: '01  •  Compras e entrega',
                        value: 'Confira o produto, o preço e as informações da oferta antes de pagar. Após a confirmação do pagamento, o pedido será enviado por mensagem direta (DM). Mantenha as DMs abertas para recebê-lo.'
                    },
                    {
                        name: '02  •  Pagamento',
                        value: 'Aceitamos **somente Pix**. O pedido será confirmado após a identificação do pagamento. Pagamentos suspeitos, fraudulentos ou realizados por meios não autorizados poderão ser recusados ou cancelados. Nunca compartilhe senhas ou dados pessoais em canais não oficiais.'
                    },
                    {
                        name: '03  •  Reembolso e cancelamento',
                        value: '• A ＫＫＪＪ 𝖦𝗋𝖺𝗉𝗁𝗂𝖼𝗌 𝖲𝖳𝖮𝖱𝖤  não oferece cancelamento ou reembolsos de produtos adquiridos.'
                    },
                    {
                        name: '04  •  Produtos digitais',
                        value: 'Mantenha suas informações de acesso em segurança. É proibido compartilhar, revender, duplicar ou distribuir os produtos adquiridos sem autorização.'
                    },
                    {
                        name: '05  •  Suporte',
                        value: 'Para dúvidas, problemas ou assistência, procure os canais oficiais da loja. Podemos solicitar informações relacionadas ao pedido e ao pagamento para ajudar no atendimento.'
                    },
                    {
                        name: '06  •  Conduta',
                        value: 'Fraudes, comprovantes falsos, contestações indevidas de pagamento ou tentativas de prejudicar a loja poderão resultar nas medidas cabíveis.'
                    },
                    {
                        name: '07  •  Alterações',
                        value: 'Estes termos poderão ser atualizados quando necessário. A versão vigente será publicada neste canal.'
                    }
                )
                .addFields({
                    name: 'Importante',
                    value: 'Ao comprar, você confirma que está ciente destas condições. Os direitos garantidos pela legislação aplicável permanecem válidos.'
                })
                .setFooter({ text: 'ＫＫＪＪ 𝖦𝗋𝖺𝗉𝗁𝗂𝖼𝗌 𝖲𝖳𝖮𝖱𝖤  •  Qualidade, confiança e segurança nas suas compras' })
                .setTimestamp();

            const settings = message.guild ? await getGuildSettings(message.guild.id) : {};
            const termsValue = key => settings[key] ?? DEFAULT_STORE_SETTINGS[key];
            embedTermos
                .setAuthor({ name: termsValue('termsAuthor') })
                .setTitle(termsValue('termsTitle'))
                .setDescription(termsValue('termsDescription'))
                .setFields(
                    [1, 2, 3, 4, 5, 6, 7]
                        .map(index => ({
                            name: termsValue(`termsField${index}Title`),
                            value: termsValue(`termsField${index}Value`),
                        }))
                        .filter(field => field.name && field.value),
                )
                .addFields({
                    name: termsValue('termsImportantTitle'),
                    value: termsValue('termsImportantValue'),
                })
                .setFooter({ text: termsValue('termsFooter') });

            await message.channel.send({ embeds: [embedTermos] });
            return message.reply('✅ Os termos foram publicados neste canal.');
        } catch (error) {
            console.error('Erro ao enviar os termos:', error);
            return message.reply('❌ Não consegui publicar os termos. Verifique se tenho permissão para enviar mensagens e embeds neste canal.');
        }
    }

    // Resposta inteligente quando o bot é mencionado, chamado por "bot" ou respondido diretamente.
    let isReplyToBot = false;
    function isBotTriggerText(content) {
        return /(^|\s)(bot|bote|botei|botar|bota|botou|botavam|botava|boto|bota[r]?)(?=$|\s|[.,!?;:])/i.test(content);
    }

    if (message.reference?.messageId && !message.mentions.has(client.user) && !isBotTriggerText(message.content)) {
        try {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
            isReplyToBot = referencedMessage.author.id === client.user.id;
        } catch (error) {
            console.error('Erro ao verificar a mensagem respondida para a IA:', error);
        }
    }

    if (message.mentions.has(client.user) || isBotTriggerText(message.content) || isReplyToBot) {
        const prompt = message.content.replace(/<@!?\d+>/g, '').replace(/(^|\s)(bot|bote|botei|botar|bota|botou|botavam|botava|boto|bota[r]?)(?=$|\s|[.,!?;:])/i, '$1').trim();

        if (!prompt) {
            return message.reply('Opa! Loja ou papo aleatório? 🎭');
        }

        try {
            await message.channel.sendTyping();
            const conversationKey = getAiConversationKey(message);
            const conversationHistory = await getAiConversation(conversationKey);
            const recentChannelContext = await getRecentChannelContext(message, 12);
            const historyForPrompt = [...conversationHistory, ...recentChannelContext].slice(-MAX_AI_HISTORY_MESSAGES);

            // 1. Procura os canais do servidor em tempo real
            let canaisServidor = '';
            let cargosServidor = '';
            let idsCargosMencionaveis = [];
            if (message.guild) {
                try {
                    const canais = await message.guild.channels.fetch();
                    const canaisTexto = canais.filter(c => c && (c.type === 0 || c.type === 5));
                    canaisServidor = canaisTexto
                        .map(c => `- ${c.name}: <#${c.id}> (${c.topic || 'Sem tópico definido'})`)
                        .join('\n');
                } catch (e) {
                    console.error('Erro ao listar canais:', e);
                }

                try {
                    const cargos = await message.guild.roles.fetch();
                    const cargosReais = cargos.filter(cargo => cargo && cargo.id !== message.guild.id);
                    idsCargosMencionaveis = [...cargosReais.keys()];
                    cargosServidor = cargosReais
                        .map(cargo => `- ${cargo.name}: <@&${cargo.id}>`)
                        .join('\n');
                } catch (e) {
                    console.error('Erro ao listar cargos:', e);
                }
            }

            // 2. Manual de Contexto do Servidor
            const systemInstruction = `
Você é o assistente virtual oficial e inteligente do servidor "K K J J Graphics STORE" no Discord.
Sua personalidade é caricata, divertida e teatral, como um personagem carismático de comédia: use energia, tiradas leves e um toque de exagero, sem transformar toda resposta em piada. Você também está aqui para distrair e conversar; quando o assunto for casual, entre na brincadeira e pode oferecer uma piada, curiosidade, charada ou mini desafio. Não force entretenimento quando a pessoa não demonstrar interesse.
Ajude com qualquer assunto que puder, não apenas com a loja: responda perguntas gerais, converse, explique temas, dê ideias e participe de brincadeiras ou jogos. Não recuse nem redirecione uma pergunta só por ela não ter relação com a KKJJ Store. Se não souber algo ou faltar contexto, diga isso com honestidade e peça esclarecimento quando necessário. Seja conciso por padrão, mas dê uma resposta mais completa quando a pessoa pedir detalhes.
Mantenha o contexto das mensagens anteriores desta conversa. Entenda referências como "ela", "isso" ou "por quê" usando o que foi dito antes e continue o assunto naturalmente, sem pedir que a pessoa repita informações já dadas.
Quando o assunto envolver a loja, compras, pagamentos, pedidos ou suporte, mude para um tom claro, confiável e respeitoso. Seja divertido sem comprometer a precisão: não invente preços, disponibilidade, políticas, canais ou informações de pedidos; admita quando não souber e direcione para o atendimento adequado.

--- INFORMAÇÕES SOBRE A LOJA & SERVIDOR ---
• Nome da Loja: K K J J Graphics STORE
• A assistente foi desenvolvida por baefed.
• O dono da loja é Klaus.
• Foco da loja: vender conteúdo para jogos.
• Produtos:
  - Mods para GTA 5/FiveM: <#1557786872455893063>
  - Maps / mapas: <#1557788295138771054>
  - ReShade Presets: <#1557789118623252650>
  - Modpacks: <#1558190005325930587>
• Não ofereça artes para redes sociais, banners, logos, avatares ou overlays: não são o foco desta loja.
• Atendimento / Suporte: para comprar ou tirar dúvidas específicas, indique o canal apropriado da lista abaixo ou oriente a abrir um ticket.

--- CANAIS EXISTENTES NO SERVIDOR ---
${canaisServidor}

--- CARGOS EXISTENTES NO SERVIDOR ---
${cargosServidor}

--- DIRETRIZES DE RESPOSTA ---
1. Responda de forma breve e direta, normalmente em até 20 palavras; se pedirem explicação ou detalhes, desenvolva o suficiente para realmente ajudar. Evite introduções e repetir a pergunta.
2. Responda em português simples e natural. Em conversa casual, use humor leve e espontâneo sem exagerar ou prolongar a piada; em assuntos da loja, priorize clareza, seriedade e confiança.
3. Ao indicar canal, use somente a menção real no formato <#ID>; nunca repita o nome do canal em texto ou entre parênteses depois da menção. Use somente canais listados abaixo e os canais de produtos definidos neste prompt.
4. Para dúvidas sobre mods de GTA 5/FiveM, indique <#1557786872455893063>; para Maps/mapas, <#1557788295138771054>; para ReShade Presets, <#1557789118623252650>; para Modpacks, <#1558190005325930587>. Escolha o canal que corresponde ao produto perguntado.
5. Se perguntarem sobre produtos ou recomendações, responda brevemente e indique o canal relevante, se houver. Nunca escreva #unknown nem invente outro canal.
6. Indique o canal de ticket ou dúvidas somente quando a pessoa pedir ajuda com a loja, compra ou suporte, ou perguntar onde deve ir. Não direcione perguntas gerais, cumprimentos ou conversa casual para canais.
7. Ao indicar um cargo, use o formato <@&ID> e somente IDs presentes na lista; nunca invente canais ou cargos.
8. Se perguntarem, diga que foi desenvolvida por baefed e que o dono da loja é Klaus. Nunca informe o nome de usuário dele.
9. Em assuntos de suporte, nunca use sarcasmo; seja prestativo e acolhedor. Não faça piadas sobre problemas, dinheiro, pedidos ou frustrações do cliente.
10. Nunca insulte, humilhe, pressione ou constranja alguém. Mantenha as brincadeiras amigáveis e respeite o tom da conversa.
`;

            // 3. Chamada utilizando o modelo ativo oficial
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: 'system', content: systemInstruction },
                    ...historyForPrompt,
                    { role: 'user', content: prompt }
                ],
                model: GROQ_MODEL,
            });

            const replyText = extractGroqText(completion?.choices?.[0]?.message) || buildChatFallback(prompt);
            const formattedReply = replyText.replace(/<#(\d+)>\s*\(([^)\r\n]+)\)/g, (match, channelId, channelLabel) => {
                const channel = message.guild?.channels.cache.get(channelId);
                return channel && channel.name.toLocaleLowerCase() === channelLabel.trim().toLocaleLowerCase()
                    ? `<#${channelId}>`
                    : match;
            });

            const responseToSend = formattedReply.length > 2000 ? `${formattedReply.slice(0, 1990)}...` : formattedReply;
            await message.reply({
                content: responseToSend,
                allowedMentions: { roles: idsCargosMencionaveis },
            });
            try {
                await updateAiMemory(conversationKey, [
                    ...historyForPrompt,
                    { role: 'user', content: prompt },
                    { role: 'assistant', content: responseToSend },
                ]);
            } catch (error) {
                console.error('Erro ao salvar a memória da IA:', error);
                await message.reply('⚠️ Respondi, mas não consegui salvar o contexto desta conversa.');
            }

        } catch (error) {
            console.error('Erro na IA (Groq):', error);
            message.reply('Tive um pequeno problema ao processar sua pergunta. Tente novamente em instantes!');
        }
    }
});

client.on('guildMemberAdd', async (member) => {
    try {
        const config = await getGuildSettings(member.guild.id);
        try {
            const logChannel = await findMemberLogChannel(member.guild, 'join');
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor('#22C55E')
                    .setTitle('📥 Membro entrou')
                    .setThumbnail(member.displayAvatarURL({ extension: 'png', size: 256 }))
                    .addFields(
                        { name: 'Membro', value: `<@${member.id}> (\`${member.user.tag}\`)`, inline: true },
                        { name: 'ID', value: member.id, inline: true },
                        { name: 'Conta criada', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                        { name: 'Membros no servidor', value: String(member.guild.memberCount), inline: true },
                    )
                    .setTimestamp();
                await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
            }
        } catch (error) {
            console.error(`Erro ao registrar a entrada de ${member.user.tag}:`, error);
        }

        const verificationConfigured = Boolean(
            config.verificationChannelId && (config.verifiedRoleId || config.futureCustomerRoleId),
        );
        const entryRoles = verificationConfigured
            ? [config.pendingRoleId].filter(Boolean)
            : [config.autoRoleId].filter(Boolean);
        for (const roleId of entryRoles) {
            try {
                const role = await member.guild.roles.fetch(roleId);
                if (!role) {
                    console.error(`Cargo configurado (${roleId}) não encontrado no servidor ${member.guild.id}.`);
                    continue;
                }
                if (!member.roles.cache.has(role.id)) {
                    await member.roles.add(role, 'Cargo automático configurado no painel KKJJ Store.');
                }
            } catch (error) {
                console.error(`Erro ao atribuir o cargo ${roleId} para ${member.user.tag}:`, error);
            }
        }

        if (config.welcomeEnabled && config.welcomeChannelId) {
            try {
                const channel = await member.guild.channels.fetch(config.welcomeChannelId);
                if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
                    console.error(`Canal de boas-vindas configurado (${config.welcomeChannelId}) não encontrado ou incompatível.`);
                    return;
                }
                await channel.send(await buildWelcomePayload(member.guild, {
                    channel,
                    welcomeMessage: config.welcomeMessage,
                    welcomeGifUrl: config.welcomeGifUrl,
                    memberName: member.user.username,
                    memberId: member.id,
                    avatarUrl: member.displayAvatarURL({ extension: 'png', size: 128 }),
                }));
            } catch (error) {
                console.error(`Erro ao enviar boas-vindas para ${member.user.tag}:`, error);
            }
        }
    } catch (error) {
        console.error(`Erro ao carregar configurações de entrada do servidor ${member.guild.id}:`, error);
    }
});

client.on('guildMemberRemove', async (member) => {
    try {
        const logChannel = await findMemberLogChannel(member.guild, 'leave');
        if (!logChannel) return;
        const embed = new EmbedBuilder()
            .setColor('#EF4444')
            .setTitle('📤 Membro saiu')
            .setThumbnail(member.displayAvatarURL({ extension: 'png', size: 256 }))
            .addFields(
                { name: 'Membro', value: `${member.user.tag}`, inline: true },
                { name: 'ID', value: member.id, inline: true },
                { name: 'Entrou no servidor', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Data indisponível', inline: true },
                { name: 'Membros no servidor', value: String(member.guild.memberCount), inline: true },
            )
            .setTimestamp();
        await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
        console.error(`Erro ao registrar a saída do membro ${member.user?.tag || member.id}:`, error);
    }
});

async function completeMemberVerification(member, guild, config) {
    const verificationRoleIds = [...new Set([config.verifiedRoleId, config.futureCustomerRoleId].filter(Boolean))];
    if (!verificationRoleIds.length) {
        throw new Error('Configure ao menos um cargo para a verificação.');
    }
    const verificationRoles = await Promise.all(verificationRoleIds.map(roleId => guild.roles.fetch(roleId)));
    if (verificationRoles.some(role => !role)) {
        throw new Error('Um dos cargos de verificação configurados não existe mais.');
    }
    const rolesToAdd = verificationRoles.map(role => role.id);
    if (config.autoRoleId) {
        const autoRole = await guild.roles.fetch(config.autoRoleId);
        if (!autoRole) throw new Error(`O cargo automático configurado (${config.autoRoleId}) não existe mais.`);
        rolesToAdd.push(autoRole.id);
    }
    await member.roles.add(
        [...new Set(rolesToAdd)],
        'Membro concluiu a verificação do servidor.',
    );
    if (config.pendingRoleId && member.roles.cache.has(config.pendingRoleId)) {
        const pendingRole = await guild.roles.fetch(config.pendingRoleId);
        if (pendingRole) {
            await member.roles.remove(pendingRole, 'Membro concluiu a verificação.');
        }
    }
}

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot || reaction.emoji.name !== '✅') return;

    try {
        if (reaction.partial) await reaction.fetch();
        const message = reaction.message;
        if (message.partial) await message.fetch();
        const guild = message.guild;
        if (!guild) return;

        const config = await getGuildSettings(guild.id);
        if (!config.verificationMessageId ||
            message.id !== config.verificationMessageId ||
            message.channelId !== config.verificationChannelId) return;

        const member = await guild.members.fetch(user.id);
        await completeMemberVerification(member, guild, config);
        try {
            await user.send(`✅ Verificação concluída em **${guild.name}**! Você recebeu acesso ao servidor.`);
        } catch (error) {
            console.error(`Não consegui enviar confirmação de verificação por DM para ${user.tag}:`, error);
        }
    } catch (error) {
        console.error('Erro ao processar reação de verificação:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith('kkjj:giveaway:setup:')) {
        const [, , , hostId, responsibleId] = interaction.customId.split(':');
        if (interaction.user.id !== hostId) {
            return interaction.reply({
                content: '❌ Só quem iniciou a configuração pode abrir este formulário.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
            return interaction.reply({
                content: '❌ Configure o sorteio em um canal de texto do servidor.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const modal = new ModalBuilder()
            .setCustomId(`kkgj:${hostId}:${interaction.channelId}:${responsibleId}:${interaction.message.id}`)
            .setTitle('Configurar sorteio');
        const prizeInput = new TextInputBuilder()
            .setCustomId('prize')
            .setLabel('Qual é o prêmio?')
            .setPlaceholder('Ex.: um produto da loja')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(150)
            .setRequired(true);
        const durationInput = new TextInputBuilder()
            .setCustomId('duration')
            .setLabel('Duração (1m a 30d)')
            .setPlaceholder('Ex.: 30m, 2h ou 1d')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(10)
            .setRequired(true);
        modal.addComponents(
            new ActionRowBuilder().addComponents(prizeInput),
            new ActionRowBuilder().addComponents(durationInput),
        );
        try {
            await interaction.showModal(modal);
        } catch (error) {
            console.error('Erro ao abrir o formulário de configuração do sorteio:', error);
            return interaction.reply({
                content: '❌ Não consegui abrir o formulário do sorteio. Tente novamente.',
                flags: MessageFlags.Ephemeral,
            });
        }
        return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('kkgj:')) {
        const [, hostId, channelId, responsibleId, setupMessageId] = interaction.customId.split(':');
        if (interaction.user.id !== hostId || interaction.channelId !== channelId ||
            !interaction.guild || interaction.channel?.type !== ChannelType.GuildText ||
            !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
            !/^\d{17,20}$/.test(setupMessageId || '')) {
            return interaction.reply({
                content: '❌ Este formulário não corresponde à sua configuração ou você não tem mais permissão.',
                flags: MessageFlags.Ephemeral,
            });
        }
        const prize = interaction.fields.getTextInputValue('prize').trim();
        const duration = parseGiveawayDuration(interaction.fields.getTextInputValue('duration'));
        if (!prize || !duration) {
            return interaction.reply({
                content: '❌ Informe um prêmio e uma duração entre 1 minuto e 30 dias (ex.: `30m`, `2h` ou `1d`).',
                flags: MessageFlags.Ephemeral,
            });
        }
        const botPermissions = interaction.channel.permissionsFor(interaction.guild.members.me);
        if (!botPermissions?.has(PermissionFlagsBits.SendMessages) ||
            !botPermissions?.has(PermissionFlagsBits.EmbedLinks) ||
            !botPermissions?.has(PermissionFlagsBits.ManageMessages)) {
            return interaction.reply({
                content: '❌ Preciso das permissões Enviar mensagens, Inserir links e Gerenciar mensagens neste canal.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveaway = {
            guildId: interaction.guild.id,
            channelId: interaction.channelId,
            prize,
            hostId,
            hostTag: interaction.user.tag,
            responsibleId,
            endsAt: Date.now() + duration,
            status: 'active',
            entries: [],
            winnerId: null,
            winnerCode: null,
            resultAnnounced: false,
        };
        let giveawayMessage;
        try {
            giveawayMessage = await interaction.channel.send({
                embeds: [buildGiveawayEmbed(giveaway)],
                allowedMentions: { parse: [] },
            });
            giveawayMessage = await giveawayMessage.edit({
                components: [buildGiveawayJoinRow(giveawayMessage.id)],
            });
            await updateGiveaways(() => {
                giveaways[giveawayMessage.id] = giveaway;
            });
        } catch (error) {
            console.error('Erro ao publicar ou salvar o sorteio:', error);
            if (giveawayMessage) {
                try {
                    await giveawayMessage.delete();
                } catch (cleanupError) {
                    console.error('Não consegui remover o painel de sorteio não salvo:', cleanupError);
                }
            }
            return interaction.editReply('❌ Não consegui publicar e salvar o sorteio. Verifique as permissões do bot e tente novamente.');
        }
        let setupMessageRemoved = true;
        try {
            const setupMessage = await interaction.channel.messages.fetch(setupMessageId);
            await setupMessage.delete();
        } catch (error) {
            setupMessageRemoved = false;
            console.error('Sorteio publicado, mas não consegui remover o painel de configuração:', error);
        }
        return interaction.editReply(
            setupMessageRemoved
                ? '✅ Sorteio publicado! A configuração foi removida do canal.'
                : '✅ Sorteio publicado, mas não consegui apagar o painel de configuração. Confira a permissão Gerenciar mensagens.',
        );
    }

    if (interaction.isButton() && interaction.customId.startsWith('kkjj:giveaway:join:')) {
        const giveawayId = interaction.customId.slice('kkjj:giveaway:join:'.length);
        if (!interaction.guild || !/^\d{17,20}$/.test(giveawayId)) {
            return interaction.reply({
                content: '❌ Este botão de sorteio é inválido.',
                flags: MessageFlags.Ephemeral,
            });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const entryResult = await updateGiveaways(() => {
                const giveaway = giveaways[giveawayId];
                if (!giveaway || giveaway.guildId !== interaction.guild.id || giveaway.status !== 'active') {
                    return { unavailable: true };
                }
                if (giveaway.endsAt <= Date.now()) {
                    return { expired: true };
                }
                let entry = giveaway.entries.find(item => item.userId === interaction.user.id);
                const alreadyJoined = Boolean(entry);
                if (!entry) {
                    const existingCodes = new Set(giveaway.entries.map(item => item.code));
                    entry = { userId: interaction.user.id, code: generateGiveawayCode(existingCodes) };
                    giveaway.entries.push(entry);
                }
                return {
                    giveaway: { ...giveaway, entries: [...giveaway.entries] },
                    code: entry.code,
                    alreadyJoined,
                };
            });

            if (entryResult.unavailable) {
                return interaction.editReply('❌ Este sorteio não está mais disponível.');
            }
            if (entryResult.expired) {
                await finishGiveaway(giveawayId);
                return interaction.editReply('⏰ O prazo deste sorteio terminou; o resultado está sendo publicado.');
            }

            if (!entryResult.alreadyJoined) {
                try {
                    await refreshGiveawayMessage(giveawayId);
                } catch (error) {
                    console.error(`Não consegui atualizar o total de participantes do sorteio ${giveawayId}:`, error);
                }
            }

            let dmSent = true;
            try {
                await interaction.user.send(
                    `🎟️ Você está participando do sorteio de **${entryResult.giveaway.prize}** no servidor **${interaction.guild.name}**.\nSeu código é **${entryResult.code}**. Boa sorte!`,
                );
            } catch (error) {
                dmSent = false;
                console.error(`Não consegui enviar por DM o número do sorteio ${giveawayId} para ${interaction.user.tag}:`, error);
            }
            return interaction.editReply(
                `✅ ${entryResult.alreadyJoined ? 'Você já está participando.' : 'Inscrição confirmada!'} Seu código é **${entryResult.code}**.` +
                (dmSent ? ' Também enviei o número por mensagem privada.' : ' ⚠️ Não consegui enviar a DM; confira se suas mensagens privadas estão abertas.'),
            );
        } catch (error) {
            console.error(`Erro ao registrar participante do sorteio ${giveawayId}:`, error);
            return interaction.editReply('❌ Não consegui registrar sua participação. Tente novamente.');
        }
    }

    if (interaction.isButton() && interaction.customId.startsWith('kkjj:giveaway:my-code:')) {
        const giveawayId = interaction.customId.slice('kkjj:giveaway:my-code:'.length);
        if (!interaction.guild || !/^\d{17,20}$/.test(giveawayId)) {
            return interaction.reply({
                content: '❌ Este botão de sorteio é inválido.',
                flags: MessageFlags.Ephemeral,
            });
        }
        const giveaway = giveaways[giveawayId];
        if (!giveaway || giveaway.guildId !== interaction.guild.id) {
            return interaction.reply({
                content: '❌ Não encontrei este sorteio.',
                flags: MessageFlags.Ephemeral,
            });
        }
        const entry = giveaway.entries.find(item => item.userId === interaction.user.id);
        if (!entry) {
            return interaction.reply({
                content: 'ℹ️ Você ainda não está participando deste sorteio. Clique em **Participar do sorteio** primeiro.',
                flags: MessageFlags.Ephemeral,
            });
        }
        return interaction.reply({
            content: `🎟️ Seu código neste sorteio é **${entry.code}**.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    if (interaction.isButton() && interaction.customId.startsWith('kkjj:ticket:transcript:')) {
        const [, , , transcriptId, partCountText] = interaction.customId.split(':');
        const partCount = Number(partCountText);
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(transcriptId || '') ||
            !Number.isInteger(partCount) || partCount < 1 || partCount > 10000) {
            return interaction.reply({ content: '❌ Este botão de histórico é inválido.', flags: MessageFlags.Ephemeral });
        }
        if (partCount === 1) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                return await sendTranscriptPart(interaction, transcriptId, 1, true);
            } catch (error) {
                console.error('Erro ao disponibilizar o histórico do ticket:', error);
                return interaction.editReply({ content: `❌ ${error.message}` });
            }
        }
        return interaction.reply({
            content: 'Escolha qual parte do histórico deseja baixar:',
            components: createTranscriptPartSelector(transcriptId, partCount, 0),
            flags: MessageFlags.Ephemeral,
        });
    }

    if (interaction.isButton() && interaction.customId.startsWith('kkjj:ticket:transcript-page:')) {
        const [, , , transcriptId, partCountText, pageText] = interaction.customId.split(':');
        const partCount = Number(partCountText);
        const page = Number(pageText);
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(transcriptId || '') ||
            !Number.isInteger(partCount) || partCount < 2 || partCount > 10000 ||
            !Number.isInteger(page) || page < 0 || page >= Math.ceil(partCount / 25)) {
            return interaction.update({ content: '❌ Esta navegação do histórico é inválida.', components: [] });
        }
        return interaction.update({
            content: 'Escolha qual parte do histórico deseja baixar:',
            components: createTranscriptPartSelector(transcriptId, partCount, page),
        });
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('kkjj:ticket:transcript-select:')) {
        const [, , , transcriptId, partCountText, pageText] = interaction.customId.split(':');
        const partCount = Number(partCountText);
        const page = Number(pageText);
        const part = Number(interaction.values[0]);
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(transcriptId || '') ||
            !Number.isInteger(partCount) || partCount < 2 || partCount > 10000 ||
            !Number.isInteger(page) || page < 0 || page >= Math.ceil(partCount / 25) ||
            !Number.isInteger(part) || part < page * 25 + 1 || part > Math.min((page + 1) * 25, partCount)) {
            return interaction.update({ content: '❌ A parte selecionada é inválida.', components: [] });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            return await sendTranscriptPart(interaction, transcriptId, part, true);
        } catch (error) {
            console.error('Erro ao disponibilizar parte do histórico do ticket:', error);
            return interaction.editReply({ content: `❌ ${error.message}`, components: [] });
        }
    }

    if (interaction.isButton() && interaction.customId === 'kkjj:verify') {
        if (!interaction.guild || interaction.user.bot) {
            return interaction.reply({ content: '❌ Não foi possível verificar esta conta.', flags: MessageFlags.Ephemeral });
        }

        try {
            const config = await getGuildSettings(interaction.guild.id);
            const verificationRoleIds = [config.verifiedRoleId, config.futureCustomerRoleId].filter(Boolean);
            if (!verificationRoleIds.length) {
                return interaction.reply({ content: '❌ A verificação ainda não foi configurada para este servidor.', flags: MessageFlags.Ephemeral });
            }
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (verificationRoleIds.every(roleId => member.roles.cache.has(roleId)) &&
                (!config.autoRoleId || member.roles.cache.has(config.autoRoleId)) &&
                (!config.pendingRoleId || !member.roles.cache.has(config.pendingRoleId))) {
                return interaction.reply({ content: '✅ Você já está verificado.', flags: MessageFlags.Ephemeral });
            }
            await completeMemberVerification(member, interaction.guild, config);
            return interaction.reply({ content: '✅ Verificação concluída! Seu acesso ao servidor foi liberado.', flags: MessageFlags.Ephemeral });
        } catch (error) {
            console.error(`Erro ao verificar ${interaction.user.tag} no servidor ${interaction.guild.id}:`, error);
            return interaction.reply({ content: '❌ Não consegui concluir a verificação. Avise a equipe do servidor.', flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.isButton() && interaction.customId.startsWith('kkjj:pix:open:')) {
        const [, , , guildId, channelId, userId] = interaction.customId.split(':');
        const replyFlags = { flags: MessageFlags.Ephemeral };
        if (interaction.user.id !== userId) {
            return interaction.reply({ content: '❌ Este formulário Pix foi enviado para outra pessoa.', ...replyFlags });
        }
        if (!interaction.guild || interaction.guild.id !== guildId ||
            interaction.channelId !== channelId ||
            interaction.channel?.type !== ChannelType.GuildText ||
            !interaction.channel.topic?.match(/kkjj-ticket-owner:(\d+)/) ||
            interaction.channel.topic.includes('kkjj-ticket-status:closed') ||
            interaction.channel.topic.includes('kkjj-ticket-status:customer-closed')) {
            return interaction.reply({ content: '❌ Este ticket não está mais aberto.', ...replyFlags });
        }
        if (!await isInteractionTicketStaff(interaction)) {
            return interaction.reply({ content: '❌ Apenas a equipe de atendimento pode enviar a chave Pix.', ...replyFlags });
        }

        const modal = new ModalBuilder()
            .setCustomId(`kkjj:pix:submit:${guildId}:${channelId}:${userId}:${interaction.message.id}`)
            .setTitle('Enviar chave Pix');
        const pixKeyInput = new TextInputBuilder()
            .setCustomId('key')
            .setLabel('Chave Pix')
            .setPlaceholder('Digite ou cole a chave Pix')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(256)
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(pixKeyInput));
        return interaction.showModal(modal);
    }

    if (interaction.isButton() && interaction.customId.startsWith('kkjj:pix:confirm:')) {
        const [, , , guildId, channelId] = interaction.customId.split(':');
        if (!interaction.guild ||
            interaction.guild.id !== guildId ||
            interaction.channelId !== channelId ||
            interaction.channel?.type !== ChannelType.GuildText) {
            return interaction.reply({ content: '❌ Este botão não pertence a este ticket.', flags: MessageFlags.Ephemeral });
        }
        if (!await isInteractionTicketStaff(interaction)) {
            return interaction.reply({ content: '❌ Apenas a equipe de atendimento pode confirmar pagamentos.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const { customer, alreadyConfirmed, auditLogged } = await confirmTicketPayment(
                interaction.guild,
                interaction.channel,
                interaction.user,
            );
            const response = alreadyConfirmed
                ? `✅ <@${customer.id}> já está com o cargo Cliente.`
                : `✅ Pagamento confirmado. <@${customer.id}> recebeu o cargo Cliente e perdeu Futuro Cliente.${auditLogged ? ' A confirmação também foi registrada no histórico do ticket.' : ' ⚠️ Não consegui registrar a confirmação no histórico do ticket.'}`;
            await interaction.editReply({
                content: response,
                allowedMentions: { parse: [] },
            });

            try {
                await interaction.message.edit({
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(interaction.customId)
                                .setLabel('Pagamento confirmado')
                                .setStyle(ButtonStyle.Success)
                                .setEmoji('✅')
                                .setDisabled(true),
                        ),
                    ],
                });
            } catch (error) {
                console.error('Pagamento confirmado, mas não consegui desativar o botão Pix:', error);
            }
        } catch (error) {
            console.error('Erro ao confirmar pagamento pelo botão Pix:', error);
            return interaction.editReply({
                content: `❌ ${error.message}`,
                allowedMentions: { parse: [] },
            });
        }
        return;
    }

    if (
        !interaction.customId?.startsWith('kkjj:ticket:') &&
        !interaction.customId?.startsWith('kkjj:announcement:') &&
        !interaction.customId?.startsWith('kkjj:pix:')
    ) return;
    if (!interaction.guild) {
        return interaction.reply({ content: '❌ Este recurso só pode ser usado dentro do servidor.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('kkjj:pix:submit:')) {
        const [, , , guildId, channelId, userId, buttonMessageId] = interaction.customId.split(':');
        const replyFlags = { flags: MessageFlags.Ephemeral };
        if (interaction.user.id !== userId) {
            return interaction.reply({ content: '❌ Este formulário Pix foi enviado para outra pessoa.', ...replyFlags });
        }
        if (!await isInteractionTicketStaff(interaction)) {
            return interaction.reply({ content: '❌ Apenas a equipe de atendimento pode enviar a chave Pix.', ...replyFlags });
        }

        const pixKey = interaction.fields.getTextInputValue('key').trim();
        const channel = interaction.guild.id === guildId && interaction.channelId === channelId
            ? interaction.channel
            : await interaction.guild.channels.fetch(channelId);
        if (!channel || channel.type !== ChannelType.GuildText ||
            !channel.topic?.match(/kkjj-ticket-owner:(\d+)/) ||
            channel.topic.includes('kkjj-ticket-status:closed') ||
            channel.topic.includes('kkjj-ticket-status:customer-closed')) {
            return interaction.reply({ content: '❌ Este ticket não está mais aberto.', ...replyFlags });
        }
        if (!pixKey) {
            return interaction.reply({ content: '❌ A chave Pix é obrigatória.', ...replyFlags });
        }

        try {
            const pixLogo = new AttachmentBuilder(path.join(__dirname, 'assets', 'pix-logo.png'), {
                name: 'pix-logo.png',
            });
            const paymentEmbed = new EmbedBuilder()
                .setColor('#32BCAD')
                .setAuthor({ name: 'Pagamento via Pix', iconURL: 'attachment://pix-logo.png' })
                .setDescription(
                    `**Chave Pix para pagamento:**\n\`\`\`\n${pixKey.replace(/`/g, "'")}\n\`\`\`\n` +
                    'Após efetuar o pagamento, envie o comprovante aqui no ticket. A equipe confirmará quando verificar o pagamento.',
                );
            const paymentActions = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`kkjj:pix:confirm:${guildId}:${channelId}`)
                    .setLabel('Confirmar pagamento recebido')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅'),
            );
            await channel.send({
                embeds: [paymentEmbed],
                files: [pixLogo],
                components: [paymentActions],
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.error('Erro ao enviar a chave Pix no ticket:', error);
            return interaction.reply({ content: '❌ Não consegui enviar a chave Pix. Verifique se o bot ainda tem acesso ao ticket.', ...replyFlags });
        }
        try {
            const promptMessage = await channel.messages.fetch(buttonMessageId);
            await promptMessage.delete();
        } catch (error) {
            console.error('Não consegui remover o botão do formulário Pix no ticket:', error);
        }
        return interaction.reply({ content: '✅ Chave Pix enviada no ticket.', ...replyFlags });
    }

    if (interaction.isButton() && interaction.customId.startsWith('kkjj:announcement:open:')) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: '❌ Você precisa da permissão Gerenciar servidor para criar avisos.', flags: MessageFlags.Ephemeral });
        }

        const channelId = interaction.customId.split(':')[3];
        const modal = new ModalBuilder()
            .setCustomId(`kkjj:announcement:submit:${channelId}`)
            .setTitle('Criar aviso da KKJJ Store');
        const titleInput = new TextInputBuilder()
            .setCustomId('title')
            .setLabel('Título do aviso')
            .setPlaceholder('Ex.: Novo modpack disponível!')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(true);
        const bodyInput = new TextInputBuilder()
            .setCustomId('body')
            .setLabel('Mensagem')
            .setPlaceholder('Escreva os detalhes do aviso...')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(5)
            .setMaxLength(1500)
            .setRequired(true);
        modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(bodyInput),
        );
        return interaction.showModal(modal);
    }

    if (interaction.isButton() && interaction.customId === 'kkjj:announcement:open') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: '❌ Você precisa da permissão Gerenciar servidor para criar avisos.', flags: MessageFlags.Ephemeral });
        }

        const modal = new ModalBuilder()
            .setCustomId(`kkjj:announcement:submit:${interaction.channelId}:${interaction.message.id}`)
            .setTitle('Criar aviso da KKJJ Store');
        const titleInput = new TextInputBuilder()
            .setCustomId('title')
            .setPlaceholder('Ex.: Novo modpack disponível!')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(true);
        const bodyInput = new TextInputBuilder()
            .setCustomId('body')
            .setPlaceholder('Escreva os detalhes do aviso...')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(5)
            .setMaxLength(1500)
            .setRequired(true);
        const imageUpload = new FileUploadBuilder()
            .setCustomId('image')
            .setMinValues(0)
            .setMaxValues(1)
            .setRequired(false);
        const everyoneCheckbox = new CheckboxBuilder()
            .setCustomId('everyone')
            .setDefault(false);

        modal.addLabelComponents(
            new LabelBuilder().setLabel('Título do aviso').setTextInputComponent(titleInput),
            new LabelBuilder().setLabel('Mensagem').setTextInputComponent(bodyInput),
            new LabelBuilder()
                .setLabel('Imagem ou GIF (opcional)')
                .setDescription('Envie um arquivo do seu dispositivo; aceita GIF, PNG, JPG ou WEBP.')
                .setFileUploadComponent(imageUpload),
            new LabelBuilder()
                .setLabel('Notificar todos')
                .setDescription('Marque para incluir @everyone oculto por spoiler; clique para revelar.')
                .setCheckboxComponent(everyoneCheckbox),
        );
        return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('kkjj:announcement:submit:')) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: '❌ Você precisa da permissão Gerenciar servidor para publicar avisos.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const [, , , channelId, panelMessageId] = interaction.customId.split(':');
            const channel = await interaction.guild.channels.fetch(channelId);
            if (!channel || channel.type !== ChannelType.GuildText) {
                return interaction.editReply('❌ O canal onde o aviso seria publicado não está mais disponível.');
            }

            const title = interaction.fields.getTextInputValue('title').trim();
            const body = interaction.fields.getTextInputValue('body').trim();
            const uploadedImage = interaction.fields.getUploadedFiles('image', false)?.first();
            const mentionEveryone = interaction.fields.getCheckbox('everyone');
            const botPermissions = channel.permissionsFor(interaction.guild.members.me);
            if (mentionEveryone && !botPermissions?.has(PermissionFlagsBits.MentionEveryone)) {
                return interaction.editReply('❌ Para marcar @everyone, conceda ao bot a permissão Mencionar @everyone, ou envie o aviso sem marcar essa opção.');
            }
            const announcement = new EmbedBuilder()
                .setColor('#8B5CF6')
                .setAuthor({ name: '🛒  ＫＫＪＪ 𝖦𝗋𝖺𝗉𝗁𝗂𝖼𝗌 𝖲𝖳𝖮𝖱𝖤' })
                .setTitle(`📢 ${title}`)
                .setDescription(body)
                .setFooter({ text: 'KKJJ Store • Mods gráficos • Maps • Modpacks' })
                .setTimestamp();

            const messageOptions = {
                content: mentionEveryone ? '||@everyone||' : undefined,
                embeds: [announcement],
                allowedMentions: { parse: mentionEveryone ? ['everyone'] : [] },
            };
            if (uploadedImage) {
                const response = await fetch(uploadedImage.url);
                if (!response.ok) {
                    throw new Error(`Não consegui baixar o arquivo anexado (HTTP ${response.status}).`);
                }
                const contentType = response.headers.get('content-type')?.split(';')[0].toLowerCase();
                const imageExtensions = {
                    'image/gif': 'gif',
                    'image/jpeg': 'jpg',
                    'image/png': 'png',
                    'image/webp': 'webp',
                };
                const extension = imageExtensions[contentType];
                if (!extension) {
                    throw new Error('O arquivo precisa ser um GIF, PNG, JPG ou WEBP.');
                }
                const imageBuffer = Buffer.from(await response.arrayBuffer());
                if (imageBuffer.length > 8 * 1024 * 1024) {
                    throw new Error('O arquivo de imagem deve ter até 8 MB.');
                }
                const filename = `aviso-${Date.now()}.${extension}`;
                announcement.setImage(`attachment://${filename}`);
                messageOptions.files = [new AttachmentBuilder(imageBuffer, { name: filename })];
            }

            await channel.send(messageOptions);
            try {
                await channel.messages.delete(panelMessageId);
            } catch (error) {
                console.error('Não consegui remover o painel de criação do aviso:', error);
                return interaction.editReply(`✅ Aviso publicado em <#${channel.id}>, mas não consegui remover o painel. Verifique se o bot tem a permissão Gerenciar mensagens.`);
            }
            return interaction.editReply(`✅ Aviso publicado em <#${channel.id}>. O painel de criação foi removido.`);
        } catch (error) {
            console.error('Erro ao publicar aviso:', error);
            return interaction.editReply('❌ Não consegui publicar o aviso. Verifique se o bot pode enviar mensagens e embeds nesse canal.');
        }
    }

    if (interaction.isButton() && interaction.customId === 'kkjj:ticket:open') {
        const menuCategorias = new StringSelectMenuBuilder()
            .setCustomId('kkjj:ticket:category')
            .setPlaceholder('Selecione o motivo do atendimento')
            .addOptions(
                { label: 'Suporte', description: 'Ajuda com um produto ou pedido', value: 'suporte', emoji: '🛠️' },
                { label: 'Dúvida', description: 'Perguntas sobre a loja e os produtos', value: 'duvida', emoji: '❓' },
                { label: 'Compra', description: 'Produtos, disponibilidade e pagamento Pix', value: 'compra', emoji: '🛒' },
            );
        return interaction.reply({
            content: 'Escolha o assunto para abrir seu atendimento:',
            components: [new ActionRowBuilder().addComponents(menuCategorias)],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (interaction.isButton() && interaction.customId === 'kkjj:ticket:my') {
        const tickets = interaction.guild.channels.cache.filter(channel =>
            channel.type === ChannelType.GuildText &&
            channel.topic?.includes(`kkjj-ticket-owner:${interaction.user.id}`) &&
            !channel.topic.includes('kkjj-ticket-status:customer-closed') &&
            !channel.topic.includes('kkjj-ticket-status:closed')
        );
        return interaction.reply({
            content: tickets.size
                ? `Seus tickets abertos:\n${[...tickets.values()].map(ticket => `<#${ticket.id}>`).join('\n')}`
                : 'Você não tem tickets abertos no momento.',
            flags: MessageFlags.Ephemeral,
        });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'kkjj:ticket:category') {
        const category = interaction.values[0];
        const categoryLabels = { suporte: 'Suporte', duvida: 'Dúvida', compra: 'Compra' };
        if (!categoryLabels[category]) {
            return interaction.reply({ content: '❌ Categoria de atendimento inválida.', flags: MessageFlags.Ephemeral });
        }

        const modal = new ModalBuilder()
            .setCustomId(`kkjj:ticket:modal:create:${category}`)
            .setTitle(`Abrir ticket • ${categoryLabels[category]}`);
        const description = new TextInputBuilder()
            .setCustomId('details')
            .setLabel(category === 'compra' ? 'Qual produto você deseja?' : 'Como podemos ajudar?')
            .setPlaceholder(category === 'compra'
                ? 'Informe o mod gráfico, map ou modpack de interesse'
                : 'Descreva sua dúvida ou o problema')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(5)
            .setMaxLength(1000)
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(description));
        return interaction.showModal(modal);
    }

    if (interaction.isButton() && interaction.customId === 'kkjj:ticket:claim-cancel') {
        return interaction.update({
            content: 'Troca de atendente cancelada.',
            components: [],
            allowedMentions: { parse: [] },
        });
    }

    if (interaction.isButton() && interaction.customId === 'kkjj:ticket:claim') {
        const channel = interaction.channel;
        const ownerId = channel?.topic?.match(/kkjj-ticket-owner:(\d+)/)?.[1];
        if (!channel || channel.type !== ChannelType.GuildText || !ownerId) {
            return interaction.reply({ content: '❌ Este canal não parece ser um ticket válido.', flags: MessageFlags.Ephemeral });
        }
        if (channel.topic.includes('kkjj-ticket-status:closed')) {
            return interaction.reply({ content: '❌ Este ticket já foi encerrado.', flags: MessageFlags.Ephemeral });
        }
        if (!await isInteractionTicketStaff(interaction)) {
            return interaction.reply({ content: '❌ Somente membros com um dos cargos de atendimento configurados podem assumir tickets.', flags: MessageFlags.Ephemeral });
        }

        const currentAssigneeId = channel.topic.match(/(?:^|\s\|\s)kkjj-ticket-assignee:(\d+)/)?.[1];
        if (currentAssigneeId === interaction.user.id) {
            return interaction.reply({ content: '✅ Você já está atendendo este ticket.', flags: MessageFlags.Ephemeral });
        }
        if (currentAssigneeId) {
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`kkjj:ticket:claim-confirm:${interaction.message.id}:${interaction.user.id}:${currentAssigneeId}`)
                    .setLabel('Confirmar troca')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('kkjj:ticket:claim-cancel')
                    .setLabel('Cancelar')
                    .setStyle(ButtonStyle.Secondary),
            );
            return interaction.reply({
                content: `Este ticket já está com <@${currentAssigneeId}>. Deseja assumir o atendimento no lugar dessa pessoa?`,
                components: [confirmRow],
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }
        if (ticketClaimLocks.has(channel.id)) {
            return interaction.reply({ content: '⏳ Alguém está assumindo este ticket. Tente novamente em instantes.', flags: MessageFlags.Ephemeral });
        }

        ticketClaimLocks.add(channel.id);
        try {
            const assignee = await interaction.guild.members.fetch(interaction.user.id);
            await updateTicketAssignee(channel, interaction.message, assignee);
            return interaction.reply({
                content: `✅ Você assumiu o atendimento deste ticket.`,
                allowedMentions: { parse: [] },
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            console.error('Erro ao atribuir atendente ao ticket:', error);
            return interaction.reply({ content: '❌ Não consegui atualizar o atendente. Tente novamente ou avise um administrador.', flags: MessageFlags.Ephemeral });
        } finally {
            ticketClaimLocks.delete(channel.id);
        }
    }

    if (interaction.isButton() && interaction.customId.startsWith('kkjj:ticket:claim-confirm:')) {
        const [, , , ticketMessageId, requesterId, previousAssigneeId] = interaction.customId.split(':');
        const channel = interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText ||
            channel.id !== interaction.channelId ||
            interaction.user.id !== requesterId ||
            !channel.topic?.match(/kkjj-ticket-owner:(\d+)/) ||
            channel.topic.includes('kkjj-ticket-status:closed')) {
            return interaction.update({ content: '❌ Esta confirmação não corresponde a um ticket ativo ou a quem solicitou a troca.', components: [] });
        }
        if (!await isInteractionTicketStaff(interaction)) {
            return interaction.update({ content: '❌ Somente a equipe de atendimento pode trocar o atendente.', components: [] });
        }
        if (ticketClaimLocks.has(channel.id)) {
            return interaction.update({ content: '⏳ Uma alteração de atendente já está em andamento. Tente novamente.', components: [] });
        }

        await interaction.deferUpdate();
        ticketClaimLocks.add(channel.id);
        try {
            const currentAssigneeId = channel.topic.match(/(?:^|\s\|\s)kkjj-ticket-assignee:(\d+)/)?.[1];
            if (currentAssigneeId !== previousAssigneeId) {
                return interaction.editReply({ content: '❌ O atendente já foi alterado. Clique novamente em “Atender ticket” para solicitar uma nova troca.', components: [] });
            }
            const ticketMessage = await channel.messages.fetch(ticketMessageId);
            const assignee = await interaction.guild.members.fetch(interaction.user.id);
            await updateTicketAssignee(channel, ticketMessage, assignee);
            return interaction.editReply({
                content: '✅ Você assumiu o atendimento deste ticket.',
                components: [],
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.error('Erro ao trocar o atendente do ticket:', error);
            return interaction.editReply({ content: '❌ Não consegui trocar o atendente. Tente novamente ou avise um administrador.', components: [] });
        } finally {
            ticketClaimLocks.delete(channel.id);
        }
    }

    if (interaction.isButton() && interaction.customId === 'kkjj:ticket:call-staff') {
        const channel = interaction.channel;
        const ownerId = channel?.topic?.match(/kkjj-ticket-owner:(\d+)/)?.[1];
        if (!channel || channel.type !== ChannelType.GuildText || !ownerId) {
            return interaction.reply({ content: '❌ Este canal não parece ser um ticket válido.', flags: MessageFlags.Ephemeral });
        }
        if (interaction.user.id !== ownerId) {
            return interaction.reply({ content: '❌ Só quem abriu o ticket pode chamar a equipe de atendimento.', flags: MessageFlags.Ephemeral });
        }
        if (channel.topic.includes('kkjj-ticket-status:customer-closed') ||
            channel.topic.includes('kkjj-ticket-status:closed')) {
            return interaction.reply({ content: 'Este ticket está fechado para você.', flags: MessageFlags.Ephemeral });
        }

        const previousCall = ticketCallCooldowns.get(channel.id) || 0;
        const remaining = 5 * 60 * 1000 - (Date.now() - previousCall);
        if (remaining > 0) {
            return interaction.reply({
                content: `A equipe já foi chamada recentemente. Tente novamente em ${Math.ceil(remaining / 60000)} minuto(s).`,
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            const vendedores = await findTicketStaff(interaction.guild);
            await channel.send({
                content: `📣 ${vendedores.map(role => `<@&${role.id}>`).join(' ')} — <@${ownerId}> está solicitando atendimento neste ticket.`,
                allowedMentions: { users: [ownerId], roles: vendedores.map(role => role.id) },
            });
            ticketCallCooldowns.set(channel.id, Date.now());
            return interaction.reply({ content: '✅ A equipe de atendimento foi chamada.', flags: MessageFlags.Ephemeral });
        } catch (error) {
            console.error('Erro ao chamar a equipe de atendimento no ticket:', error);
            return interaction.reply({ content: `❌ Não consegui mencionar a equipe de atendimento. ${error.message}`, flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.isButton() && ['kkjj:ticket:close', 'kkjj:ticket:finish'].includes(interaction.customId)) {
        const channel = interaction.channel;
        const ownerId = channel?.topic?.match(/kkjj-ticket-owner:(\d+)/)?.[1];
        if (!channel || channel.type !== ChannelType.GuildText || !ownerId) {
            return interaction.reply({ content: '❌ Este canal não parece ser um ticket válido.', flags: MessageFlags.Ephemeral });
        }
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const seller = await isTicketStaff(member);
        const isOwner = interaction.user.id === ownerId;

        if (interaction.customId === 'kkjj:ticket:finish' && !seller) {
            return interaction.reply({ content: '❌ Somente a equipe de atendimento pode encerrar definitivamente o ticket.', flags: MessageFlags.Ephemeral });
        }
        if (interaction.customId === 'kkjj:ticket:close' && !isOwner) {
            return interaction.reply({ content: '❌ Somente quem abriu o ticket pode solicitar a saída. A equipe de atendimento pode encerrar pelo botão “Encerrar ticket”.', flags: MessageFlags.Ephemeral });
        }
        if (channel.topic.includes('kkjj-ticket-status:closed')) {
            return interaction.reply({ content: 'Este ticket já foi encerrado pela equipe.', flags: MessageFlags.Ephemeral });
        }

        const modalId = interaction.customId === 'kkjj:ticket:finish'
            ? `kkjj:ticket:modal:finish:${channel.id}`
            : `kkjj:ticket:modal:customer-close:${channel.id}`;
        const modal = new ModalBuilder()
            .setCustomId(modalId)
            .setTitle(interaction.customId === 'kkjj:ticket:finish' ? 'Encerrar ticket' : 'Solicitar encerramento');
        const motivo = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel(interaction.customId === 'kkjj:ticket:finish' ? 'Motivo do encerramento' : 'Por que deseja sair do ticket?')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Descreva o motivo...')
            .setMinLength(5)
            .setMaxLength(500)
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(motivo));
        return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('kkjj:ticket:modal:')) {
        const [, , , action, actionTarget] = interaction.customId.split(':');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            if (action === 'create') {
                const categories = {
                    suporte: {
                        label: 'SUPORTE',
                        title: 'Como podemos ajudar?',
                    },
                    duvida: {
                        label: 'DÚVIDAS',
                        title: 'Qual é a sua dúvida?',
                    },
                    compra: {
                        label: 'COMPRAS',
                        title: 'Qual produto você deseja?',
                    },
                };
                const category = categories[actionTarget];
                if (!category) {
                    return interaction.editReply('❌ Categoria de atendimento inválida.');
                }

                const existingTicket = interaction.guild.channels.cache.find(channel =>
                    channel.type === ChannelType.GuildText &&
                    channel.topic?.includes(`kkjj-ticket-owner:${interaction.user.id}`) &&
                    channel.topic.match(/(?:^|\s\|\s)categoria:([^ |]+)/)?.[1] === actionTarget &&
                    !channel.topic.includes('kkjj-ticket-status:customer-closed') &&
                    !channel.topic.includes('kkjj-ticket-status:closed')
                );
                if (existingTicket) {
                    return interaction.editReply(`Você já tem um ticket aberto nesta categoria: <#${existingTicket.id}>. Você ainda pode abrir tickets nas outras categorias.`);
                }

                const logChannel = await findTicketLogChannel(interaction.guild, 'open');
                if (!logChannel) {
                    return interaction.editReply('❌ O canal de logs de abertura não está configurado ou o bot não consegue acessá-lo. Execute `!logticketopen` no canal desejado (ou `!logtickets` para usar o mesmo canal para tudo) e confira as permissões.');
                }
                const vendedores = await findTicketStaff(interaction.guild);
                const guildConfig = await getGuildSettings(interaction.guild.id);
                const details = interaction.fields.getTextInputValue('details').trim();
                const username = interaction.user.username
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, '-')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, '')
                    .slice(0, 32) || 'cliente';
                const categoryConfigFields = {
                    compra: 'ticketPurchaseCategoryId',
                    suporte: 'ticketSupportCategoryId',
                    duvida: 'ticketQuestionCategoryId',
                };
                const configuredCategoryId = guildConfig[categoryConfigFields[actionTarget]];
                let parent = interaction.channel?.type === ChannelType.GuildText
                    ? interaction.channel.parentId
                    : null;
                if (configuredCategoryId) {
                    const configuredCategory = await interaction.guild.channels.fetch(configuredCategoryId);
                    if (!configuredCategory || configuredCategory.type !== ChannelType.GuildCategory) {
                        throw new Error(`A categoria configurada para ${category.label.toLowerCase()} não existe mais. Atualize-a no painel de controle.`);
                    }
                    parent = configuredCategory.id;
                }
                const channel = await interaction.guild.channels.create({
                    name: `ticket-${actionTarget}-${username}`.slice(0, 100),
                    type: ChannelType.GuildText,
                    topic: `kkjj-ticket-owner:${interaction.user.id} | categoria:${actionTarget} | kkjj-ticket-status:open`,
                    parent,
                    permissionOverwrites: [
                        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                        {
                            id: interaction.user.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory,
                                PermissionFlagsBits.AttachFiles,
                            ],
                        },
                        {
                            id: client.user.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory,
                                PermissionFlagsBits.ManageChannels,
                            ],
                        },
                        ...vendedores.map(role => ({
                            id: role.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory,
                            ],
                        })),
                    ],
                    reason: `Ticket de ${category.label.toLowerCase()} aberto por ${interaction.user.tag}`,
                });

                const welcomeEmbed = new EmbedBuilder()
                    .setColor('#8B5CF6')
                    .setAuthor({ name: '🛒  ＫＫＪＪ 𝖦𝗋𝖺𝗉𝗁𝗂𝖼𝗌 𝖲𝖳𝖮𝖱𝖤' })
                    .setTitle(`ATENDIMENTO  |  ${category.label}`)
                    .setDescription(
                        `Olá, <@${interaction.user.id}>! 👋\n\n` +
                        `${details}\n\n` +
                        (actionTarget === 'compra'
                            ? 'Nossa equipe cuidará do seu pedido por aqui. O atendente responsável aparecerá nesta mensagem assim que assumir o ticket.\n\nO pagamento é feito via **Pix**; aguarde as instruções antes de pagar.\n\n'
                            : '') +
                        'Nossa equipe responderá assim que possível.\n🔒 Nunca compartilhe senhas ou códigos de acesso.'
                    )
                    .addFields({ name: 'Atendente', value: 'Aguardando alguém da equipe assumir este ticket.' })
                    .setFooter({ text: 'KKJJ Store • Atendimento privado' })
                    .setTimestamp();
                const ticketButtons = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('kkjj:ticket:claim')
                        .setLabel('Atender ticket')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('🙋'),
                    new ButtonBuilder()
                        .setCustomId('kkjj:ticket:close')
                        .setLabel('Fechar para mim')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('🔒'),
                    new ButtonBuilder()
                        .setCustomId('kkjj:ticket:finish')
                        .setLabel('Encerrar ticket')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('✅'),
                    new ButtonBuilder()
                        .setCustomId('kkjj:ticket:call-staff')
                        .setLabel('Chamar equipe')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('📣'),
                );
                const mentionedRoles = vendedores.map(role => role.id);
                await channel.send({
                    content: `<@${interaction.user.id}> ${vendedores.map(role => `<@&${role.id}>`).join(' ')}`,
                    embeds: [welcomeEmbed],
                    components: [ticketButtons],
                    allowedMentions: { users: [interaction.user.id], roles: mentionedRoles },
                });

                try {
                    await logTicketOpened(channel, interaction.user, vendedores, category.label);
                } catch (logError) {
                    console.error('Erro ao registrar a abertura do ticket:', logError);
                    return interaction.editReply(`✅ Seu ticket foi criado: <#${channel.id}>\n⚠️ Não consegui enviar o aviso ao canal de logs. Verifique as permissões desse canal.`);
                }
                return interaction.editReply(`✅ Seu ticket foi criado: <#${channel.id}>. A equipe de atendimento foi mencionada.`);
            }

            const channelId = actionTarget;
            const channel = await interaction.guild.channels.fetch(channelId);
            const ownerId = channel?.topic?.match(/kkjj-ticket-owner:(\d+)/)?.[1];
            if (!channel || channel.type !== ChannelType.GuildText || !ownerId) {
                return interaction.editReply('❌ Não consegui encontrar o ticket.');
            }
            if (channel.topic.includes('kkjj-ticket-status:closed')) {
                return interaction.editReply('Este ticket já foi encerrado pela equipe.');
            }

            const reason = interaction.fields.getTextInputValue('reason').trim();
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const seller = await isTicketStaff(member);
            const isOwner = interaction.user.id === ownerId;
            const finalClose = action === 'finish';

            if (finalClose && !seller) {
                return interaction.editReply('❌ Somente a equipe de atendimento pode encerrar definitivamente o ticket.');
            }
            if (!finalClose && !isOwner) {
                return interaction.editReply('❌ Somente quem abriu o ticket pode solicitar o encerramento.');
            }

            if (finalClose) {
                await channel.send({
                    content: `✅ Ticket encerrado pela equipe. Motivo: ${reason}\nEste canal será excluído em 10 segundos; o histórico completo será enviado aos logs.`,
                    allowedMentions: { parse: [] },
                });
                await createTicketTranscript(channel, {
                    action: 'encerrado pela equipe',
                    actor: interaction.user,
                    reason,
                });
                await channel.setTopic(channel.topic.replace(/kkjj-ticket-status:[^ |]+/, 'kkjj-ticket-status:closed'));
                await channel.permissionOverwrites.edit(ownerId, {
                    ViewChannel: false,
                    SendMessages: false,
                    ReadMessageHistory: false,
                });
                let directMessageSent = true;
                try {
                    const ticketCategory = channel.topic.match(/(?:^|\s\|\s)categoria:([^ |]+)/)?.[1];
                    const owner = await client.users.fetch(ownerId);
                    await owner.send(
                        ticketCategory === 'compra'
                            ? '✅ Seu ticket de compra foi encerrado. Agradecemos por comprar na KKJJ Store! Se precisar de ajuda novamente, estaremos à disposição.'
                            : '✅ Seu ticket foi encerrado. Esperamos que sua dúvida tenha sido esclarecida ou que nossa equipe tenha conseguido ajudar. Se precisar de mais alguma coisa, estamos à disposição!',
                    );
                } catch (error) {
                    directMessageSent = false;
                    console.error('Não consegui enviar a mensagem privada de encerramento do ticket:', error);
                }
                await interaction.editReply(
                    `✅ Ticket encerrado. O histórico foi enviado aos logs; o canal será excluído em 10 segundos.` +
                    (directMessageSent ? '' : '\n⚠️ Não consegui enviar a mensagem privada ao cliente.'),
                );
                await new Promise(resolve => setTimeout(resolve, 10_000));
                await channel.delete(`Ticket encerrado por ${interaction.user.tag}; transcrição salva no canal de logs.`);
                return;
            }

            await createTicketTranscript(channel, {
                action: 'cliente saiu do ticket; atendimento permanece aberto para a equipe',
                actor: interaction.user,
                reason,
            });
            await channel.permissionOverwrites.edit(ownerId, {
                ViewChannel: false,
                SendMessages: false,
                ReadMessageHistory: false,
            });
            await channel.setName(`solicitado-${channel.name.replace(/^(ticket-|encerrado-)/, '')}`.slice(0, 100));
            await channel.setTopic(channel.topic.replace(/kkjj-ticket-status:[^ |]+/, 'kkjj-ticket-status:customer-closed'));
            await channel.send({
                content: `🔒 O cliente saiu do ticket. Ele permanece aberto para a equipe. Motivo: ${reason}`,
                allowedMentions: { parse: [] },
            });
            return interaction.editReply('✅ Você saiu do ticket. Ele continua disponível para a equipe e o histórico foi registrado.');
        } catch (error) {
            console.error('Erro ao processar a ação do ticket:', error);
            return interaction.editReply(
                error.message.toLowerCase().includes('canal de logs de encerramento')
                    ? '❌ Configure primeiro o canal de logs de encerramento com `!logticketclose` (ou `!logtickets` para usar o mesmo canal para tudo). O ticket não foi encerrado.'
                    : error.message.includes('cargo de atendimento')
                        ? `❌ ${error.message}`
                    : error.message.includes('categoria configurada para')
                        ? `❌ ${error.message}`
                    : '❌ Não consegui concluir a ação. Verifique as permissões do bot e do canal de logs.',
            );
        }
    }
});

client.once('clientReady', () => {
    startDashboard(client).catch(error => {
        console.error('Erro ao iniciar o painel web local:', error);
        process.exitCode = 1;
    });
});

client.login(process.env.DISCORD_TOKEN);
