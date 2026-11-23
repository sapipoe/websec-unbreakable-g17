// Praat met de API. Alles wat de SPA weet, komt van hier.
//
// Opdracht 4: wie je bent, komt van Keycloak (OpenID Connect, authorization code flow + PKCE).
// keycloak-js doet de flow: code_verifier maken, code_challenge = SHA-256(verifier) meesturen,
// de code na de redirect inwisselen voor tokens, en de tokens op tijd vernieuwen.
// De tokens blijven enkel in het geheugen van deze pagina, niet in localStorage.

import Keycloak from '../lib/keycloak-js/keycloak.js';

const keycloak = new Keycloak({
    url: location.origin + '/auth',   // Keycloak zit achter BunkerWeb op /auth
    realm: 'unbreakable',
    clientId: 'unbreakable-spa',
});

// Na de login stuurt Keycloak de browser terug naar exact dit adres ("Valid redirect URIs").
const REDIRECT_URI = location.origin + '/';

// Vroeger stond je naam in localStorage. Dat gebruiken we niet meer.
localStorage.removeItem('unbreakable_user');

export async function initAuth() {
    await keycloak.init({
        onLoad: 'check-sso',     // al ingelogd bij Keycloak? Dan kom je zonder wachtwoord terug.
        pkceMethod: 'S256',      // PKCE met SHA-256, zoals ingesteld bij de client
        responseMode: 'query',   // de code komt in ?code=..., want # gebruiken we voor de schermen
        checkLoginIframe: false, // geen verborgen iframe dat de sessie blijft controleren
        redirectUri: REDIRECT_URI,
    });
}

export function login() {
    return keycloak.login({ redirectUri: REDIRECT_URI });
}

export function logout() {
    return keycloak.logout({ redirectUri: REDIRECT_URI });
}

// Wie ben je? Dat staat in het access token:
// sub is je identiteit (dat gebruikt de API), preferred_username is enkel om te tonen.
export function currentUser() {
    if (!keycloak.authenticated) {
        return null;
    }
    return { id: keycloak.tokenParsed.sub, name: keycloak.tokenParsed.preferred_username };
}

async function call(method, path, body) {
    // Verloopt het access token binnen 30 seconden? Dan eerst een nieuw halen met het refresh token.
    try {
        await keycloak.updateToken(30);
    } catch {
        // Ook de sessie bij Keycloak is verlopen: opnieuw inloggen.
        await login();
        throw new Error('Je sessie is verlopen. Log opnieuw in.');
    }

    // Het access token gaat mee in elke call. De API controleert het en haalt er je sub uit.
    const headers = { Authorization: 'Bearer ' + keycloak.token };
    const options = { method, headers };

    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const response = await fetch('/api' + path, options);
    if (!response.ok) {
        const detail = response.status === 400 || response.status === 409 ? ': ' + await response.text() : '';
        throw new Error(`${method} ${path} gaf ${response.status}${detail}`);
    }

    const type = response.headers.get('Content-Type') || '';
    return type.includes('application/json') ? response.json() : response.text();
}

export const api = {
    users: () => call('GET', '/users'),
    inbox: (from) => call('GET', '/messages' + (from ? '?from=' + encodeURIComponent(from) : '')),
    search: (q) => call('GET', '/messages/search?q=' + encodeURIComponent(q)),
    message: (id) => call('GET', '/messages/' + id),
    send: (message) => call('POST', '/messages', message),
    remove: (id) => call('DELETE', '/messages/' + id),
    exportJson: () => call('GET', '/messages/export'),
};
