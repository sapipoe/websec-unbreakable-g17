// De schermen van Unbreakable. Navigeren gebeurt met het deel na # in de URL.

import { api, currentUser, initAuth, login, logout } from './api.js';
import * as otp from './crypto.js';

const app = document.getElementById('app');

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function formatDate(value) {
    return new Date(value).toLocaleString('nl-BE', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

function showWho() {
    const user = currentUser();
    const who = document.getElementById('who');
    who.innerHTML = user
        ? `Je bent <strong>${escapeHtml(user.name)}</strong> (<a href="#" id="logout">uitloggen</a>)`
        : '';
    if (user) {
        document.getElementById('logout').addEventListener('click', (event) => {
            event.preventDefault();
            logout();
        });
    }
}

// Opdracht 4: de API werkt met de sub uit het token (een UUID). Om namen te tonen,
// halen we de lijst gebruikers op en zoeken we bij elke sub de leesbare naam.
async function loadUsers() {
    const users = await api.users();
    const names = new Map(users.map(u => [u.id, u.username]));
    return { users, nameOf: (id) => names.get(id) || 'onbekend' };
}

// ------------------------------------------------------------------ inloggen

function renderLogin() {
    const user = currentUser();
    app.innerHTML = `
        <div class="text-center mb-5">
            <h1 class="display-4">Unbreakable</h1>
            <p class="lead">Berichten die niemand anders kan lezen. Dat is toch de bedoeling.</p>
        </div>
        <div class="row justify-content-center">
            <div class="col-md-5 text-center">
                ${user
                    ? `<p>Je bent ingelogd als <strong>${escapeHtml(user.name)}</strong>.</p>
                       <a href="#/inbox" class="btn btn-primary">Naar je inbox</a>`
                    : `<p>Log in met je account om je berichten te lezen.</p>
                       <button id="login" class="btn btn-primary">Inloggen</button>`}
            </div>
        </div>`;

    if (!user) {
        // Naar de loginpagina van Keycloak. Daarna komt de browser terug met een code.
        document.getElementById('login').addEventListener('click', () => login());
    }
}

// ------------------------------------------------------------------ inbox

async function renderInbox(params) {
    const user = currentUser();
    const q = params.get('q') || '';
    const from = params.get('from') || '';

    const { nameOf } = await loadUsers();
    const all = await api.inbox();
    const senders = [...new Set(all.map(m => m.sender))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const found = q ? await api.search(q) : all;
    const messages = found.filter(m => !from || m.sender === from);

    app.innerHTML = `
        <h1>Inbox van ${escapeHtml(user.name)}</h1>
        <p>
            <a href="#/nieuw" class="btn btn-primary">Nieuw bericht</a>
            <button id="export" class="btn btn-outline-secondary">Exporteer als JSON</button>
        </p>
        <form id="filter" class="mb-3">
            <div class="form-row align-items-end">
                <div class="col-auto">
                    <label for="from">Van</label>
                    <select id="from" class="form-control">
                        <option value="">Iedereen</option>
                        ${senders.map(s => `<option value="${escapeHtml(s)}" ${s === from ? 'selected' : ''}>${escapeHtml(nameOf(s))}</option>`).join('')}
                    </select>
                </div>
                <div class="col-auto">
                    <label for="q">Zoeken</label>
                    <input id="q" class="form-control" value="${escapeHtml(q)}" />
                </div>
                <div class="col-auto">
                    <button type="submit" class="btn btn-secondary">Filter</button>
                </div>
            </div>
        </form>
        <p id="searched"></p>
        <div id="list"></div>`;

    if (q) {
        window.jQuery('#searched').html('Je zocht naar: ' + q);
    }

    const rows = messages.map(m => `
        <tr>
            <td>${escapeHtml(nameOf(m.sender))}</td>
            <td><a href="#/bericht/${m.id}">${m.subject}</a></td>
            <td>${formatDate(m.sentAt)}</td>
        </tr>`).join('');

    document.getElementById('list').innerHTML = messages.length
        ? `<table class="table">
               <thead><tr><th>Van</th><th>Onderwerp</th><th>Verzonden</th></tr></thead>
               <tbody>${rows}</tbody>
           </table>`
        : '<p class="text-muted">Geen berichten.</p>';

    document.getElementById('filter').addEventListener('submit', (event) => {
        event.preventDefault();
        const next = new URLSearchParams();
        const newQ = document.getElementById('q').value;
        const newFrom = document.getElementById('from').value;
        if (newQ) next.set('q', newQ);
        if (newFrom) next.set('from', newFrom);
        location.hash = '#/inbox' + (next.toString() ? '?' + next.toString() : '');
    });

    document.getElementById('export').addEventListener('click', async () => {
        const data = await api.exportJson();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'inbox.json';
        link.click();
        URL.revokeObjectURL(link.href);
    });
}

// ------------------------------------------------------------------ bericht lezen

async function renderMessage(id) {
    const { nameOf } = await loadUsers();
    const m = await api.message(id);

    app.innerHTML = `
        <h1>${m.subject}</h1>
        <dl class="row">
            <dt class="col-sm-2">Van</dt><dd class="col-sm-10">${escapeHtml(nameOf(m.sender))}</dd>
            <dt class="col-sm-2">Aan</dt><dd class="col-sm-10">${escapeHtml(nameOf(m.recipient))}</dd>
            <dt class="col-sm-2">Verzonden</dt><dd class="col-sm-10">${formatDate(m.sentAt)}</dd>
        </dl>
        <h5>Versleuteld bericht</h5>
        <div class="card mb-3"><div class="card-body message-body text-monospace" id="body"></div></div>

        <div id="decrypt-area">
            <h5>Ontsleutelen</h5>
            <p class="text-muted">Lijn <strong id="keyline"></strong> uit het codeboek. Je sleutels blijven in je browser.</p>
            <form id="decrypt" class="mb-3" autocomplete="off">
                <div class="form-group">
                    <label for="otpkey">Sleutel (lijn uit het codeboek)</label>
                    <input id="otpkey" type="password" class="form-control text-monospace" required />
                </div>
                <div class="form-group">
                    <label for="mackey">HMAC sleutel</label>
                    <input id="mackey" type="password" class="form-control text-monospace" required />
                </div>
                <button type="submit" class="btn btn-primary">Controleren en ontsleutelen</button>
            </form>
            <div id="result"></div>
        </div>
        <p>
            <button id="delete" class="btn btn-outline-danger">Verwijderen</button>
            <a href="#/inbox" class="btn btn-link">Terug naar je inbox</a>
        </p>`;

    document.getElementById('body').textContent = m.body;
    document.getElementById('keyline').textContent = m.keyLine;

    const result = document.getElementById('result');
    document.getElementById('decrypt').addEventListener('submit', async (event) => {
        event.preventDefault();
        result.innerHTML = '';
        try {
            // Eerst de MAC controleren, pas daarna ontsleutelen (verify-then-decrypt).
            const ok = await otp.verify(document.getElementById('mackey').value,
                { sender: m.sender, recipient: m.recipient, keyLine: m.keyLine, body: m.body }, m.mac);
            if (!ok) {
                result.innerHTML = `<div class="alert alert-danger"><strong>MAC klopt niet.</strong>
                    Het bericht is onderweg of in de databank gewijzigd, of je HMAC sleutel is fout.
                    We tonen het bericht niet.</div>`;
                return;
            }
            const key = otp.normalizeKey(document.getElementById('otpkey').value);
            const plain = otp.toReadable(otp.decrypt(m.body, key));
            result.innerHTML = `<div class="alert alert-success"><strong>MAC is geldig.</strong> Het bericht:</div>
                <div class="card mb-3"><div class="card-body message-body" id="plain"></div></div>`;
            document.getElementById('plain').textContent = plain;
        } catch (error) {
            result.innerHTML = `<div class="alert alert-danger">${escapeHtml(error.message)}</div>`;
        }
    });

    document.getElementById('delete').addEventListener('click', async () => {
        if (confirm('Ben je zeker dat je dit bericht wil verwijderen?')) {
            await api.remove(id);
            location.hash = '#/inbox';
        }
    });
}

// ------------------------------------------------------------------ bericht versturen

async function renderNew() {
    const { users } = await loadUsers();

    app.innerHTML = `
        <h1>Nieuw bericht</h1>
        <p class="text-muted">Van: ${escapeHtml(currentUser().name)}</p>
        <div class="row">
            <div class="col-md-8">
                <form id="compose">
                    <div class="form-group">
                        <label for="recipient">Aan</label>
                        <select id="recipient" class="form-control" required>
                            <option value="">Kies een ontvanger</option>
                            ${users.map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.username)}</option>`).join('')}
                        </select>
                        <small class="form-text text-muted">Staat iemand er niet bij? Die moet eerst één keer inloggen.</small>
                    </div>
                    <div class="form-group">
                        <label for="subject">Onderwerp</label>
                        <input id="subject" class="form-control" required maxlength="100" />
                        <small class="form-text text-danger">Het onderwerp wordt niet versleuteld. Zet er niets geheims in.</small>
                    </div>
                    <div class="form-group">
                        <label for="text">Bericht</label>
                        <textarea id="text" class="form-control" rows="3" required maxlength="40"></textarea>
                        <small class="form-text text-muted">Letters, cijfers en spaties. Maximaal zo lang als je sleutel (40 tekens).</small>
                    </div>
                    <div class="form-row">
                        <div class="form-group col-md-3">
                            <label for="keyline">Lijn nr.</label>
                            <input id="keyline" type="number" class="form-control" required min="1" max="9999" />
                        </div>
                        <div class="form-group col-md-9">
                            <label for="otpkey">Sleutel (die lijn uit het codeboek)</label>
                            <input id="otpkey" type="password" class="form-control text-monospace" required autocomplete="off" />
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="mackey">HMAC sleutel</label>
                        <input id="mackey" type="password" class="form-control text-monospace" required autocomplete="off" />
                    </div>
                    <div id="error"></div>
                    <button type="submit" class="btn btn-primary">Versleutelen en versturen</button>
                    <a href="#/inbox" class="btn btn-link">Annuleren</a>
                </form>
            </div>
        </div>`;

    document.getElementById('compose').addEventListener('submit', async (event) => {
        event.preventDefault();
        const error = document.getElementById('error');
        error.innerHTML = '';
        try {
            const plain = otp.normalizeMessage(document.getElementById('text').value);
            const key = otp.normalizeKey(document.getElementById('otpkey').value);
            const message = {
                sender: currentUser().id,                          // je sub; de API neemt die zelf uit het token
                recipient: document.getElementById('recipient').value, // de sub van de ontvanger
                subject: document.getElementById('subject').value,
                keyLine: Number(document.getElementById('keyline').value),
                body: otp.encrypt(plain, key),     // enkel de ciphertext gaat naar de server
            };
            message.mac = await otp.sign(document.getElementById('mackey').value, message);
            await api.send(message);
            location.hash = '#/inbox';
        } catch (e) {
            error.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
        }
    });
}

// ------------------------------------------------------------------ over

function renderAbout() {
    app.innerHTML = `
        <h1>Over Unbreakable</h1>
        <p>Unbreakable is een berichtenapp. Je stuurt een bericht naar iemand, en enkel die persoon kan het lezen.
           Dat is tenminste het doel.</p>
        <p>Deze versie is de starter app van het vak Cyber Security Advanced aan AP Hogeschool.
           Ze werkt, maar is nog helemaal niet veilig. Doorheen het semester maken jullie ze beter.</p>
        <p>De app bestaat uit twee delen: deze single page app in je browser, en een API op de server.
           Bekijk de developer tools van je browser om te zien wat er over en weer gaat.</p>
        <p class="text-danger">Gebruik deze app enkel in je eigen labomgeving en nooit met echte gegevens.</p>`;
}

// ------------------------------------------------------------------ navigatie

async function route() {
    showWho();

    const [path, query] = (location.hash || '#/').slice(1).split('?');
    const params = new URLSearchParams(query || '');

    try {
        if (path === '/' || path === '') {
            return renderLogin();
        }
        if (path === '/over') {
            return renderAbout();
        }
        if (!currentUser()) {
            location.hash = '#/';
            return;
        }
        if (path === '/inbox') {
            return await renderInbox(params);
        }
        if (path === '/nieuw') {
            return await renderNew();
        }
        const match = path.match(/^\/bericht\/(\d+)$/);
        if (match) {
            return await renderMessage(match[1]);
        }
        app.innerHTML = '<p>Deze pagina bestaat niet.</p>';
    } catch (error) {
        app.innerHTML = `<div class="alert alert-danger">Er liep iets mis: ${escapeHtml(error.message)}</div>`;
    }
}

// Opdracht 4: eerst kijken of je bent ingelogd (of net terugkomt van Keycloak met een code),
// pas daarna de schermen tonen.
try {
    await initAuth();
} catch (error) {
    app.innerHTML = `<div class="alert alert-danger">Inloggen is nu niet mogelijk: ${escapeHtml(String(error?.message || error))}</div>`;
}
window.addEventListener('hashchange', route);
route();
