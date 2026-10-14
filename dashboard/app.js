const guildSelect = document.querySelector('#guild');
const form = document.querySelector('#settings-form');
const notice = document.querySelector('#notice');
const saveState = document.querySelector('#save-state');
const pageTitle = document.querySelector('#page-title');
const pageDescription = document.querySelector('#page-description');
const controls = {
    welcomeEnabled: document.querySelector('#welcomeEnabled'),
    welcomeChannelId: document.querySelector('#welcomeChannelId'),
    welcomeTitle: document.querySelector('#welcomeTitle'),
    welcomeMessage: document.querySelector('#welcomeMessage'),
    welcomeFooter: document.querySelector('#welcomeFooter'),
    welcomeGifUrl: document.querySelector('#welcomeGifUrl'),
    autoRoleId: document.querySelector('#autoRoleId'),
    verificationChannelId: document.querySelector('#verificationChannelId'),
    verifiedRoleId: document.querySelector('#verifiedRoleId'),
    futureCustomerRoleId: document.querySelector('#futureCustomerRoleId'),
    customerRoleId: document.querySelector('#customerRoleId'),
    pendingRoleId: document.querySelector('#pendingRoleId'),
    ticketStaffRoleIds: document.querySelector('#ticketStaffRoleIds'),
    ticketPurchaseCategoryId: document.querySelector('#ticketPurchaseCategoryId'),
    ticketSupportCategoryId: document.querySelector('#ticketSupportCategoryId'),
    ticketQuestionCategoryId: document.querySelector('#ticketQuestionCategoryId'),
    storeTitle: document.querySelector('#storeTitle'),
    storeDescription: document.querySelector('#storeDescription'),
    storeField1Title: document.querySelector('#storeField1Title'),
    storeField1Value: document.querySelector('#storeField1Value'),
    storeField2Title: document.querySelector('#storeField2Title'),
    storeField2Value: document.querySelector('#storeField2Value'),
    storeField3Title: document.querySelector('#storeField3Title'),
    storeField3Value: document.querySelector('#storeField3Value'),
    storeField4Title: document.querySelector('#storeField4Title'),
    storeField4Value: document.querySelector('#storeField4Value'),
    storeImageUrl: document.querySelector('#storeImageUrl'),
    storeFooter: document.querySelector('#storeFooter'),
    termsAuthor: document.querySelector('#termsAuthor'),
    termsTitle: document.querySelector('#termsTitle'),
    termsDescription: document.querySelector('#termsDescription'),
    termsField1Title: document.querySelector('#termsField1Title'),
    termsField1Value: document.querySelector('#termsField1Value'),
    termsField2Title: document.querySelector('#termsField2Title'),
    termsField2Value: document.querySelector('#termsField2Value'),
    termsField3Title: document.querySelector('#termsField3Title'),
    termsField3Value: document.querySelector('#termsField3Value'),
    termsField4Title: document.querySelector('#termsField4Title'),
    termsField4Value: document.querySelector('#termsField4Value'),
    termsField5Title: document.querySelector('#termsField5Title'),
    termsField5Value: document.querySelector('#termsField5Value'),
    termsField6Title: document.querySelector('#termsField6Title'),
    termsField6Value: document.querySelector('#termsField6Value'),
    termsField7Title: document.querySelector('#termsField7Title'),
    termsField7Value: document.querySelector('#termsField7Value'),
    termsImportantTitle: document.querySelector('#termsImportantTitle'),
    termsImportantValue: document.querySelector('#termsImportantValue'),
    termsFooter: document.querySelector('#termsFooter'),
};

let guildOptions = null;
let logRefreshTimer = null;
let settingsSaveTimer = null;
let pendingSettingsSave = null;
let settingsSaveQueue = Promise.resolve();
let memberRows = [];
let nextMemberCursor = null;
const pages = {
    settings: {
        title: 'Configurações do servidor',
        description: 'Boas-vindas, cargos automáticos e verificação de novos membros.',
        breadcrumb: 'CONFIGURAÇÕES',
    },
    verificationTest: {
        title: 'Testar verificação',
        description: 'Confira as permissões e teste o painel de reação.',
        breadcrumb: 'TESTAR VERIFICAÇÃO',
    },
    pix: {
        title: 'Pix e pagamentos',
        description: 'Configure quem atende os tickets e o fluxo de confirmação de pagamentos.',
        breadcrumb: 'PIX E PAGAMENTOS',
    },
    membersRoles: {
        title: 'Membros e cargos',
        description: 'Consulte os membros e todos os cargos do servidor.',
        breadcrumb: 'MEMBROS E CARGOS',
    },
    logs: {
        title: 'Logs de erros',
        description: 'Acompanhe erros que acontecem enquanto o bot está em execução.',
        breadcrumb: 'LOGS DE ERROS',
    },
    ticketLogs: {
        title: 'Logs de tickets',
        description: 'Configure o canal e consulte os históricos recentes dos atendimentos.',
        breadcrumb: 'LOGS DE TICKETS',
    },
    giveaways: {
        title: 'Sorteios',
        description: 'Consulte sorteios ativos, participantes e resultados.',
        breadcrumb: 'SORTEIOS',
    },
    store: {
        title: 'Mensagem da loja',
        description: 'Edite o conteúdo publicado pelos comandos !loja e !store.',
        breadcrumb: 'LOJA',
    },
    commands: {
        title: 'Comandos do bot',
        description: 'Consulte os comandos de texto, o que fazem e quem pode usá-los.',
        breadcrumb: 'COMANDOS',
    },
    notes: {
        title: 'Observações',
        description: 'Mantenha lembretes e tarefas organizados por servidor.',
        breadcrumb: 'OBSERVAÇÕES',
    },
    adjustments: {
        title: 'Ajustes do painel',
        description: 'Personalize as atualizações e a retenção do registro de erros.',
        breadcrumb: 'AJUSTES',
    },
};

