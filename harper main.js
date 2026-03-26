// ezik orospu evladının mainidir hiç bir allahın kulu arkamdan iş çeviremez discord : roughtfeel
"use strict";


const net = require('net');
const tls = require('tls');
const http2 = require('http2');
const fs = require('fs');
const os = require('os'); 
const { WebSocket } = require('ws');
const { performance } = require('perf_hooks');

try { os.setPriority(os.constants.priority.PRIORITY_HIGHEST); } catch {}

const SNIPER_TOKEN = "";
const GUILD_ID = "";
const HOST = "canary.discord.com";

const EDGE_IPS = [
    "162.159.137.232",
    "162.159.136.232",
    "162.159.135.232",
    "162.159.138.232",
    "104.16.58.5",
    "104.16.59.5"
];

const REQUEST_PER_SESSION = 3; 
const SESSION_POOL_SIZE = 3;   
const TEST_INTERVAL = 30000;    

process.env.UV_THREADPOOL_SIZE = 64;

const guilds = new Map();
let mfaToken = "";
let sessions = []; 
const requestTemplates = new Map();
let tlsSession = null;

function createSession(ip) {
    return new Promise((resolve) => {
        const start = performance.now();
        const session = http2.connect(`https://${HOST}`, {
            settings: { 
                headerTableSize: 65536, 
                initialWindowSize: 6291456,
                maxFrameSize: 16384 
            },
            createConnection: () => {
                const socket = net.connect({ 
                    host: ip, 
                    port: 443, 
                    noDelay: true,
                    keepAlive: true 
                });
                
                if (socket.setNoDelay) socket.setNoDelay(true);

                const tlsSocket = tls.connect({
                    socket, servername: HOST,
                    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
                    session: tlsSession, rejectUnauthorized: false,
                    ALPNProtocols: ['h2'], 
                    ciphers: 'TLS_AES_128_GCM_SHA256'
                });
                tlsSocket.on('session', (s) => { tlsSession = s; });
                return tlsSocket;
            }
        });

        session.on('error', (err) => {
            // console.error(`[Session Error] ${ip}: ${err.code}`);
        });

        session.on('connect', () => {
            const latency = performance.now() - start;
            resolve({ session, latency, ip });
        });
        
        session.on('close', () => resolve(null));
        setTimeout(() => resolve(null), 1500);
    });
}

async function refreshSessions() {
    const results = await Promise.all(EDGE_IPS.map(ip => createSession(ip)));
    const sorted = results.filter(r => r !== null).sort((a, b) => a.latency - b.latency);

    if (sorted.length === 0) return;

    const oldSessions = [...sessions];
    sessions = sorted.slice(0, SESSION_POOL_SIZE).map(s => {
        s.session.unref();
        const pingInterval = setInterval(() => {
            if (!s.session.destroyed) {
                try { s.session.ping(() => {}); } catch {}
            } else {
                clearInterval(pingInterval);
            }
        }, 6000);
        return s;
    });

    oldSessions.forEach(s => {
        if (!sessions.find(n => n.session === s.session)) {
            try { s.session.destroy(); } catch {}
        }
    });
}

function cacheRequest(vanity) {
    if (!vanity) return;
    const bodyBuffer = Buffer.from(JSON.stringify({ code: vanity }));
    const headers = {
        ':method': 'PATCH',
        ':path': `/api/v9/guilds/${GUILD_ID}/vanity-url`,
        ':authority': HOST,
        ':scheme': 'https',
        'authorization': SNIPER_TOKEN,
        'content-type': 'application/json',
        'content-length': bodyBuffer.length.toString(),
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'x-super-properties': 'eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50YnVpbGRfbnVtYmVyIjozNTU2MjR9',
    };
    if (mfaToken) headers['x-discord-mfa-authorization'] = mfaToken;
    requestTemplates.set(vanity, { headers, body: bodyBuffer });
}

function fire(vanity, detectStart) {
    const cached = requestTemplates.get(vanity);
    if (!cached || sessions.length === 0) return;

    for (const wrap of sessions) {
        const session = wrap.session;
        if (!session || session.destroyed) continue;
        
        const socket = session.socket;
        if (socket && !socket.destroyed) socket.cork(); 

        for (let j = 0; j < REQUEST_PER_SESSION; j++) {

            const req = session.request(cached.headers);

            req.on('error', (err) => {

            });

            req.on('response', (res) => {
                const now = performance.now();
                console.log(`[!] /${vanity} | ${wrap.ip} | Toplam Süre: ${(now - detectStart).toFixed(2)}ms | Status: ${res[':status']}`);
            });
            req.end(cached.body);
        }
        if (socket && !socket.destroyed) process.nextTick(() => socket.uncork());
    }
}

function connectWS(token) {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9');
    
    ws.on('message', (data) => {
        const raw = data.toString();
        if (raw.includes('GUILD_UPDATE')) {
            const detectStart = performance.now();
            try {
                const msg = JSON.parse(raw);
                const oldV = guilds.get(msg.d.id);
                if (msg.d.vanity_url_code !== oldV && oldV) fire(oldV, detectStart);
                guilds.set(msg.d.id, msg.d.vanity_url_code);
            } catch (e) {}
        } else if (raw.includes('"op":10')) {
            const msg = JSON.parse(raw);
            setInterval(() => {
                if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: null }));
            }, msg.d.heartbeat_interval * 0.9);
            ws.send(JSON.stringify({ op: 2, d: { token, intents: 1, properties: { os: 'Windows', browser: 'Chrome', device: '' } } }));
        } else if (raw.includes('READY')) {
            const msg = JSON.parse(raw);
            msg.d.guilds.forEach(g => {
                if (g.vanity_url_code) {
                    guilds.set(g.id, g.vanity_url_code);
                    cacheRequest(g.vanity_url_code);
                }
            });
            console.log(`[WS] Hazır: ${token.substring(0, 10)}...`);
        }
    });

    ws.on('error', () => {}); // WS hatalarında çökme
    ws.on('close', () => setTimeout(() => connectWS(token), 300));
}

async function main() {
    await refreshSessions();
    setInterval(refreshSessions, TEST_INTERVAL);

    setInterval(() => {
        try {
            if (fs.existsSync('mfa.txt')) {
                const m = fs.readFileSync('mfa.txt', 'utf8').trim();
                if (m && m !== mfaToken) { 
                    mfaToken = m; 
                    requestTemplates.clear(); 
                    guilds.forEach(v => cacheRequest(v)); 
                }
            }
        } catch {}
    }, 1000);

    if (fs.existsSync('list.txt')) {
        const tokens = fs.readFileSync('list.txt', 'utf8').split('\n').map(t => t.trim()).filter(t => t);
        tokens.forEach(t => connectWS(t));
    }
}

main().catch(() => {});