const express = require('express');
const crypto = require('node:crypto');
const { lookup } = require('node:dns/promises');
const fs = require('node:fs/promises');
const { isIP } = require('node:net');
const path = require('node:path');
const util = require('node:util');
const {
    AttachmentBuilder,
    ChannelType,
    EmbedBuilder,
    PermissionFlagsBits,
} = require('discord.js');

const SETTINGS_PATH = path.join(__dirname, 'dashboard-settings.json');
const TICKET_SETTINGS_PATH = path.join(__dirname, 'ticket-settings.json');
const GIVEAWAYS_PATH = path.join(__dirname, 'giveaways.json');
const PUBLIC_PATH = path.join(__dirname, 'dashboard');
const DEFAULT_WELCOME_TITLE = '{user.name} chegou!';
const DEFAULT_WELCOME_MESSAGE = 'Olá {user}, seja bem-vindo(a) ao **{guild}**!\nVocê é a pessoa nº **{memberCount}** a chegar. Confira os {productsChannel} e leia os {termsChannel}.';
const DEFAULT_WELCOME_FOOTER = '{server} • Todos os direitos reservados.';
const LEGACY_WELCOME_MESSAGE = 'Boas-vindas, {user}, ao servidor **{server}**! Você é nosso membro nº {memberCount}.';
const PREVIOUS_DEFAULT_WELCOME_MESSAGE = 'Seja bem-vindo(a) a **{server}**!';
const DEFAULT_STORE_SETTINGS = {
    storeTitle: '🛒 KKJJ Store - Loja Oficial',
    storeDescription: 'Seja bem-vindo à **KKJJ Store**! Encontre mods gráficos, mapas e modpacks para seus jogos.',
    storeField1Title: '🎨 Mods gráficos',
    storeField1Value: 'Mods visuais e de textura para transformar seus jogos.',
    storeField2Title: '🗺️ Maps',
    storeField2Value: 'Mapas personalizados para explorar novas experiências.',
    storeField3Title: '🧩 Modpacks',
    storeField3Value: 'Pacotes de mods selecionados e prontos para jogar.',
    storeField4Title: '💬 Compras e suporte',
    storeField4Value: 'Confira os canais da loja ou abra um ticket para tirar dúvidas.',
    storeImageUrl: 'https://i.imgur.com/wSTFkRM.png',
    storeFooter: 'KKJJ Store • Todos os direitos reservados',
    termsAuthor: '🛒  ＫＫＪＪ 𝖦𝗋𝖺𝗉𝗁𝗂𝖼𝗌 𝖲𝖳𝖮𝖱𝖤',
    termsTitle: '📜 Termos e Condições de Compra',
    termsDescription: 'Leia estas condições antes de comprar. Ao realizar um pedido, você declara que leu e compreendeu os termos abaixo.',
    termsField1Title: '01  •  Compras e entrega',
    termsField1Value: 'Confira o produto, o preço e as informações da oferta antes de pagar. Após a confirmação do pagamento, o pedido será enviado por mensagem direta (DM). Mantenha as DMs abertas para recebê-lo.',
    termsField2Title: '02  •  Pagamento',
    termsField2Value: 'Aceitamos **somente Pix**. O pedido será confirmado após a identificação do pagamento. Pagamentos suspeitos, fraudulentos ou realizados por meios não autorizados poderão ser recusados ou cancelados. Nunca compartilhe senhas ou dados pessoais em canais não oficiais.',
    termsField3Title: '03  •  Reembolso e cancelamento',
    termsField3Value: '• A ＫＫＪＪ 𝖦𝗋𝖺𝗉𝗁𝗂𝖼𝗌 𝖲𝖳𝖮𝖱𝖤 não oferece cancelamento ou reembolsos de produtos adquiridos.',
    termsField4Title: '04  •  Produtos digitais',
    termsField4Value: 'Mantenha suas informações de acesso em segurança. É proibido compartilhar, revender, duplicar ou distribuir os produtos adquiridos sem autorização.',
    termsField5Title: '05  •  Suporte',
    termsField5Value: 'Para dúvidas, problemas ou assistência, procure os canais oficiais da loja. Podemos solicitar informações relacionadas ao pedido e ao pagamento para ajudar no atendimento.',
    termsField6Title: '06  •  Conduta',
    termsField6Value: 'Fraudes, comprovantes falsos, contestações indevidas de pagamento ou tentativas de prejudicar a loja poderão resultar nas medidas cabíveis.',
    termsField7Title: '07  •  Alterações',
    termsField7Value: 'Estes termos poderão ser atualizados quando necessário. A versão vigente será publicada neste canal.',
    termsImportantTitle: 'Importante',
    termsImportantValue: 'Ao comprar, você confirma que está ciente destas condições. Os direitos garantidos pela legislação aplicável permanecem válidos.',
    termsFooter: 'ＫＫＪＪ 𝖦𝗋𝖺𝗉𝗁𝗂𝖼𝗌 𝖲𝖳𝖮𝖱𝖤  •  Qualidade, confiança e segurança nas suas compras',
};
const PRODUCTS_CHANNEL_ID = '1557796354539913306';
const TERMS_CHANNEL_ID = '1557803942510075924';
const MAX_WELCOME_GIF_BYTES = 8 * 1024 * 1024;
let settingsWriteQueue = Promise.resolve();
let ticketSettingsWriteQueue = Promise.resolve();
const errorLogs = [];
let maxErrorLogs = 250;
const authSessions = new Map();
const pendingOAuthStates = new Map();
const passwordGates = new Map();
const passwordAttempts = new Map();