function showNotice(message, isError = false) {
    notice.textContent = message;
    notice.hidden = false;
    notice.classList.toggle('error', isError);
}

function setOptions(select, options, emptyLabel, selectedId = '') {
    select.replaceChildren(new Option(emptyLabel, ''));
    for (const option of options) {
        select.add(new Option(option.name, option.id));
    }
    select.value = selectedId;
}

async function api(url, options) {
    const response = await fetch(url, {
        ...options,
        headers: { ...(options?.headers || {}), ...(options?.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (response.status === 401 && url !== '/auth/password') {
        window.location.assign('/');
        throw new Error('Sua sessão expirou; faça login novamente.');
    }
    const responseText = await response.text();
    let result;
    try {
        result = JSON.parse(responseText);
    } catch {
        if (response.status === 404) {
            throw new Error('O servidor do painel não reconheceu esta rota. Reinicie o bot para carregar as alterações.');
        }
        throw new Error(`O servidor do painel respondeu em um formato inválido (HTTP ${response.status}).`);
    }
    if (!response.ok) throw new Error(result.error || 'A solicitação não foi concluída.');
    return result;
}

async function loadGuilds() {
    const guilds = await api('/api/guilds');
    guildSelect.replaceChildren(new Option('Selecione um servidor', ''));
    for (const guild of guilds) guildSelect.add(new Option(guild.name, guild.id));
    if (!guilds.length) {
        guildSelect.replaceChildren(new Option('Nenhum servidor disponível', ''));
        showNotice('O bot não está conectado a nenhum servidor. Confira se ele iniciou corretamente.', true);
        return;
    }
    guildSelect.value = guilds[0].id;
    await loadGuildOptions();
}

async function loadGuildOptions() {
    const guildId = guildSelect.value;
    if (!guildId) return;
    guildOptions = await api(`/api/guilds/${guildId}/options`);
    setOptions(controls.welcomeChannelId, guildOptions.channels, 'Selecione um canal', guildOptions.config.welcomeChannelId);
    setOptions(controls.verificationChannelId, guildOptions.channels, 'Desativar verificação', guildOptions.config.verificationChannelId);
    setOptions(controls.autoRoleId, guildOptions.roles, 'Não atribuir cargo automático', guildOptions.config.autoRoleId);
    setOptions(controls.verifiedRoleId, guildOptions.roles, 'Selecione o cargo', guildOptions.config.verifiedRoleId);
    setOptions(controls.futureCustomerRoleId, guildOptions.roles, 'Selecione o cargo', guildOptions.config.futureCustomerRoleId);
    setOptions(controls.customerRoleId, guildOptions.roles, 'Selecione o cargo', guildOptions.config.customerRoleId);
    setOptions(controls.pendingRoleId, guildOptions.roles, 'Não atribuir cargo pendente', guildOptions.config.pendingRoleId);
    controls.ticketStaffRoleIds.replaceChildren(...guildOptions.ticketStaffRoles.map(role => new Option(role.name, role.id)));
    for (const option of controls.ticketStaffRoleIds.options) {
        option.selected = guildOptions.config.ticketStaffRoleIds.includes(option.value);
    }
    setOptions(controls.ticketPurchaseCategoryId, guildOptions.ticketCategories, 'Usar categoria do painel', guildOptions.config.ticketPurchaseCategoryId);
    setOptions(controls.ticketSupportCategoryId, guildOptions.ticketCategories, 'Usar categoria do painel', guildOptions.config.ticketSupportCategoryId);
    setOptions(controls.ticketQuestionCategoryId, guildOptions.ticketCategories, 'Usar categoria do painel', guildOptions.config.ticketQuestionCategoryId);
    setOptions(document.querySelector('#ticket-log-open-channel'), guildOptions.channels, 'Desativar logs de abertura', guildOptions.config.ticketLogOpenChannelId);
    setOptions(document.querySelector('#ticket-log-channel'), guildOptions.channels, 'Desativar logs de encerramento', guildOptions.config.ticketLogChannelId);
    setOptions(document.querySelector('#member-join-log-channel'), guildOptions.channels, 'Desativar logs de entrada', guildOptions.config.memberJoinLogChannelId);
    setOptions(document.querySelector('#member-leave-log-channel'), guildOptions.channels, 'Desativar logs de saída', guildOptions.config.memberLeaveLogChannelId);
    controls.welcomeEnabled.checked = guildOptions.config.welcomeEnabled;
    controls.welcomeTitle.value = guildOptions.config.welcomeTitle;
    controls.welcomeMessage.value = guildOptions.config.welcomeMessage;
    controls.welcomeFooter.value = guildOptions.config.welcomeFooter;
    controls.welcomeGifUrl.value = guildOptions.config.welcomeGifUrl;
    for (const key of [
        'storeTitle',
        'storeDescription',
        'storeField1Title',
        'storeField1Value',
        'storeField2Title',
        'storeField2Value',
        'storeField3Title',
        'storeField3Value',
        'storeField4Title',
        'storeField4Value',
        'storeImageUrl',
        'storeFooter',
        'termsAuthor',
        'termsTitle',
        'termsDescription',
        'termsField1Title',
        'termsField1Value',
        'termsField2Title',
        'termsField2Value',
        'termsField3Title',
        'termsField3Value',
        'termsField4Title',
        'termsField4Value',
        'termsField5Title',
        'termsField5Value',
        'termsField6Title',
        'termsField6Value',
        'termsField7Title',
        'termsField7Value',
        'termsImportantTitle',
        'termsImportantValue',
        'termsFooter',
    ]) {
        controls[key].value = guildOptions.config[key];
    }
    saveState.textContent = 'Configurações carregadas.';
    document.querySelector('#pix-save-state').textContent = 'Equipe e cargo carregados.';
    document.querySelector('#store-save-state').textContent = 'Configuração da loja carregada.';
    if (document.querySelector('#page-notes:not([hidden])')) await loadNotes();
    if (document.querySelector('#page-membersRoles:not([hidden])')) await loadMembersRoles(true);
}

function collectConfig() {
    return Object.fromEntries(Object.entries(controls).map(([key, control]) => [
        key,
        control.multiple
            ? [...control.selectedOptions].map(option => option.value)
            : control.type === 'checkbox' ? control.checked : control.value,
    ]));
}

function saveConfigSnapshot(guildId, config) {
    const save = settingsSaveQueue.then(() => api(`/api/guilds/${guildId}/config`, {
        method: 'PUT',
        body: JSON.stringify(config),
        keepalive: true,
    }));
    settingsSaveQueue = save.catch(() => {});
    return save;
}

async function flushPendingSettingsSave() {
    if (!pendingSettingsSave) return;
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    const snapshot = pendingSettingsSave;
    pendingSettingsSave = null;
    saveState.textContent = 'Salvando...';
    document.querySelector('#verification-save-state').textContent = 'Salvando escolhas...';
    document.querySelector('#pix-save-state').textContent = 'Salvando equipe e cargo...';
    try {
        const result = await saveConfigSnapshot(snapshot.guildId, snapshot.config);
        saveState.textContent = result.message || 'Alterações salvas.';
        document.querySelector('#verification-save-state').textContent = result.message || 'Escolhas salvas.';
        document.querySelector('#pix-save-state').textContent = result.message || 'Equipe e cargo salvos.';
        document.querySelector('#store-save-state').textContent = result.message || 'Configuração da loja salva.';
    } catch (error) {
        saveState.textContent = 'Não foi possível salvar automaticamente.';
        document.querySelector('#verification-save-state').textContent = 'Não foi possível salvar as escolhas.';
        document.querySelector('#pix-save-state').textContent = 'Não foi possível salvar equipe e cargo.';
        document.querySelector('#store-save-state').textContent = 'Não foi possível salvar a configuração da loja.';
        showNotice(error.message, true);
        throw error;
    }
}

function scheduleSettingsSave() {
    const guildId = guildSelect.value;
    if (!guildId) return;
    pendingSettingsSave = { guildId, config: collectConfig() };
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    saveState.textContent = 'Alterações pendentes...';
    document.querySelector('#verification-save-state').textContent = 'Salvando escolhas...';
    document.querySelector('#pix-save-state').textContent = 'Salvando equipe e cargo...';
    document.querySelector('#store-save-state').textContent = 'Salvando configuração da loja...';
    settingsSaveTimer = setTimeout(() => {
        flushPendingSettingsSave().catch(() => {});
    }, 700);
}

for (const eventName of ['input', 'change']) {
    form.addEventListener(eventName, event => {
        if (event.target.matches('input, select, textarea')) scheduleSettingsSave();
    });
}

for (const control of [
    controls.verificationChannelId,
    controls.verifiedRoleId,
    controls.futureCustomerRoleId,
    controls.customerRoleId,
    controls.pendingRoleId,
    controls.ticketStaffRoleIds,
    controls.ticketPurchaseCategoryId,
    controls.ticketSupportCategoryId,
    controls.ticketQuestionCategoryId,
]) {
    control.addEventListener('change', scheduleSettingsSave);
}

for (const control of [
    controls.storeTitle,
    controls.storeDescription,
    controls.storeField1Title,
    controls.storeField1Value,
    controls.storeField2Title,
    controls.storeField2Value,
    controls.storeField3Title,
    controls.storeField3Value,
    controls.storeField4Title,
    controls.storeField4Value,
    controls.storeImageUrl,
    controls.storeFooter,
    controls.termsAuthor,
    controls.termsTitle,
    controls.termsDescription,
    controls.termsField1Title,
    controls.termsField1Value,
    controls.termsField2Title,
    controls.termsField2Value,
    controls.termsField3Title,
    controls.termsField3Value,
    controls.termsField4Title,
    controls.termsField4Value,
    controls.termsField5Title,
    controls.termsField5Value,
    controls.termsField6Title,
    controls.termsField6Value,
    controls.termsField7Title,
    controls.termsField7Value,
    controls.termsImportantTitle,
    controls.termsImportantValue,
    controls.termsFooter,
]) {
    control.addEventListener('input', scheduleSettingsSave);
    control.addEventListener('change', scheduleSettingsSave);
}

window.addEventListener('pagehide', () => {
    if (!pendingSettingsSave) return;
    const snapshot = pendingSettingsSave;
    pendingSettingsSave = null;
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    fetch(`/api/guilds/${snapshot.guildId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot.config),
        keepalive: true,
    }).catch(() => {});
});

guildSelect.addEventListener('change', async () => {
    try {
        notice.hidden = true;
        try {
            await flushPendingSettingsSave();
        } catch {
            // Keep the save error visible, but still load the selected server's settings.
        }
        await loadGuildOptions();
    } catch (error) {
        showNotice(error.message, true);
    }
});

form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!guildSelect.value) return;
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    pendingSettingsSave = null;
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    saveState.textContent = 'Salvando...';
    try {
        const result = await saveConfigSnapshot(guildSelect.value, collectConfig());
        saveState.textContent = result.message || 'Alterações salvas.';
        showNotice(result.message);
    } catch (error) {
        saveState.textContent = 'Não foi possível salvar.';
        showNotice(error.message, true);
    } finally {
        submitButton.disabled = false;
    }
});

document.querySelector('#check-verification').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!guildSelect.value) return;
    button.disabled = true;
    try {
        await flushPendingSettingsSave();
        const result = await api(`/api/guilds/${guildSelect.value}/verification-test`, { method: 'POST' });
        const results = document.querySelector('#verification-test-results');
        results.replaceChildren(...result.checks.map(check => {
            const row = document.createElement('div');
            row.className = `verification-check ${check.ok ? 'passed' : 'failed'}`;
            const status = document.createElement('span');
            status.textContent = check.ok ? '✓' : '!';
            const label = document.createElement('span');
            label.textContent = check.name;
            row.append(status, label);
            return row;
        }));
        showNotice(result.checks.every(check => check.ok)
            ? 'Configuração da verificação pronta para testar.'
            : 'Há itens que precisam ser corrigidos antes da verificação.');
        if (result.checks.some(check => !check.ok)) notice.classList.add('error');
    } catch (error) {
        showNotice(error.message, true);
    } finally {
        button.disabled = false;
    }
});

document.querySelector('#publish-verification-test').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!guildSelect.value) return;
    button.disabled = true;
    try {
        await flushPendingSettingsSave();
        const result = await api(`/api/guilds/${guildSelect.value}/verification-panel`, { method: 'POST' });
        showNotice(`${result.message} Atenção: as reações deste painel atribuem cargos de verdade.`);
    } catch (error) {
        showNotice(error.message, true);
    } finally {
        button.disabled = false;
    }
});

async function loadMembersRoles(reset = false) {
    const guildId = guildSelect.value;
    if (!guildId) return;
    const loadMoreButton = document.querySelector('#load-more-members');
    const memberList = document.querySelector('#server-members');
    loadMoreButton.disabled = true;
    if (reset) {
        memberRows = [];
        nextMemberCursor = null;
        memberList.textContent = 'Carregando membros...';
    }
    try {
        const cursor = reset ? null : nextMemberCursor;
        const query = cursor ? `?after=${encodeURIComponent(cursor)}` : '';
        const result = await api(`/api/guilds/${guildId}/members${query}`);
        if (reset) renderServerRoles(result.roles);
        memberRows.push(...result.members);
        nextMemberCursor = result.nextAfter;
        renderServerMembers();
        document.querySelector('#members-count').textContent =
            `${memberRows.length} de ${result.totalMembers} membros carregados`;
        loadMoreButton.hidden = !nextMemberCursor;
    } catch (error) {
        if (reset) memberList.textContent = 'Não foi possível carregar os membros.';
        showNotice(error.message, true);
    } finally {
        loadMoreButton.disabled = false;
    }
}

function renderServerRoles(roles) {
    const roleList = document.querySelector('#server-roles');
    document.querySelector('#roles-count').textContent = `${roles.length} cargos`;
    roleList.replaceChildren(...roles.map(role => {
        const item = document.createElement('div');
        item.className = 'server-role';
        const name = document.createElement('strong');
        name.textContent = role.name;
        const metadata = document.createElement('small');
        metadata.textContent = `Posição ${role.position} · ID ${role.id}${role.managed ? ' · gerenciado' : ''}`;
        item.append(name, metadata);
        if (role.color && role.color !== '#000000') item.style.borderLeftColor = role.color;
        return item;
    }));
}

function renderServerMembers() {
    const memberList = document.querySelector('#server-members');
    const search = document.querySelector('#member-search').value.trim().toLocaleLowerCase();
    const filteredMembers = memberRows.filter(member =>
        `${member.displayName} ${member.username}`.toLocaleLowerCase().includes(search)
    );
    if (!filteredMembers.length) {
        memberList.textContent = memberRows.length ? 'Nenhum membro corresponde ao filtro.' : 'Nenhum membro carregado.';
        return;
    }
    memberList.replaceChildren(...filteredMembers.map(member => {
        const item = document.createElement('article');
        item.className = 'server-member';
        const identity = document.createElement('div');
        identity.className = 'server-member-identity';
        const name = document.createElement('strong');
        name.textContent = `${member.displayName}${member.bot ? ' · Bot' : ''}`;
        const username = document.createElement('small');
        username.textContent = `${member.username} · ID ${member.id}`;
        identity.append(name, username);
        const roles = document.createElement('p');
        roles.textContent = member.roles.length ? member.roles.join(', ') : 'Sem cargos';
        item.append(identity, roles);
        return item;
    }));
}

document.querySelector('#member-search').addEventListener('input', renderServerMembers);
document.querySelector('#load-more-members').addEventListener('click', () => {
    loadMembersRoles(false);
});

document.querySelector('#save-welcome-settings').addEventListener('click', () => {
    if (guildSelect.value) form.requestSubmit();
});

document.querySelector('#send-welcome-test').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!guildSelect.value) return;
    button.disabled = true;
    try {
        const result = await api(`/api/guilds/${guildSelect.value}/welcome-test`, {
            method: 'POST',
            body: JSON.stringify({
                welcomeChannelId: controls.welcomeChannelId.value,
                welcomeTitle: controls.welcomeTitle.value,
                welcomeMessage: controls.welcomeMessage.value,
                welcomeFooter: controls.welcomeFooter.value,
                welcomeGifUrl: controls.welcomeGifUrl.value,
            }),
        });
        showNotice(result.message);
    } catch (error) {
        showNotice(error.message, true);
    } finally {
        button.disabled = false;
    }
});

function setPage(pageName) {
    const page = pages[pageName] ? pageName : 'settings';
    for (const [name] of Object.entries(pages)) {
        document.querySelector(`#page-${name}`).hidden = name !== page;
    }
    for (const button of document.querySelectorAll('.nav-item[data-page]')) {
        button.classList.toggle('active', button.dataset.page === page);
    }
    pageTitle.textContent = pages[page].title;
    pageDescription.textContent = pages[page].description;
    const breadcrumb = document.querySelector('.crumb');
    breadcrumb.replaceChildren(document.createTextNode('PAINEL '));
    const separator = document.createElement('span');
    separator.textContent = '/';
    breadcrumb.append(separator, document.createTextNode(` ${pages[page].breadcrumb}`));
    if (page === 'logs') refreshLogs().catch(error => showNotice(error.message, true));
    if (page === 'ticketLogs') refreshTicketLogs().catch(error => showNotice(error.message, true));
    if (page === 'giveaways') refreshGiveaways().catch(error => showNotice(error.message, true));
    if (page === 'notes') loadNotes().catch(error => showNotice(error.message, true));
    if (page === 'membersRoles') loadMembersRoles(true);
}

document.querySelectorAll('.nav-item[data-page]').forEach(button => {
    button.addEventListener('click', () => setPage(button.dataset.page));
});

function renderLogs(logs) {
    const list = document.querySelector('#logs-list');
    const count = document.querySelector('#log-count');
    count.textContent = String(logs.length);
    count.hidden = logs.length === 0;
    if (!logs.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<span class="empty-icon">✓</span><strong>Nenhum erro registrado</strong><p>Quando ocorrer um erro, ele aparecerá aqui enquanto o bot estiver em execução.</p>';
        list.replaceChildren(empty);
        return;
    }

    const entries = logs.map(log => {
        const card = document.createElement('article');
        card.className = 'log-entry';
        const header = document.createElement('div');
        header.className = 'log-entry-header';
        const badge = document.createElement('span');
        badge.className = 'log-badge';
        badge.textContent = 'ERRO';
        const date = document.createElement('time');
        date.dateTime = log.timestamp;
        date.textContent = new Date(log.timestamp).toLocaleString('pt-BR');
        header.append(badge, date);
        const detail = document.createElement('pre');
        detail.textContent = log.message;
        card.append(header, detail);
        return card;
    });
    list.replaceChildren(...entries);
}

async function refreshLogs() {
    const result = await api('/api/logs');
    renderLogs(result.logs);
    document.querySelector('#log-refresh-state').textContent =
        `Mostrando ${result.logs.length} de ${result.count} · máx. ${result.maxErrorLogs}`;
}

function configureLogRefresh(intervalSeconds) {
    if (logRefreshTimer) clearInterval(logRefreshTimer);
    logRefreshTimer = null;
    if (intervalSeconds > 0) {
        logRefreshTimer = setInterval(() => {
            if (!document.querySelector('#page-logs:not([hidden])')) return;
            refreshLogs().catch(error => {
                document.querySelector('#log-refresh-state').textContent = error.message;
            });
        }, intervalSeconds * 1000);
    }
}

document.querySelector('#refresh-logs').addEventListener('click', async () => {
    try {
        await refreshLogs();
    } catch (error) {
        showNotice(error.message, true);
    }
});

document.querySelector('#clear-logs').addEventListener('click', async () => {
    if (!confirm('Limpar todos os erros guardados? Esta ação não pode ser desfeita.')) return;
    try {
        const result = await api('/api/logs', { method: 'DELETE' });
        await refreshLogs();
        showNotice(result.message);
    } catch (error) {
        showNotice(error.message, true);
    }
});

function renderTicketLogs(logs, warning) {
    const list = document.querySelector('#ticket-logs-list');
    if (!logs.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const title = document.createElement('strong');
        title.textContent = warning ? 'Logs indisponíveis' : 'Nenhum log de ticket encontrado';
        const description = document.createElement('p');
        description.textContent = warning || 'Quando o bot registrar tickets, os avisos e históricos aparecerão aqui.';
        empty.append(title, description);
        list.replaceChildren(empty);
        return;
    }

    const entries = logs.map(log => {
        const card = document.createElement('article');
        card.className = 'log-entry ticket-log-entry';
        const header = document.createElement('div');
        header.className = 'log-entry-header';
        const badge = document.createElement('span');
        badge.className = 'log-badge ticket-log-badge';
        badge.textContent = 'TICKET';
        const date = document.createElement('time');
        date.dateTime = log.timestamp;
        date.textContent = new Date(log.timestamp).toLocaleString('pt-BR');
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'button secondary ticket-log-delete';
        deleteButton.dataset.deleteTicketLog = log.id;
        deleteButton.textContent = 'Apagar registro';
        header.append(badge, date, deleteButton);
        const body = document.createElement('div');
        body.className = 'ticket-log-body';
        if (log.content) {
            const content = document.createElement('p');
            content.className = 'ticket-log-content';
            content.textContent = log.content;
            body.append(content);
        }
        for (const embed of log.embeds) {
            const embedCard = document.createElement('section');
            embedCard.className = 'ticket-log-embed';
            if (embed.title) {
                const title = document.createElement('strong');
                title.textContent = embed.title;
                embedCard.append(title);
            }
            if (embed.description) {
                const description = document.createElement('p');
                description.textContent = embed.description;
                embedCard.append(description);
            }
            for (const field of embed.fields) {
                const fieldElement = document.createElement('p');
                const fieldName = document.createElement('strong');
                fieldName.textContent = `${field.name}: `;
                fieldElement.append(fieldName, document.createTextNode(field.value));
                embedCard.append(fieldElement);
            }
            body.append(embedCard);
        }
        for (const attachment of log.attachments) {
            const link = document.createElement('a');
            link.href = attachment.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = `${attachment.name} (${(attachment.size / 1024).toFixed(1)} KB)`;
            body.append(link);
        }
        if (log.url) {
            const messageLink = document.createElement('a');
            messageLink.href = log.url;
            messageLink.target = '_blank';
            messageLink.rel = 'noopener noreferrer';
            messageLink.textContent = 'Abrir mensagem no Discord';
            body.append(messageLink);
        }
        card.append(header, body);
        return card;
    });
    list.replaceChildren(...entries);
}

async function refreshTicketLogs() {
    if (!guildSelect.value) return;
    const state = document.querySelector('#ticket-log-refresh-state');
    state.textContent = 'Carregando logs...';
    const result = await api(`/api/guilds/${guildSelect.value}/ticket-logs`);
    if (result.channelId) document.querySelector('#ticket-log-channel').value = result.channelId;
    renderTicketLogs(result.logs, result.warning);
    state.textContent = result.channelName
        ? `Canal #${result.channelName} · ${result.logs.length} registros completos carregados.`
        : result.warning;
}

function renderGiveaways(giveaways) {
    const list = document.querySelector('#giveaways-list');
    if (!giveaways.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const title = document.createElement('strong');
        title.textContent = 'Nenhum sorteio encontrado';
        const description = document.createElement('p');
        description.textContent = 'Os sorteios criados neste servidor aparecerão aqui.';
        empty.append(title, description);
        list.replaceChildren(empty);
        return;
    }

    list.replaceChildren(...giveaways.map(giveaway => {
        const card = document.createElement('article');
        card.className = 'log-entry ticket-log-entry';
        const header = document.createElement('div');
        header.className = 'log-entry-header';
        const badge = document.createElement('span');
        badge.className = 'log-badge ticket-log-badge';
        badge.textContent = giveaway.status === 'active' ? 'ATIVO' : 'ENCERRADO';
        const prize = document.createElement('strong');
        prize.textContent = giveaway.prize;
        const date = document.createElement('time');
        date.dateTime = new Date(giveaway.endsAt).toISOString();
        date.textContent = giveaway.status === 'active'
            ? `Termina ${new Date(giveaway.endsAt).toLocaleString('pt-BR')}`
            : `Encerrado ${new Date(giveaway.endsAt).toLocaleString('pt-BR')}`;
        header.append(badge, prize, date);

        const details = document.createElement('div');
        details.className = 'ticket-log-body';
        const overview = document.createElement('p');
        overview.textContent =
            `Responsável: ${giveaway.responsibleId} · Criado por: ${giveaway.hostTag} · ` +
            `Participantes: ${giveaway.entries.length} · Canal: ${giveaway.channelId}`;
        details.append(overview);

        const result = document.createElement('p');
        result.textContent = giveaway.winnerId
            ? `Vencedor: ${giveaway.winnerId} · Código: ${giveaway.winnerCode || 'indisponível'}`
            : giveaway.status === 'ended' ? 'Sorteio encerrado sem vencedor.' : 'O vencedor será exibido quando o sorteio terminar.';
        details.append(result);

        if (giveaway.entries.length) {
            const participantDetails = document.createElement('details');
            const summary = document.createElement('summary');
            summary.textContent = `Ver participantes (${giveaway.entries.length})`;
            const participants = document.createElement('ul');
            for (const entry of giveaway.entries) {
                const item = document.createElement('li');
                item.textContent = `${entry.userId} · código ${entry.code || 'indisponível'}`;
                participants.append(item);
            }
            participantDetails.append(summary, participants);
            details.append(participantDetails);
        }

        const messageLink = document.createElement('a');
        messageLink.href = `https://discord.com/channels/${guildSelect.value}/${giveaway.channelId}/${giveaway.messageId}`;
        messageLink.target = '_blank';
        messageLink.rel = 'noopener noreferrer';
        messageLink.textContent = 'Abrir sorteio no Discord';
        details.append(messageLink);
        card.append(header, details);
        return card;
    }));
}

async function refreshGiveaways() {
    if (!guildSelect.value) return;
    const state = document.querySelector('#giveaway-refresh-state');
    state.textContent = 'Carregando sorteios...';
    const result = await api(`/api/guilds/${guildSelect.value}/giveaways`);
    renderGiveaways(result.giveaways);
    state.textContent = `${result.giveaways.length} sorteios carregados.`;
}

document.querySelector('#ticket-logs-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-delete-ticket-log]');
    if (!button || !guildSelect.value) return;
    if (!confirm('Apagar permanentemente este registro do canal do Discord? Esta ação não pode ser desfeita.')) return;

    button.disabled = true;
    try {
        const result = await api(
            `/api/guilds/${guildSelect.value}/ticket-logs/${button.dataset.deleteTicketLog}`,
            { method: 'DELETE' },
        );
        showNotice(result.message);
        await refreshTicketLogs();
    } catch (error) {
        button.disabled = false;
        showNotice(error.message, true);
    }
});

document.querySelector('#save-ticket-log-channel').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!guildSelect.value) return;
    button.disabled = true;
    try {
        const result = await api(`/api/guilds/${guildSelect.value}/ticket-logs`, {
            method: 'PUT',
            body: JSON.stringify({
                openChannelId: document.querySelector('#ticket-log-open-channel').value,
                closeChannelId: document.querySelector('#ticket-log-channel').value,
                memberJoinChannelId: document.querySelector('#member-join-log-channel').value,
                memberLeaveChannelId: document.querySelector('#member-leave-log-channel').value,
            }),
        });
        showNotice(result.message);
        await refreshTicketLogs();
    } catch (error) {
        showNotice(error.message, true);
    } finally {
        button.disabled = false;
    }
});

