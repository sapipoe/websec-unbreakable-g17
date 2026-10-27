// Client-side cryptografie voor Unbreakable (opdracht 3).
//
// 1. Vertrouwelijkheid: one time pad in modulo 37 (A-Z, 0-9 en _ voor een spatie).
//    De sleutel is één lijn uit het codeboek dat verzender en ontvanger op voorhand uitwisselden.
// 2. Integriteit: HMAC-SHA256 over de ciphertext (en de metadata), met een aparte HMAC sleutel.
//
// Alles gebeurt in de browser. De server krijgt enkel de ciphertext, het lijnnummer en de MAC.
// De sleutels verlaten de browser nooit.

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';
const MOD = ALPHABET.length; // 37

// ------------------------------------------------------------------ tekst voorbereiden

// Zet vrije tekst om naar het alfabet van 37 tekens:
//  - kleine letters worden hoofdletters
//  - een spatie wordt _
//  - letters met accenten verliezen hun accent (é -> E, ç -> C)
// Alle andere tekens (leestekens, emoji, ...) weigeren we met een duidelijke foutmelding,
// in plaats van ze stil weg te laten. Zo verandert het bericht nooit zonder dat de verzender het weet.
export function normalizeMessage(text) {
    const cleaned = text
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // accenten weg
        .toUpperCase()
        .replace(/ /g, '_');

    const invalid = [...new Set([...cleaned].filter(ch => !ALPHABET.includes(ch)))];
    if (invalid.length) {
        throw new Error('Deze tekens kan je niet versleutelen: ' +
            invalid.map(ch => ch === '\n' ? '(enter)' : `"${ch}"`).join(' ') +
            '. Gebruik enkel letters, cijfers en spaties.');
    }
    return cleaned;
}

// Een sleutel uit het codeboek: we laten spaties en het lijnnummer ervoor weg als iemand
// de volledige lijn uit `nl` plakt (bv. "    7\tAB3_...").
export function normalizeKey(key) {
    const cleaned = key.trim().replace(/^\d+\s+/, '').toUpperCase();
    if (!/^[A-Z0-9_]+$/.test(cleaned)) {
        throw new Error('De sleutel mag enkel A-Z, 0-9 en _ bevatten.');
    }
    return cleaned;
}

// ------------------------------------------------------------------ one time pad, modulo 37

function shift(text, key, direction) {
    if (key.length < text.length) {
        throw new Error(`Het bericht (${text.length} tekens) is langer dan de sleutel (${key.length} tekens).`);
    }
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const t = ALPHABET.indexOf(text[i]);
        const k = ALPHABET.indexOf(key[i]);
        if (t < 0 || k < 0) {
            throw new Error('Ongeldig teken in bericht of sleutel.');
        }
        // + MOD zorgt dat het resultaat bij ontsleutelen nooit negatief wordt
        out += ALPHABET[(t + direction * k + MOD) % MOD];
    }
    return out;
}

// C_i = (P_i + K_i) mod 37
export function encrypt(plaintext, key) {
    return shift(plaintext, key, +1);
}

// P_i = (C_i - K_i) mod 37
export function decrypt(ciphertext, key) {
    return shift(ciphertext, key, -1);
}

// Voor de leesbaarheid: _ terug naar een spatie.
export function toReadable(plaintext) {
    return plaintext.replace(/_/g, ' ');
}

// ------------------------------------------------------------------ HMAC-SHA256 (Web Crypto)

function requireWebCrypto() {
    if (!window.isSecureContext || !window.crypto?.subtle) {
        throw new Error('Web Crypto is niet beschikbaar. Open de app via HTTPS (of localhost).');
    }
}

async function importHmacKey(secret, usage) {
    requireWebCrypto();
    if (!secret || secret.length < 16) {
        throw new Error('De HMAC sleutel moet minstens 16 tekens lang zijn.');
    }
    return crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,          // niet exporteerbaar
        [usage]);       // 'sign' bij verzenden, 'verify' bij ontvangen
}

// Wat we beschermen met de MAC. Niet enkel de ciphertext, ook wie het stuurde, naar wie,
// en met welke lijn uit het codeboek. Zo kan iemand met toegang tot de databank ook
// het lijnnummer, de afzender of de ontvanger niet ongemerkt aanpassen.
export function macInput({ sender, recipient, keyLine, body }) {
    return `${sender}|${recipient}|${keyLine}|${body}`;
}

function toHex(buffer) {
    return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
    if (!/^[0-9a-f]{64}$/i.test(hex || '')) {
        return null;
    }
    return new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));
}

export async function sign(secret, fields) {
    const key = await importHmacKey(secret, 'sign');
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(macInput(fields)));
    return toHex(mac);
}

// verify() vergelijkt in constante tijd. Zelf vergelijken met === stopt bij het eerste
// verschillende teken, en die tijdsverschillen kan een aanvaller gebruiken (timing attack).
export async function verify(secret, fields, macHex) {
    const mac = fromHex(macHex);
    if (!mac) {
        return false;
    }
    const key = await importHmacKey(secret, 'verify');
    return crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(macInput(fields)));
}