async function readDashboardSettings() {
    try {
        return JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

async function getGuildSettings(guildId) {
    const settings = await readDashboardSettings();
    return settings[guildId] || {};
}

async function readTicketSettings() {
    try {
        return JSON.parse(await fs.readFile(TICKET_SETTINGS_PATH, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

function getTicketLogChannels(settings, guildId) {
    const configured = settings[guildId];
    if (typeof configured === 'string') {
        return { open: configured, close: configured, join: '', leave: '' };
    }
    return {
        open: configured?.open || '',
        close: configured?.close || '',
        join: configured?.join || '',
        leave: configured?.leave || '',
    };
}

function saveTicketLogChannels(guildId, channelIds) {
    const save = ticketSettingsWriteQueue.then(async () => {
        const settings = await readTicketSettings();
        const channels = {
            open: channelIds.open || null,
            close: channelIds.close || null,
            join: channelIds.join || null,
            leave: channelIds.leave || null,
        };
        if (Object.values(channels).some(Boolean)) settings[guildId] = channels;
        else delete settings[guildId];
        const temporaryPath = `${TICKET_SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporaryPath, JSON.stringify(settings, null, 2), 'utf8');
        await fs.rename(temporaryPath, TICKET_SETTINGS_PATH);
    });
    ticketSettingsWriteQueue = save.catch(() => {});
    return save;
}

function saveGuildSettings(guildId, guildSettings) {
    const save = settingsWriteQueue.then(async () => {
        const settings = await readDashboardSettings();
        settings[guildId] = guildSettings;
        const temporaryPath = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporaryPath, JSON.stringify(settings, null, 2), 'utf8');
        await fs.rename(temporaryPath, SETTINGS_PATH);
    });
    settingsWriteQueue = save.catch(() => {});
    return save;
}

function saveDashboardPreferences(preferences) {
    const save = settingsWriteQueue.then(async () => {
        const settings = await readDashboardSettings();
        settings._dashboardPreferences = preferences;
        const temporaryPath = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporaryPath, JSON.stringify(settings, null, 2), 'utf8');
        await fs.rename(temporaryPath, SETTINGS_PATH);
    });
    settingsWriteQueue = save.catch(() => {});
    return save;
}

function sanitizeLogText(value) {
    return value
        .replace(/\b(token|api[_-]?key|authorization|password|secret)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1$2[REDACTED]')
        .replace(/\bgsk_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
        .replace(/\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}\b/g, '[REDACTED]')
        .replace(/Bot\s+[A-Za-z0-9._-]{20,}/g, 'Bot [REDACTED]')
        .slice(0, 6000);
}

function appendErrorLog(args) {
    const message = sanitizeLogText(args.map(value => {
        if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
        if (typeof value === 'string') return value;
        return util.inspect(value, { depth: 3, maxArrayLength: 30, maxStringLength: 1000 });
    }).join(' '));
    errorLogs.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), message });
    if (errorLogs.length > maxErrorLogs) errorLogs.length = maxErrorLogs;
}

function installErrorCapture() {
    const originalConsoleError = console.error.bind(console);
    console.error = (...args) => {
        try {
            appendErrorLog(args);
        } catch (error) {
            originalConsoleError('Não consegui guardar a entrada no painel de erros:', error);
        }
        originalConsoleError(...args);
    };
}

function isAssignableRole(role, botMember) {
    return !role.managed &&
        role.id !== role.guild.id &&
        role.position < botMember.roles.highest.position;
}

function requireSameOrigin(publicOrigin) {
    return (req, res, next) => {
        const origin = req.get('origin');
        if (!origin || origin !== publicOrigin) {
            return res.status(403).json({ error: 'Acesso permitido somente pela origem configurada.' });
        }
        return next();
    };
}

function getCookie(req, name) {
    const cookies = req.headers.cookie?.split(';') || [];
    const entry = cookies.find(cookie => cookie.trim().startsWith(`${name}=`));
    return entry ? entry.trim().slice(name.length + 1) : '';
}

function signSessionId(sessionId, secret) {
    return crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
}

function getAuthenticatedSession(req, secret) {
    const [sessionId, signature] = getCookie(req, 'kkjj_session').split('.');
    if (!sessionId || !signature) return null;
    const expectedBuffer = Buffer.from(signSessionId(sessionId, secret));
    const suppliedBuffer = Buffer.from(signature);
    if (suppliedBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;
    const session = authSessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
        authSessions.delete(sessionId);
        return null;
    }
    return session;
}

function removeAuthenticatedSession(session) {
    for (const [sessionId, candidate] of authSessions) {
        if (candidate === session) {
            authSessions.delete(sessionId);
            return;
        }
    }
}

function setCookie(res, name, value, { secure, maxAge }) {
    res.append('Set-Cookie',
        `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function isValidPasswordHash(encodedHash) {
    const parts = encodedHash.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256' ||
        !/^\d+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2]) ||
        !/^[A-Za-z0-9_-]+$/.test(parts[3])) return false;
    const iterations = Number(parts[1]);
    return Number.isInteger(iterations) && iterations >= 100000 && iterations <= 1000000 &&
        Buffer.from(parts[2], 'base64url').length >= 16 &&
        Buffer.from(parts[3], 'base64url').length === 32;
}

function verifyDashboardPassword(password, encodedHash) {
    if (typeof password !== 'string' || !isValidPasswordHash(encodedHash)) return false;
    const [, iterationsText, saltText, digestText] = encodedHash.split('$');
    const expected = Buffer.from(digestText, 'base64url');
    const actual = crypto.pbkdf2Sync(
        password,
        Buffer.from(saltText, 'base64url'),
        Number(iterationsText),
        expected.length,
        'sha256',
    );
    return crypto.timingSafeEqual(actual, expected);
}

function getDashboardConfig(client) {
    const clientId = process.env.DISCORD_OAUTH_CLIENT_ID ||
        process.env.DISCORD_CLIENT_ID ||
        client.application?.id ||
        '';
    const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || (process.env.DASHBOARD_PUBLIC_URL ? 8080 : 3000));
    const redirectUri = process.env.DISCORD_OAUTH_REDIRECT_URI ||
        `http://127.0.0.1:${port}/auth/callback`;
    let parsedRedirect;
    try {
        parsedRedirect = new URL(redirectUri);
    } catch {
        parsedRedirect = null;
    }
    const publicUrlValue = process.env.DASHBOARD_PUBLIC_URL || parsedRedirect?.origin || `http://127.0.0.1:${port}`;
    let publicOrigin = '';
    try {
        publicOrigin = new URL(publicUrlValue).origin;
    } catch {
        publicOrigin = '';
    }
    const ownerId = process.env.DASHBOARD_OWNER_DISCORD_ID || '';
    const ownerUsername = (process.env.DASHBOARD_OWNER_USERNAME || 'baefed').toLowerCase();
    const coIds = (process.env.DASHBOARD_CO_DISCORD_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    const coUsernames = (process.env.DASHBOARD_CO_DISCORD_USERNAMES || 'baefed')
        .split(',')
        .map(username => username.trim().toLowerCase())
        .filter(Boolean);
    const passwordHash = process.env.DASHBOARD_PASSWORD_HASH || '';
    const host = process.env.DASHBOARD_HOST || (process.env.DASHBOARD_PUBLIC_URL ? '0.0.0.0' : '127.0.0.1');
    const missing = [];
    if (!clientId) missing.push('DISCORD_OAUTH_CLIENT_ID');
    if (!process.env.DISCORD_OAUTH_CLIENT_SECRET) missing.push('DISCORD_OAUTH_CLIENT_SECRET');
    if (!isValidPasswordHash(passwordHash)) missing.push('DASHBOARD_PASSWORD_HASH');
    if (!parsedRedirect ||
        (parsedRedirect.protocol !== 'https:' &&
            parsedRedirect.hostname !== '127.0.0.1' &&
            parsedRedirect.hostname !== 'localhost')) {
        missing.push('DISCORD_OAUTH_REDIRECT_URI válido');
    }
    if (!publicOrigin) missing.push('DASHBOARD_PUBLIC_URL válido');
    if (parsedRedirect && publicOrigin && parsedRedirect.origin !== publicOrigin) {
        missing.push('DISCORD_OAUTH_REDIRECT_URI na mesma origem de DASHBOARD_PUBLIC_URL');
    }
    if (host !== '127.0.0.1' && host !== 'localhost' && !publicOrigin.startsWith('https://')) {
        missing.push('DASHBOARD_PUBLIC_URL com HTTPS para acesso externo');
    }
    return {
        clientId,
        clientSecret: process.env.DISCORD_OAUTH_CLIENT_SECRET || '',
        redirectUri,
        publicOrigin,
        secureCookie: publicOrigin.startsWith('https://'),
        sessionSecret: process.env.DASHBOARD_SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
        ownerId,
        ownerUsername,
        coIds,
        coUsernames,
        passwordHash,
        configured: missing.length === 0,
        missing,
    };
}

function resolveDashboardRole(user, config) {
    if ((config.ownerId && user.id === config.ownerId) ||
        (!config.ownerId && user.username?.toLowerCase() === config.ownerUsername)) return 'owner';
    if (config.coIds.includes(user.id) || config.coUsernames.includes(user.username?.toLowerCase())) return 'co';
    return null;
}

function requireDashboardRole(...allowedRoles) {
    return (req, res, next) => {
        const role = req.dashboardUser?.role;
        const isCoAllowed = role === 'co' && allowedRoles.includes('owner');
        if (!allowedRoles.includes(role) && !isCoAllowed) {
            return res.status(403).json({ error: 'Sua função não tem permissão para esta ação.' });
        }
        return next();
    };
}

function buildVerificationMessage(config) {
    const verificationRoles = [config.verifiedRoleId, config.futureCustomerRoleId]
        .filter(Boolean)
        .map(roleId => `<@&${roleId}>`);
    const roleDescription = verificationRoles.length
        ? `\n\nAo verificar, você receberá ${verificationRoles.join(' e ')}.`
        : '';
    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('VERIFIQUE-SE')
        .setDescription(`Reaja com ✅ para desbloquear o servidor.${roleDescription}`);
    return {
        embeds: [embed],
        allowedMentions: { parse: [] },
    };
}

function isPublicIpAddress(address) {
    const version = isIP(address);
    if (version === 4) {
        const octets = address.split('.').map(Number);
        const [first, second] = octets;
        return first !== 0 && first !== 10 && first !== 127 && first < 224 &&
            !(first === 100 && second >= 64 && second <= 127) &&
            !(first === 169 && second === 254) &&
            !(first === 172 && second >= 16 && second <= 31) &&
            !(first === 192 && second === 168) &&
            !(first === 198 && (second === 18 || second === 19));
    }
    if (version === 6) {
        const normalized = address.toLowerCase();
        if (normalized.startsWith('::ffff:')) {
            const mappedIpv4 = normalized.slice(7);
            return isIP(mappedIpv4) === 4 && isPublicIpAddress(mappedIpv4);
        }
        return /^[23]/.test(normalized) && !normalized.startsWith('2001:db8:');
    }
    return false;
}

async function downloadWelcomeGif(gifUrl) {
    if (!gifUrl) return null;
    let parsedUrl;
    try {
        parsedUrl = new URL(gifUrl);
    } catch {
        throw new Error('O link do GIF de boas-vindas não é uma URL válida.');
    }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
        throw new Error('O GIF precisa usar um link HTTPS público.');
    }

    const fetchGifFile = async url => {
        const addresses = await lookup(url.hostname, { all: true });
        if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
            throw new Error('O endereço do GIF precisa estar hospedado em um servidor público.');
        }

        const response = await fetch(url, {
            headers: { Accept: 'image/gif, */*;q=0.1' },
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Não consegui baixar o GIF (HTTP ${response.status}).`);
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_WELCOME_GIF_BYTES) {
            throw new Error('O GIF precisa ter no máximo 8 MB.');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Não consegui ler o arquivo GIF recebido.');
        const chunks = [];
        let totalBytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_WELCOME_GIF_BYTES) {
                await reader.cancel();
                throw new Error('O GIF precisa ter no máximo 8 MB.');
            }
            chunks.push(Buffer.from(value));
        }
        if (!totalBytes) throw new Error('O arquivo GIF está vazio.');
        const gif = Buffer.concat(chunks, totalBytes);
        const signature = gif.subarray(0, 6).toString('ascii');
        if (signature !== 'GIF87a' && signature !== 'GIF89a') {
            throw new Error('O link informado não contém um arquivo GIF válido.');
        }
        return gif;
    };

    try {
        return await fetchGifFile(parsedUrl);
    } catch (error) {
        if (parsedUrl.hostname !== 'media.discordapp.net') throw error;
        const cdnUrl = new URL(parsedUrl);
        cdnUrl.hostname = 'cdn.discordapp.com';
        return fetchGifFile(cdnUrl);
    }
}

function resolveWelcomeMessage(welcomeMessage) {
    return welcomeMessage === undefined ||
        welcomeMessage === null ||
        welcomeMessage === LEGACY_WELCOME_MESSAGE ||
        welcomeMessage === PREVIOUS_DEFAULT_WELCOME_MESSAGE
        ? DEFAULT_WELCOME_MESSAGE
        : welcomeMessage;
}

async function buildWelcomePayload(guild, {
    channel,
    welcomeTitle,
    welcomeMessage,
    welcomeFooter,
    welcomeGifUrl,
    memberName,
    memberId,
    avatarUrl = '',
}) {
    const memberMention = `<@${memberId}>`;
    const channelAliases = {
        '{channel}': channel.id,
        '{welcomeChannel}': channel.id,
        '{products}': PRODUCTS_CHANNEL_ID,
        '{productChannel}': PRODUCTS_CHANNEL_ID,
        '{productsChannel}': PRODUCTS_CHANNEL_ID,
        '{terms}': TERMS_CHANNEL_ID,
        '{termsChannel}': TERMS_CHANNEL_ID,
    };
    const channelLink = (channelId, fallbackName = 'canal') => {
        const target = guild.channels.cache.get(channelId);
        const channelName = target?.name || fallbackName;
        const safeName = channelName.replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, '\\$1');
        return `[#${safeName}](https://discord.com/channels/${guild.id}/${channelId})`;
    };
    const replacements = {
        '{user}': memberName,
        '{user.mention}': memberName,
        '{user.name}': memberName,
        '{user.id}': memberId,
        '{user.avatar}': avatarUrl,
        '{member}': memberMention,
        '{member.name}': memberName,
        '{member.id}': memberId,
        '{member.avatar}': avatarUrl,
        '{channel.name}': channel.name,
        '{channel.id}': channel.id,
        '{guild}': guild.name,
        '{guild.name}': guild.name,
        '{guild.id}': guild.id,
        '{guild.memberCount}': String(guild.memberCount),
        '{guild.icon}': guild.iconURL?.({ extension: 'png', size: 256 }) || '',
        '{server}': guild.name,
        '{memberCount}': String(guild.memberCount),
    };
    const applyReplacements = text => text
        .replace(/\{[^{}]+\}/g, token => {
            const channelId = channelAliases[token];
            if (channelId) {
                const fallbackName = channelId === channel.id
                    ? channel.name
                    : channelId === PRODUCTS_CHANNEL_ID ? 'produtos' : 'termos';
                return channelLink(channelId, fallbackName);
            }
            return replacements[token] ?? token;
        })
        .replace(/<#(\d{17,20})>/g, (_mention, channelId) => {
            return channelLink(channelId);
        });
    const rawTitle = welcomeTitle ?? DEFAULT_WELCOME_TITLE;
    const rawMessage = resolveWelcomeMessage(welcomeMessage);
    const rawFooter = welcomeFooter ?? DEFAULT_WELCOME_FOOTER;
    const title = applyReplacements(rawTitle);
    const message = applyReplacements(rawMessage);
    const footer = applyReplacements(rawFooter);
    const embed = new EmbedBuilder().setColor('#8B5CF6');
    if (title) embed.setTitle(title.slice(0, 256));
    if (message) embed.setDescription(message.slice(0, 4096));
    if (footer) embed.setFooter({ text: footer.slice(0, 2048) });
    if (avatarUrl) embed.setThumbnail(avatarUrl);

    const files = [];
    if (welcomeGifUrl) {
        const gif = await downloadWelcomeGif(welcomeGifUrl);
        files.push(new AttachmentBuilder(gif, { name: 'welcome.gif' }));
        embed.setImage('attachment://welcome.gif');
    }
    return {
        embeds: [embed],
        files,
        allowedMentions: { parse: [] },
    };
}

async function startDashboard(client) {
    installErrorCapture();
    const dashboardConfig = getDashboardConfig(client);
    const host = process.env.DASHBOARD_HOST || '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost' && !dashboardConfig.secureCookie) {
        throw new Error('Para aceitar conexões externas, configure DASHBOARD_PUBLIC_URL com HTTPS.');
    }
    const storedSettings = await readDashboardSettings();
    const storedLogLimit = storedSettings._dashboardPreferences?.maxErrorLogs;
    if (Number.isInteger(storedLogLimit) && storedLogLimit >= 50 && storedLogLimit <= 1000) {
        maxErrorLogs = storedLogLimit;
    }

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '12mb' }));
    app.use(express.static(PUBLIC_PATH, {
        index: 'index.html',
        setHeaders(res, filePath) {
            if (/\.(?:html|js|css)$/i.test(filePath)) {
                res.setHeader('Cache-Control', 'no-store');
            }
        },
    }));

    app.get('/api/auth/status', (req, res) => {
        const session = getAuthenticatedSession(req, dashboardConfig.sessionSecret);
        const gateId = getCookie(req, 'kkjj_gate');
        const gateExpiry = passwordGates.get(gateId);
        if (gateExpiry && gateExpiry <= Date.now()) passwordGates.delete(gateId);
        return res.json({
            configured: dashboardConfig.configured,
            missing: dashboardConfig.missing,
            authenticated: Boolean(session),
            passwordVerified: Boolean(gateExpiry && gateExpiry > Date.now()),
            user: session ? { username: session.username, role: session.role } : null,
        });
    });

    app.get('/api/guilds/:guildId/members', async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });

        const after = req.query.after || undefined;
        if (after !== undefined && (typeof after !== 'string' || !/^\d{17,20}$/.test(after))) {
            return res.status(400).json({ error: 'O cursor de membros é inválido.' });
        }

        const [roles, members] = await Promise.all([
            guild.roles.fetch(),
            guild.members.list({ limit: 100, ...(after ? { after } : {}) }),
        ]);
        const orderedRoles = [...roles.values()]
            .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
        const roleNames = new Map(orderedRoles.map(role => [role.id, role.name]));
        const memberList = [...members.values()].map(member => ({
            id: member.id,
            username: member.user.tag,
            displayName: member.displayName,
            bot: member.user.bot,
            roles: member.roles.cache
                .map(role => roleNames.get(role.id))
                .filter(Boolean)
                .sort((a, b) => a.localeCompare(b)),
        }));
        const lastMember = members.last();

        return res.json({
            roles: orderedRoles.map(role => ({
                id: role.id,
                name: role.name,
                color: role.hexColor,
                position: role.position,
                managed: role.managed,
            })),
            members: memberList,
            totalMembers: guild.memberCount,
            nextAfter: members.size === 100 ? lastMember.id : null,
        });
    });

    app.post('/auth/password', requireSameOrigin(dashboardConfig.publicOrigin), (req, res) => {
        if (!dashboardConfig.configured) {
            return res.status(503).json({
                error: `Configure o painel no arquivo .env (${dashboardConfig.missing.join(', ')}).`,
            });
        }
        const now = Date.now();
        for (const [gateId, expiry] of passwordGates) {
            if (expiry <= now) passwordGates.delete(gateId);
        }
        for (const [address, attempt] of passwordAttempts) {
            if (attempt.expiresAt <= now) passwordAttempts.delete(address);
        }
        const address = req.socket.remoteAddress || 'unknown';
        const attempt = passwordAttempts.get(address);
        if (attempt?.count >= 5) {
            return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
        }
        if (!verifyDashboardPassword(req.body?.password, dashboardConfig.passwordHash)) {
            const current = attempt || { count: 0, expiresAt: now + 15 * 60 * 1000 };
            current.count += 1;
            passwordAttempts.set(address, current);
            return res.status(401).json({ error: 'Senha incorreta.' });
        }
        passwordAttempts.delete(address);
        if (passwordGates.size >= 500) {
            return res.status(503).json({ error: 'Limite de sessões preliminares atingido. Tente novamente mais tarde.' });
        }
        const gateId = crypto.randomBytes(32).toString('base64url');
        passwordGates.set(gateId, now + 10 * 60 * 1000);
        setCookie(res, 'kkjj_gate', gateId, { secure: dashboardConfig.secureCookie, maxAge: 600 });
        return res.json({ message: 'Senha confirmada. Continue com sua conta Discord.' });
    });

    app.get('/auth/login', (req, res) => {
        const gateId = getCookie(req, 'kkjj_gate');
        const gateExpiry = passwordGates.get(gateId);
        if (!dashboardConfig.configured) return res.redirect('/?auth=setup');
        if (!gateExpiry || gateExpiry <= Date.now()) {
            if (gateId) passwordGates.delete(gateId);
            setCookie(res, 'kkjj_gate', '', { secure: dashboardConfig.secureCookie, maxAge: 0 });
            return res.redirect('/?auth=password');
        }
        for (const [state, expiry] of pendingOAuthStates) {
            if (expiry <= Date.now()) pendingOAuthStates.delete(state);
        }
        const state = crypto.randomBytes(32).toString('base64url');
        pendingOAuthStates.set(state, Date.now() + 10 * 60 * 1000);
        setCookie(res, 'kkjj_oauth_state', state, { secure: dashboardConfig.secureCookie, maxAge: 600 });
        const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
        authorizeUrl.search = new URLSearchParams({
            client_id: dashboardConfig.clientId,
            redirect_uri: dashboardConfig.redirectUri,
            response_type: 'code',
            scope: 'identify',
            state,
        }).toString();
        return res.redirect(authorizeUrl.toString());
    });

    app.get('/auth/callback', async (req, res) => {
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const storedStateExpiry = pendingOAuthStates.get(state);
        pendingOAuthStates.delete(state);
        const gateId = getCookie(req, 'kkjj_gate');
        const gateExpiry = passwordGates.get(gateId);
        setCookie(res, 'kkjj_oauth_state', '', { secure: dashboardConfig.secureCookie, maxAge: 0 });
        if (!dashboardConfig.configured || req.query.error || !state ||
            getCookie(req, 'kkjj_oauth_state') !== state || !storedStateExpiry ||
            storedStateExpiry <= Date.now() || !code || !gateExpiry || gateExpiry <= Date.now()) {
            return res.redirect('/?auth=failed');
        }

        try {
            const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: dashboardConfig.clientId,
                    client_secret: dashboardConfig.clientSecret,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: dashboardConfig.redirectUri,
                }),
            });
            if (!tokenResponse.ok) throw new Error(`Discord OAuth token exchange failed with HTTP ${tokenResponse.status}.`);
            const tokenData = await tokenResponse.json();
            const userResponse = await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            if (!userResponse.ok) throw new Error(`Discord OAuth identity request failed with HTTP ${userResponse.status}.`);
            const user = await userResponse.json();
            const role = resolveDashboardRole(user, dashboardConfig);
            if (!role) {
                passwordGates.delete(gateId);
                setCookie(res, 'kkjj_gate', '', { secure: dashboardConfig.secureCookie, maxAge: 0 });
                return res.redirect('/?auth=denied');
            }

            for (const [sessionId, session] of authSessions) {
                if (session.expiresAt <= Date.now()) authSessions.delete(sessionId);
            }
            if (authSessions.size >= 500) {
                return res.status(503).send('Limite de sessões atingido. Tente novamente mais tarde.');
            }
            const sessionId = crypto.randomBytes(32).toString('base64url');
            const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
            authSessions.set(sessionId, {
                userId: user.id,
                username: user.username,
                role,
                expiresAt,
            });
            passwordGates.delete(gateId);
            setCookie(res, 'kkjj_gate', '', { secure: dashboardConfig.secureCookie, maxAge: 0 });
            const signature = signSessionId(sessionId, dashboardConfig.sessionSecret);
            setCookie(res, 'kkjj_session', `${sessionId}.${signature}`, {
                secure: dashboardConfig.secureCookie,
                maxAge: 8 * 60 * 60,
            });
            return res.redirect('/');
        } catch (error) {
            console.error('Erro no login OAuth do painel:', error);
            return res.redirect('/?auth=failed');
        }
    });

    app.post('/auth/logout', requireSameOrigin(dashboardConfig.publicOrigin), (req, res) => {
        const session = getAuthenticatedSession(req, dashboardConfig.sessionSecret);
        if (session) removeAuthenticatedSession(session);
        setCookie(res, 'kkjj_session', '', { secure: dashboardConfig.secureCookie, maxAge: 0 });
        return res.json({ message: 'Sessão encerrada.' });
    });

    app.use('/api', async (req, res, next) => {
        if (req.path === '/auth/status') return next();
        if (!dashboardConfig.configured) {
            return res.status(503).json({
                error: `Configure o painel no arquivo .env (${dashboardConfig.missing.join(', ')}).`,
            });
        }
        const session = getAuthenticatedSession(req, dashboardConfig.sessionSecret);
        if (!session) return res.status(401).json({ error: 'Entre com a senha e sua conta Discord para continuar.' });
        req.dashboardUser = session;
        return next();
    });

    app.get('/api/guilds', (req, res) => {
        const guilds = [...client.guilds.cache.values()]
            .map(guild => ({ id: guild.id, name: guild.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
        return res.json(guilds);
    });

    app.get('/api/logs', requireDashboardRole('owner'), (req, res) => {
        const requestedLimit = Number(req.query.limit);
        const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, maxErrorLogs)) : maxErrorLogs;
        return res.json({ logs: errorLogs.slice(0, limit), count: errorLogs.length, maxErrorLogs });
    });

    app.delete('/api/logs', requireSameOrigin(dashboardConfig.publicOrigin), requireDashboardRole('owner'), (req, res) => {
        errorLogs.length = 0;
        return res.json({ message: 'Logs de erros apagados.' });
    });

    app.get('/api/dashboard/preferences', requireDashboardRole('owner'), async (req, res) => {
        const settings = await readDashboardSettings();
        const preferences = settings._dashboardPreferences || {};
        return res.json({
            refreshIntervalSeconds: preferences.refreshIntervalSeconds ?? 15,
            maxErrorLogs,
        });
    });

    app.put('/api/dashboard/preferences', requireSameOrigin(dashboardConfig.publicOrigin), requireDashboardRole('owner'), async (req, res) => {
        const { refreshIntervalSeconds, maxErrorLogs: requestedMaxLogs } = req.body || {};
        if (![0, 5, 15, 30, 60].includes(refreshIntervalSeconds)) {
            return res.status(400).json({ error: 'Escolha um intervalo de atualização válido.' });
        }
        if (![50, 100, 250, 500, 1000].includes(requestedMaxLogs)) {
            return res.status(400).json({ error: 'Escolha um limite de logs válido.' });
        }
        const preferences = { refreshIntervalSeconds, maxErrorLogs: requestedMaxLogs };
        await saveDashboardPreferences(preferences);
        maxErrorLogs = requestedMaxLogs;
        if (errorLogs.length > maxErrorLogs) errorLogs.length = maxErrorLogs;
        return res.json({ message: 'Ajustes do painel salvos.', ...preferences });
    });

    app.get('/api/guilds/:guildId/notes', async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });
        const config = await getGuildSettings(guild.id);
        return res.json({ notes: config.dashboardNotes || '' });
    });

    app.put('/api/guilds/:guildId/notes', requireSameOrigin(dashboardConfig.publicOrigin), requireDashboardRole('owner'), async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });
        const notes = req.body?.notes;
        if (typeof notes !== 'string' || notes.length > 5000) {
            return res.status(400).json({ error: 'As observações devem ser texto de até 5000 caracteres.' });
        }
        const config = await getGuildSettings(guild.id);
        await saveGuildSettings(guild.id, { ...config, dashboardNotes: notes });
        return res.json({ message: 'Observações salvas.' });
    });

    app.get('/api/guilds/:guildId/options', async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });

        const botMember = guild.members.me;
        if (!botMember) return res.status(503).json({ error: 'O bot ainda não carregou os dados deste servidor.' });

        const [channels, roles, config, ticketSettings] = await Promise.all([
            guild.channels.fetch(),
            guild.roles.fetch(),
            getGuildSettings(guild.id),
            readTicketSettings(),
        ]);
        const ticketLogChannels = getTicketLogChannels(ticketSettings, guild.id);
        const textChannels = [...channels.values()]
            .filter(channel =>
                channel &&
                (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) &&
                channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel) &&
                channel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages))
            .map(channel => ({ id: channel.id, name: channel.name, type: channel.type }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const assignableRoles = botMember.permissions.has(PermissionFlagsBits.ManageRoles)
            ? [...roles.values()]
            .filter(role => role && isAssignableRole(role, botMember))
            .map(role => ({ id: role.id, name: role.name }))
            .sort((a, b) => a.name.localeCompare(b.name))
            : [];
        const ticketStaffRoles = [...roles.values()]
            .filter(role => role && role.id !== guild.id && !role.managed)
            .map(role => ({ id: role.id, name: role.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const ticketCategories = [...channels.values()]
            .filter(channel => channel?.type === ChannelType.GuildCategory)
            .map(channel => ({ id: channel.id, name: channel.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const storeSettings = Object.fromEntries(
            Object.entries(DEFAULT_STORE_SETTINGS).map(([key, defaultValue]) => [
                key,
                config[key] ?? defaultValue,
            ]),
        );

        return res.json({
            channels: textChannels,
            ticketCategories,
            roles: assignableRoles,
            ticketStaffRoles,
            config: {
                welcomeEnabled: config.welcomeEnabled === true,
                welcomeChannelId: config.welcomeChannelId || '',
                welcomeTitle: config.welcomeTitle ?? DEFAULT_WELCOME_TITLE,
                welcomeMessage: resolveWelcomeMessage(config.welcomeMessage),
                welcomeFooter: config.welcomeFooter ?? DEFAULT_WELCOME_FOOTER,
                welcomeGifUrl: config.welcomeGifUrl || '',
                ticketLogOpenChannelId: ticketLogChannels.open,
                ticketLogChannelId: ticketLogChannels.close,
                memberJoinLogChannelId: ticketLogChannels.join,
                memberLeaveLogChannelId: ticketLogChannels.leave,
                autoRoleId: config.autoRoleId || '',
                verificationChannelId: config.verificationChannelId || '',
                verifiedRoleId: config.verifiedRoleId || '',
                futureCustomerRoleId: config.futureCustomerRoleId || '',
                customerRoleId: config.customerRoleId || '',
                pendingRoleId: config.pendingRoleId || '',
                ticketStaffRoleIds: Array.isArray(config.ticketStaffRoleIds) ? config.ticketStaffRoleIds : [],
                ticketPurchaseCategoryId: config.ticketPurchaseCategoryId || '',
                ticketSupportCategoryId: config.ticketSupportCategoryId || '',
                ticketQuestionCategoryId: config.ticketQuestionCategoryId || '',
                verificationMessageId: config.verificationMessageId || '',
                ...storeSettings,
            },
        });
    });

    app.get('/api/guilds/:guildId/giveaways', requireDashboardRole('owner'), async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });

        let storedGiveaways;
        try {
            storedGiveaways = JSON.parse(await fs.readFile(GIVEAWAYS_PATH, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return res.json({ giveaways: [] });
            console.error('Erro ao ler os sorteios para o painel:', error);
            return res.status(500).json({ error: 'Não consegui ler os dados dos sorteios.' });
        }
        if (!storedGiveaways || Array.isArray(storedGiveaways) || typeof storedGiveaways !== 'object') {
            console.error('O arquivo de sorteios tem um formato inválido ao carregar o painel.');
            return res.status(500).json({ error: 'O arquivo de sorteios tem um formato inválido.' });
        }
        const results = Object.entries(storedGiveaways)
            .filter(([, giveaway]) => giveaway?.guildId === guild.id)
            .map(([messageId, giveaway]) => ({
                messageId,
                channelId: giveaway.channelId,
                prize: giveaway.prize,
                hostTag: giveaway.hostTag,
                responsibleId: giveaway.responsibleId,
                endsAt: giveaway.endsAt,
                status: giveaway.status,
                winnerId: giveaway.winnerId || null,
                winnerCode: giveaway.winnerCode || null,
                resultAnnounced: giveaway.resultAnnounced === true,
                entries: Array.isArray(giveaway.entries)
                    ? giveaway.entries.map(entry => ({ userId: entry.userId, code: entry.code }))
                    : [],
            }))
            .sort((a, b) => b.endsAt - a.endsAt);
        return res.json({ giveaways: results });
    });

    app.get('/api/guilds/:guildId/ticket-logs', requireDashboardRole('owner'), async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });

        const ticketSettings = await readTicketSettings();
        const channelId = getTicketLogChannels(ticketSettings, guild.id).close;
        if (!channelId) {
            return res.json({ channelId: '', channelName: '', logs: [], warning: 'Nenhum canal de logs configurado neste servidor.' });
        }

        const channel = await guild.channels.fetch(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) {
            return res.json({ channelId, channelName: '', logs: [], warning: 'O canal configurado não existe ou não é um canal de texto. Selecione outro canal e salve.' });
        }
        const botMember = guild.members.me;
        if (!botMember ||
            !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel) ||
            !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ReadMessageHistory)) {
            return res.json({ channelId, channelName: channel.name, logs: [], warning: 'O bot precisa das permissões Ver canal e Ler histórico de mensagens para exibir os logs.' });
        }

        const messages = [];
        let before;
        while (true) {
            const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
            if (batch.size === 0) break;
            messages.push(...batch.values());
            before = batch.last().id;
            if (batch.size < 100) break;
        }
        const logs = messages
            .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
            .map(message => ({
                id: message.id,
                timestamp: message.createdAt.toISOString(),
                url: message.url,
                content: message.content,
                embeds: message.embeds.map(embed => ({
                    title: embed.title || '',
                    description: embed.description || '',
                    fields: embed.fields.map(field => ({ name: field.name, value: field.value })),
                })),
                attachments: [...message.attachments.values()].map(attachment => ({
                    name: attachment.name || 'arquivo',
                    url: attachment.url,
                    size: attachment.size,
                })),
            }));
        return res.json({ channelId, channelName: channel.name, logs, warning: '' });
    });

    app.delete('/api/guilds/:guildId/ticket-logs/:messageId', requireSameOrigin(dashboardConfig.publicOrigin), requireDashboardRole('owner'), async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });
        if (!/^\d{17,20}$/.test(req.params.messageId)) {
            return res.status(400).json({ error: 'ID de mensagem inválido.' });
        }

        const ticketSettings = await readTicketSettings();
        const channelId = getTicketLogChannels(ticketSettings, guild.id).close;
        if (!channelId) return res.status(409).json({ error: 'Configure primeiro o canal de logs dos tickets.' });

        const [channel, botMember] = await Promise.all([
            guild.channels.fetch(channelId),
            guild.members.fetch(client.user.id),
        ]);
        if (!channel || channel.type !== ChannelType.GuildText) {
            return res.status(404).json({ error: 'O canal de logs configurado não existe mais.' });
        }
        const permissions = channel.permissionsFor(botMember);
        if (!permissions?.has(PermissionFlagsBits.ManageMessages)) {
            return res.status(403).json({ error: 'O bot precisa da permissão Gerenciar mensagens no canal de logs para apagar um registro.' });
        }

        let logMessage;
        try {
            logMessage = await channel.messages.fetch(req.params.messageId);
        } catch (error) {
            if (error.code === 10008) {
                return res.status(404).json({ error: 'Registro não encontrado no canal de logs.' });
            }
            throw error;
        }
        await logMessage.delete('Exclusão manual confirmada pelo painel de logs de tickets.');
        return res.json({ message: 'Registro apagado do canal de logs.' });
    });

    app.put('/api/guilds/:guildId/ticket-logs', requireSameOrigin(dashboardConfig.publicOrigin), requireDashboardRole('owner'), async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });

        const isLegacyRequest = typeof req.body?.channelId === 'string';
        const currentChannels = getTicketLogChannels(await readTicketSettings(), guild.id);
        const channelIds = {
            open: isLegacyRequest ? req.body.channelId : req.body?.openChannelId,
            close: isLegacyRequest ? req.body.channelId : req.body?.closeChannelId,
            join: isLegacyRequest ? currentChannels.join : req.body?.memberJoinChannelId,
            leave: isLegacyRequest ? currentChannels.leave : req.body?.memberLeaveChannelId,
        };
        if (Object.values(channelIds).some(channelId =>
            typeof channelId !== 'string' || (channelId && !/^\d{17,20}$/.test(channelId))
        )) {
            return res.status(400).json({ error: 'Selecione canais válidos para os logs de tickets e membros.' });
        }
        const requiredPermissions = [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
        ];
        const validateChannel = async (channelId, channelLabel, permissions) => {
            if (!channelId) return null;
            const channel = await guild.channels.fetch(channelId);
            const botMember = guild.members.me;
            const botPermissions = channel?.type === ChannelType.GuildText && botMember
                ? channel.permissionsFor(botMember)
                : null;
            if (!channel || channel.type !== ChannelType.GuildText || !botMember ||
                !botPermissions?.has(permissions)) {
                return res.status(400).json({ error: `Escolha um canal de texto para ${channelLabel} em que o bot tenha as permissões necessárias.` });
            }
            return true;
        };
        if (!await validateChannel(channelIds.open, 'as aberturas de tickets', requiredPermissions)) return;
        if (!await validateChannel(channelIds.close, 'os encerramentos de tickets', [
            ...requiredPermissions,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ManageMessages,
        ])) return;
        if (!await validateChannel(channelIds.join, 'as entradas de membros', requiredPermissions)) return;
        if (!await validateChannel(channelIds.leave, 'as saídas de membros', requiredPermissions)) return;

        await saveTicketLogChannels(guild.id, channelIds);
        return res.json({
            message: Object.values(channelIds).some(Boolean)
                ? 'Canais de logs salvos.'
                : 'Logs de tickets desativados.',
        });
    });

    app.put('/api/guilds/:guildId/config', requireSameOrigin(dashboardConfig.publicOrigin), requireDashboardRole('owner'), async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });

        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({ error: 'Configuração inválida.' });
        }
        const previous = await getGuildSettings(guild.id);
        const welcomeTitle = typeof body.welcomeTitle === 'string' ? body.welcomeTitle.trim() : '';
        if (welcomeTitle.length > 256) {
            return res.status(400).json({ error: 'O título de boas-vindas não pode passar de 256 caracteres.' });
        }
        const welcomeMessage = typeof body.welcomeMessage === 'string' ? body.welcomeMessage.trim() : '';
        if (welcomeMessage.length > 2000) {
            return res.status(400).json({ error: 'A mensagem de boas-vindas não pode passar de 2000 caracteres.' });
        }
        const welcomeFooter = typeof body.welcomeFooter === 'string' ? body.welcomeFooter.trim() : '';
        if (welcomeFooter.length > 2048) {
            return res.status(400).json({ error: 'O rodapé de boas-vindas não pode passar de 2048 caracteres.' });
        }
        const welcomeGifUrl = typeof body.welcomeGifUrl === 'string' ? body.welcomeGifUrl.trim() : '';
        if (welcomeGifUrl.length > 2048) {
            return res.status(400).json({ error: 'O link do GIF não pode passar de 2048 caracteres.' });
        }
        if (welcomeGifUrl) {
            let parsedGifUrl;
            try {
                parsedGifUrl = new URL(welcomeGifUrl);
            } catch {
                parsedGifUrl = null;
            }
            if (!parsedGifUrl || parsedGifUrl.protocol !== 'https:') {
                return res.status(400).json({ error: 'Informe um link HTTPS válido para o GIF.' });
            }
        }
        if (body.welcomeGifUrl !== undefined && typeof body.welcomeGifUrl !== 'string') {
            return res.status(400).json({ error: 'O link do GIF deve ser texto.' });
        }
        const storeTextLimits = {
            storeTitle: 256,
            storeDescription: 4000,
            storeField1Title: 256,
            storeField1Value: 1024,
            storeField2Title: 256,
            storeField2Value: 1024,
            storeField3Title: 256,
            storeField3Value: 1024,
            storeField4Title: 256,
            storeField4Value: 1024,
            storeImageUrl: 2048,
            storeFooter: 2048,
            termsAuthor: 256,
            termsTitle: 256,
            termsDescription: 4000,
            termsField1Title: 256,
            termsField1Value: 1024,
            termsField2Title: 256,
            termsField2Value: 1024,
            termsField3Title: 256,
            termsField3Value: 1024,
            termsField4Title: 256,
            termsField4Value: 1024,
            termsField5Title: 256,
            termsField5Value: 1024,
            termsField6Title: 256,
            termsField6Value: 1024,
            termsField7Title: 256,
            termsField7Value: 1024,
            termsImportantTitle: 256,
            termsImportantValue: 1024,
            termsFooter: 2048,
        };
        const storeValues = {};
        for (const [field, limit] of Object.entries(storeTextLimits)) {
            if (body[field] === undefined) {
                storeValues[field] = previous[field] ?? DEFAULT_STORE_SETTINGS[field];
                continue;
            }
            if (typeof body[field] !== 'string') {
                return res.status(400).json({ error: `O campo ${field} precisa ser texto.` });
            }
            storeValues[field] = body[field].trim();
            if (storeValues[field].length > limit) {
                return res.status(400).json({ error: `O campo ${field} não pode passar de ${limit} caracteres.` });
            }
        }
        if (storeValues.storeImageUrl) {
            let parsedStoreImageUrl;
            try {
                parsedStoreImageUrl = new URL(storeValues.storeImageUrl);
            } catch {
                parsedStoreImageUrl = null;
            }
            if (!parsedStoreImageUrl || parsedStoreImageUrl.protocol !== 'https:') {
                return res.status(400).json({ error: 'Informe um link HTTPS válido para a imagem ou GIF da loja.' });
            }
        }
        const welcomeEnabled = body.welcomeEnabled === undefined
            ? previous.welcomeEnabled === true
            : body.welcomeEnabled === true;
        if (welcomeEnabled && !welcomeTitle && !welcomeMessage && !welcomeFooter && !welcomeGifUrl) {
            return res.status(400).json({ error: 'Preencha o título, a mensagem, o rodapé ou informe um GIF para montar o embed de boas-vindas.' });
        }
        const idFields = [
            'welcomeChannelId',
            'autoRoleId',
            'verificationChannelId',
            'verifiedRoleId',
            'futureCustomerRoleId',
            'customerRoleId',
            'pendingRoleId',
            'ticketPurchaseCategoryId',
            'ticketSupportCategoryId',
            'ticketQuestionCategoryId',
        ];
        for (const field of idFields) {
            if (body[field] !== '' && body[field] !== null && body[field] !== undefined &&
                (typeof body[field] !== 'string' || !/^\d{17,20}$/.test(body[field]))) {
                return res.status(400).json({ error: `O campo ${field} contém um ID inválido.` });
            }
        }
        if (body.ticketStaffRoleIds !== undefined &&
            (!Array.isArray(body.ticketStaffRoleIds) ||
                body.ticketStaffRoleIds.length > 50 ||
                body.ticketStaffRoleIds.some(roleId => typeof roleId !== 'string' || !/^\d{17,20}$/.test(roleId)) ||
                new Set(body.ticketStaffRoleIds).size !== body.ticketStaffRoleIds.length)) {
            return res.status(400).json({ error: 'Selecione até 50 cargos válidos e sem repetição para atender os tickets.' });
        }
        if (body.welcomeEnabled !== undefined && typeof body.welcomeEnabled !== 'boolean') {
            return res.status(400).json({ error: 'Informe se as boas-vindas estão ativadas.' });
        }
        if (welcomeEnabled && !body.welcomeChannelId) {
            return res.status(400).json({ error: 'Selecione o canal de boas-vindas ou desative as boas-vindas.' });
        }

        const [channels, roles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
        const botMember = guild.members.me;
        const canManageRoles = botMember.permissions.has(PermissionFlagsBits.ManageRoles);
        const channelIds = new Set([...channels.values()]
            .filter(channel => channel &&
                (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) &&
                channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel) &&
                channel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages))
            .map(channel => channel.id));
        const assignableRoleIds = new Set([...roles.values()]
            .filter(role => role && canManageRoles && isAssignableRole(role, botMember))
            .map(role => role.id));
        const ticketStaffRoleIds = new Set([...roles.values()]
            .filter(role => role && role.id !== guild.id && !role.managed)
            .map(role => role.id));
        const ticketCategoryIds = new Set([...channels.values()]
            .filter(channel => channel?.type === ChannelType.GuildCategory)
            .map(channel => channel.id));

        for (const field of ['welcomeChannelId', 'verificationChannelId']) {
            if (body[field] && !channelIds.has(body[field])) {
                return res.status(400).json({ error: 'Escolha um canal de texto no qual o bot possa ver e enviar mensagens.' });
            }
        }
        for (const field of ['ticketPurchaseCategoryId', 'ticketSupportCategoryId', 'ticketQuestionCategoryId']) {
            if (body[field] && !ticketCategoryIds.has(body[field])) {
                return res.status(400).json({ error: 'Escolha uma categoria de tickets existente neste servidor.' });
            }
        }
        for (const field of ['autoRoleId', 'verifiedRoleId', 'futureCustomerRoleId', 'customerRoleId', 'pendingRoleId']) {
            if (body[field] && !assignableRoleIds.has(body[field])) {
                return res.status(400).json({ error: 'Escolha um cargo que o bot possa atribuir, abaixo do cargo mais alto do bot.' });
            }
        }
        if (body.ticketStaffRoleIds?.some(roleId => !ticketStaffRoleIds.has(roleId))) {
            return res.status(400).json({ error: 'Um dos cargos de atendimento não existe ou não pode ser usado.' });
        }
        const verificationEnabled = Boolean(
            body.verificationChannelId && (body.verifiedRoleId || body.futureCustomerRoleId),
        );
        if (body.pendingRoleId && body.pendingRoleId === body.verifiedRoleId) {
            return res.status(400).json({ error: 'O cargo pendente e o cargo liberado precisam ser diferentes.' });
        }
        if (body.futureCustomerRoleId && body.verifiedRoleId === body.futureCustomerRoleId) {
            return res.status(400).json({ error: 'Os cargos Verificado e Futuro Cliente precisam ser diferentes.' });
        }
        if (body.customerRoleId && [
            body.verifiedRoleId,
            body.futureCustomerRoleId,
            body.pendingRoleId,
        ].includes(body.customerRoleId)) {
            return res.status(400).json({ error: 'O cargo Cliente precisa ser diferente dos cargos de verificação.' });
        }
        if (body.pendingRoleId && body.pendingRoleId === body.futureCustomerRoleId) {
            return res.status(400).json({ error: 'Os cargos pendente, Verificado e Futuro Cliente precisam ser diferentes.' });
        }
        if (verificationEnabled && body.autoRoleId &&
            [body.verifiedRoleId, body.futureCustomerRoleId, body.customerRoleId, body.pendingRoleId].includes(body.autoRoleId)) {
            return res.status(400).json({ error: 'O cargo automático precisa ser diferente dos cargos configurados para verificação e pagamento.' });
        }

        const config = {
            ...previous,
            welcomeEnabled,
            welcomeChannelId: body.welcomeChannelId || '',
            welcomeTitle: body.welcomeTitle === undefined ? DEFAULT_WELCOME_TITLE : welcomeTitle,
            welcomeMessage,
            welcomeFooter: body.welcomeFooter === undefined ? DEFAULT_WELCOME_FOOTER : welcomeFooter,
            welcomeGifUrl,
            autoRoleId: body.autoRoleId || '',
            verificationChannelId: body.verificationChannelId || '',
            verifiedRoleId: body.verifiedRoleId || '',
            futureCustomerRoleId: body.futureCustomerRoleId || '',
            customerRoleId: body.customerRoleId || '',
            pendingRoleId: body.pendingRoleId || '',
            ticketStaffRoleIds: body.ticketStaffRoleIds === undefined
                ? (previous.ticketStaffRoleIds || [])
                : body.ticketStaffRoleIds,
            ticketPurchaseCategoryId: body.ticketPurchaseCategoryId === undefined
                ? (previous.ticketPurchaseCategoryId || '')
                : body.ticketPurchaseCategoryId || '',
            ticketSupportCategoryId: body.ticketSupportCategoryId === undefined
                ? (previous.ticketSupportCategoryId || '')
                : body.ticketSupportCategoryId || '',
            ticketQuestionCategoryId: body.ticketQuestionCategoryId === undefined
                ? (previous.ticketQuestionCategoryId || '')
                : body.ticketQuestionCategoryId || '',
            ...storeValues,
        };
        await saveGuildSettings(guild.id, config);
        return res.json({ message: 'Configurações salvas.' });
    });

    app.post('/api/guilds/:guildId/welcome-test', requireSameOrigin(dashboardConfig.publicOrigin), requireDashboardRole('owner'), async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });

        const {
            welcomeChannelId,
            welcomeTitle,
            welcomeMessage,
            welcomeFooter,
            welcomeGifUrl,
        } = req.body || {};
        if (typeof welcomeChannelId !== 'string' || !/^\d{17,20}$/.test(welcomeChannelId)) {
            return res.status(400).json({ error: 'Selecione um canal de boas-vindas para enviar o teste.' });
        }
        if (typeof welcomeTitle !== 'string' || welcomeTitle.length > 256) {
            return res.status(400).json({ error: 'O título de boas-vindas deve ter até 256 caracteres.' });
        }
        if (typeof welcomeMessage !== 'string' || welcomeMessage.length > 2000) {
            return res.status(400).json({ error: 'A mensagem de boas-vindas deve ter até 2000 caracteres.' });
        }
        if (typeof welcomeFooter !== 'string' || welcomeFooter.length > 2048) {
            return res.status(400).json({ error: 'O rodapé de boas-vindas deve ter até 2048 caracteres.' });
        }
        if (typeof welcomeGifUrl !== 'string' || welcomeGifUrl.length > 2048) {
            return res.status(400).json({ error: 'O link do GIF deve ter até 2048 caracteres.' });
        }
        if (welcomeGifUrl) {
            let parsedGifUrl;
            try {
                parsedGifUrl = new URL(welcomeGifUrl);
            } catch {
                parsedGifUrl = null;
            }
            if (!parsedGifUrl || parsedGifUrl.protocol !== 'https:') {
                return res.status(400).json({ error: 'Informe um link HTTPS válido para o GIF.' });
            }
        }
        if (!welcomeTitle.trim() && !welcomeMessage.trim() && !welcomeFooter.trim() && !welcomeGifUrl.trim()) {
            return res.status(400).json({ error: 'Preencha o título, a mensagem, o rodapé ou informe um GIF para montar o embed de teste.' });
        }

        const channel = await guild.channels.fetch(welcomeChannelId);
        const botMember = guild.members.me;
        if (!channel || !channel.isTextBased() || typeof channel.send !== 'function' ||
            !botMember || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel) ||
            !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)) {
            return res.status(400).json({ error: 'O canal escolhido não está disponível para o bot enviar mensagens.' });
        }

        await channel.send(await buildWelcomePayload(guild, {
            channel,
            welcomeTitle: welcomeTitle.trim(),
            welcomeMessage: welcomeMessage.trim(),
            welcomeFooter: welcomeFooter.trim(),
            welcomeGifUrl: welcomeGifUrl.trim(),
            memberName: `${req.dashboardUser.username} (teste)`,
            memberId: req.dashboardUser.userId,
        }));
        return res.json({ message: `Mensagem de teste enviada em #${channel.name}.` });
    });

    app.post('/api/guilds/:guildId/verification-panel', requireSameOrigin(dashboardConfig.publicOrigin), requireDashboardRole('owner'), async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });

        const config = await getGuildSettings(guild.id);
        const verificationRoleIds = [...new Set([config.verifiedRoleId, config.futureCustomerRoleId].filter(Boolean))];
        if (!config.verificationChannelId || !verificationRoleIds.length) {
            return res.status(400).json({ error: 'Salve primeiro o canal e escolha pelo menos um cargo para atribuir.' });
        }
        const channel = await guild.channels.fetch(config.verificationChannelId);
        if (!channel || channel.type !== ChannelType.GuildText) {
            return res.status(400).json({ error: 'O canal de verificação não está disponível.' });
        }
        const botMember = guild.members.me;
        const [pendingRole, ...verificationRoles] = await Promise.all([
            config.pendingRoleId ? guild.roles.fetch(config.pendingRoleId) : null,
            ...verificationRoleIds.map(roleId => guild.roles.fetch(roleId)),
        ]);
        if (!botMember || (config.pendingRoleId && !pendingRole) || verificationRoles.some(role => !role) ||
            !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
            (pendingRole && !isAssignableRole(pendingRole, botMember)) ||
            verificationRoles.some(role => !isAssignableRole(role, botMember))) {
            return res.status(400).json({ error: 'O bot precisa ter Gerenciar cargos, e os cargos escolhidos precisam estar abaixo do cargo mais alto dele.' });
        }
        const permissions = channel.permissionsFor(botMember);
        if (!permissions?.has(PermissionFlagsBits.ViewChannel) ||
            !permissions.has(PermissionFlagsBits.SendMessages) ||
            !permissions.has(PermissionFlagsBits.EmbedLinks) ||
            !permissions.has(PermissionFlagsBits.AddReactions)) {
            return res.status(400).json({ error: 'O bot precisa de Ver canal, Enviar mensagens, Inserir links e Adicionar reações no canal de verificação.' });
        }

        const messageOptions = buildVerificationMessage(config);
        if (config.verificationMessageId) {
            try {
                const existingMessage = await channel.messages.fetch(config.verificationMessageId);
                await existingMessage.edit(messageOptions);
                await existingMessage.react('✅');
                return res.json({ message: 'Painel de verificação atualizado.' });
            } catch (error) {
                if (error.code !== 10008) throw error;
            }
        }

        const message = await channel.send(messageOptions);
        await message.react('✅');
        await saveGuildSettings(guild.id, { ...config, verificationMessageId: message.id });
        return res.json({ message: 'Painel de verificação publicado.' });
    });

    app.post('/api/guilds/:guildId/verification-test', requireSameOrigin(dashboardConfig.publicOrigin), requireDashboardRole('owner'), async (req, res) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado ou o bot não está conectado a ele.' });

        const config = await getGuildSettings(guild.id);
        const verificationRoleIds = [...new Set([config.verifiedRoleId, config.futureCustomerRoleId].filter(Boolean))];
        if (!config.verificationChannelId || !verificationRoleIds.length) {
            return res.status(400).json({ error: 'Configure o canal e escolha pelo menos um cargo para atribuir antes do teste.' });
        }
        const botMember = guild.members.me;
        if (!botMember) return res.status(503).json({ error: 'O bot ainda não carregou seus dados neste servidor.' });
        const channel = await guild.channels.fetch(config.verificationChannelId);
        const permissions = channel?.permissionsFor(botMember);
        const verificationRoles = await Promise.all(verificationRoleIds.map(roleId => guild.roles.fetch(roleId)));
        const pendingRole = config.pendingRoleId ? await guild.roles.fetch(config.pendingRoleId) : null;
        const checks = [
            { name: 'Canal de verificação disponível', ok: Boolean(channel && channel.type === ChannelType.GuildText) },
            { name: 'Bot pode enviar painel e adicionar reação', ok: Boolean(permissions?.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.SendMessages) && permissions.has(PermissionFlagsBits.EmbedLinks) && permissions.has(PermissionFlagsBits.AddReactions)) },
            { name: 'Bot pode gerenciar cargos e permissões', ok: botMember.permissions.has(PermissionFlagsBits.ManageRoles) },
            { name: 'Cargos configurados são diferentes', ok: new Set([config.verifiedRoleId, config.futureCustomerRoleId, config.pendingRoleId].filter(Boolean)).size === [config.verifiedRoleId, config.futureCustomerRoleId, config.pendingRoleId].filter(Boolean).length },
            ...verificationRoleIds.map((roleId, index) => ({
                name: `Cargo ${roleId === config.verifiedRoleId ? 'Verificado' : 'Futuro Cliente'} atribuível pelo bot`,
                ok: Boolean(verificationRoles[index] && isAssignableRole(verificationRoles[index], botMember) && botMember.permissions.has(PermissionFlagsBits.ManageRoles)),
            })),
            { name: 'Cargo Pendente atribuível pelo bot', ok: !config.pendingRoleId || Boolean(pendingRole && isAssignableRole(pendingRole, botMember) && botMember.permissions.has(PermissionFlagsBits.ManageRoles)) },
        ];
        return res.json({ checks });
    });

    app.use('/api', (req, res) => {
        return res.status(404).json({ error: 'Rota da API não encontrada. Reinicie o bot para carregar as alterações.' });
    });

    app.use((error, req, res, next) => {
        console.error(`Erro na rota do painel web (${req.method} ${req.path}):`, error);
        if (res.headersSent) return next(error);
        return res.status(500).json({ error: 'O painel não conseguiu concluir a solicitação. Confira o terminal do bot.' });
    });

    const port = Number(process.env.DASHBOARD_PORT || 3000);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(port, host, () => resolve(listener));
        listener.once('error', reject);
    });
    console.log(`Painel web disponível em ${dashboardConfig.publicOrigin || `http://127.0.0.1:${port}`}`);
    return server;
}

module.exports = { DEFAULT_STORE_SETTINGS, buildWelcomePayload, getGuildSettings, startDashboard };