document.querySelector('#refresh-ticket-logs').addEventListener('click', async () => {
    try {
        await refreshTicketLogs();
    } catch (error) {
        showNotice(error.message, true);
    }
});

document.querySelector('#refresh-giveaways').addEventListener('click', async () => {
    try {
        await refreshGiveaways();
    } catch (error) {
        document.querySelector('#giveaway-refresh-state').textContent = 'Falha ao carregar sorteios.';
        showNotice(error.message, true);
    }
});

async function loadNotes() {
    if (!guildSelect.value) return;
    const result = await api(`/api/guilds/${guildSelect.value}/notes`);
    const textarea = document.querySelector('#dashboard-notes');
    textarea.value = result.notes;
    document.querySelector('#notes-count').textContent = `${textarea.value.length} / 5000 caracteres`;
}

document.querySelector('#dashboard-notes').addEventListener('input', event => {
    document.querySelector('#notes-count').textContent = `${event.currentTarget.value.length} / 5000 caracteres`;
});

document.querySelector('#save-notes').addEventListener('click', async event => {
    if (!guildSelect.value) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const result = await api(`/api/guilds/${guildSelect.value}/notes`, {
            method: 'PUT',
            body: JSON.stringify({ notes: document.querySelector('#dashboard-notes').value }),
        });
        showNotice(result.message);
    } catch (error) {
        showNotice(error.message, true);
    } finally {
        button.disabled = false;
    }
});

document.querySelector('#preferences-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const result = await api('/api/dashboard/preferences', {
            method: 'PUT',
            body: JSON.stringify({
                refreshIntervalSeconds: Number(document.querySelector('#refresh-interval').value),
                maxErrorLogs: Number(document.querySelector('#max-error-logs').value),
            }),
        });
        configureLogRefresh(result.refreshIntervalSeconds);
        await refreshLogs();
        showNotice(result.message);
    } catch (error) {
        showNotice(error.message, true);
    } finally {
        button.disabled = false;
    }
});

async function loadPreferences() {
    const preferences = await api('/api/dashboard/preferences');
    document.querySelector('#refresh-interval').value = String(preferences.refreshIntervalSeconds);
    document.querySelector('#max-error-logs').value = String(preferences.maxErrorLogs);
    configureLogRefresh(preferences.refreshIntervalSeconds);
}

function showLoginMessage(message, isError = true) {
    const element = document.querySelector('#auth-message');
    element.textContent = message;
    element.hidden = false;
    element.classList.toggle('error', isError);
}

async function initializeDashboard() {
    const status = await api('/api/auth/status');
    const loginScreen = document.querySelector('#login-screen');
    const dashboardShell = document.querySelector('#dashboard-shell');
    const setup = document.querySelector('#oauth-setup');
    const loginButton = document.querySelector('#login-button');
    const passwordForm = document.querySelector('#password-form');
    const authResult = new URLSearchParams(window.location.search).get('auth');

    if (!status.configured) {
        loginScreen.hidden = false;
        setup.hidden = false;
        passwordForm.hidden = true;
        loginButton.hidden = true;
        setup.textContent =
            `Configure no .env: ${status.missing.join(', ')}. ` +
            'No Discord Developer Portal, configure o Client Secret e a callback /auth/callback.';
        document.querySelector('#login-description').textContent =
            'O acesso ficará disponível depois de configurar a senha e o login Discord do Owner.';
        return;
    }
    if (!status.authenticated) {
        loginScreen.hidden = false;
        passwordForm.hidden = status.passwordVerified;
        loginButton.hidden = !status.passwordVerified;
        if (status.passwordVerified) {
            document.querySelector('#login-description').textContent =
                'Senha confirmada. Agora entre na sua conta Discord de Owner.';
        }
        if (authResult === 'denied') showLoginMessage('Esta conta Discord não está autorizada como Owner.');
        else if (authResult === 'failed') showLoginMessage('A confirmação expirou ou falhou. Informe a senha e tente novamente.');
        return;
    }

    loginScreen.hidden = true;
    dashboardShell.hidden = false;
    document.querySelector('#current-user').textContent = `${status.user.username} · Owner`;
    await loadGuilds();
    await loadPreferences();
}

document.querySelector('#password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.querySelector('#password-submit');
    const input = document.querySelector('#dashboard-password');
    button.disabled = true;
    try {
        const result = await api('/auth/password', {
            method: 'POST',
            body: JSON.stringify({ password: input.value }),
        });
        form.hidden = true;
        document.querySelector('#login-button').hidden = false;
        document.querySelector('#login-description').textContent =
            'Senha confirmada. Agora entre na sua conta Discord de Owner.';
        showLoginMessage(result.message, false);
    } catch (error) {
        showLoginMessage(error.message);
    } finally {
        input.value = '';
        button.disabled = false;
    }
});

document.querySelector('#logout').addEventListener('click', async () => {
    try {
        await api('/auth/logout', { method: 'POST' });
    } finally {
        window.location.assign('/');
    }
});

initializeDashboard().catch(error => {
    document.querySelector('#login-screen').hidden = false;
    showLoginMessage(error.message);
});
