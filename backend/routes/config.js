const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebaseConfig');
const fetch = require('node-fetch');

function getBotApiCandidates() {
    const urlsEnv = (process.env.BOT_API_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
    const single = process.env.BOT_API_URL ? [process.env.BOT_API_URL] : [];
    const host = process.env.BOT_ALLOCATION_HOST;
    const port = process.env.BOT_ALLOCATION_PORT;
    const hp = host && port ? [`http://${host}:${port}`, `https://${host}:${port}`] : [];
    const localhost = ['http://localhost:5001'];
    const bases = [...urlsEnv, ...single, ...hp, ...localhost];
    const seen = new Set();
    return bases.filter(u => { if (seen.has(u)) return false; seen.add(u); return true; });
}

async function fetchGuildsFlexible(botApiUrl) {
    const token = process.env.DASHBOARD_API_KEY || '';
    const bases = Array.isArray(botApiUrl) ? botApiUrl : [botApiUrl];
    for (const base of bases) {
        const urls = [
            `${base}/api/guilds`,
            `${base}/api/guilds/list`,
            `${base}/api/bot/guilds/list`,
            token ? `${base}/api/guilds?token=${encodeURIComponent(token)}` : null,
            token ? `${base}/api/bot/guilds/list?token=${encodeURIComponent(token)}` : null
        ].filter(Boolean);
        for (const url of urls) {
            try {
                const res = await fetch(url, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (!res.ok) continue;
                const data = await res.json().catch(() => []);
                const guilds = Array.isArray(data) ? data
                    : Array.isArray(data.guilds) ? data.guilds
                    : [];
                const normalized = guilds.map(g => ({
                    id: g.id || g.guild_id || g.guildID,
                    name: g.name || '',
                    icon: g.icon || null
                })).filter(g => g.id);
                if (normalized.length >= 0) return normalized;
            } catch (e) {}
        }
    }
    return [];
}

router.get('/', async (req, res) => {
    try {
        const bases = getBotApiCandidates();
        const normalized = await fetchGuildsFlexible(bases);
        res.json(normalized);
    } catch (err) {
        res.json([]);
    }
});

router.get('/list', async (req, res) => {
    try {
        const bases = getBotApiCandidates();
        const normalized = await fetchGuildsFlexible(bases);
        res.json(normalized);
    } catch (err) {
        res.json([]);
    }
});
// Rate limiting map
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 5000; // 5 seconds

// Middleware: Verify Admin Permission & Ownership
async function verifyGuildAccess(req, res, next) {
    const { guildId } = req.params;
    const userId = req.headers['x-user-id']; // Sent from frontend

    if (!userId || !guildId) {
        return res.status(401).json({ error: 'Missing user or guild context' });
    }

    try {
        // Fetch user from Firebase to check cached guilds/permissions
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(403).json({ error: 'User not found in records' });
        }

        const userData = userDoc.data();
        const guild = userData.guilds?.find(g => g.id === guildId);

        // Validate Guild Ownership & Administrator permission (0x8)
        if (!guild || (guild.permissions & 0x8) !== 0x8) {
            return res.status(403).json({ error: 'Insufficient permissions or you do not own/manage this server' });
        }

        // Additional Security: Verify the user still exists in our records as a valid admin
        // (This could involve a fresh Discord API check if we wanted real-time verification)
        
        req.user = userData;
        next();
    } catch (error) {
        console.error('Guild Access Verification Error:', error);
        res.status(500).json({ error: 'Internal security verification failure' });
    }
}

// Middleware: Rate Limiting
function rateLimit(req, res, next) {
    const userId = req.headers['x-user-id'];
    const now = Date.now();
    
    if (rateLimits.has(userId)) {
        const lastUpdate = rateLimits.get(userId);
        if (now - lastUpdate < RATE_LIMIT_WINDOW) {
            return res.status(429).json({ error: 'Too many updates. Please wait a few seconds.' });
        }
    }
    
    rateLimits.set(userId, now);
    next();
}

// GET Guild Configuration
router.get('/:guildId/config', verifyGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
        // Socket-first: ask the connected bot for live state
        const io = req.app.get('socketio');
        const botId = req.app.get('primaryBotSocketId');
        let botState = null;
        if (io && botId) {
            try {
                const resp = await new Promise(resolve => {
                    io.to(botId).timeout(8000).emit('getGuildConfig', { 
                        token: process.env.DASHBOARD_WS_TOKEN, 
                        guildId 
                    }, (err, responses) => {
                        if (err && err.length) return resolve(null);
                        resolve(Array.isArray(responses) ? responses[0] : responses);
                    });
                });
                if (resp && resp.success && resp.data) {
                    botState = resp.data;
                }
            } catch (e) {}
        }

        // Fallback to Bot REST API if socket not available
        if (!botState) {
            const bases = getBotApiCandidates();
            for (const base of bases) {
                try {
                    const botRes = await fetch(`${base}/api/guilds/${guildId}/config`, {
                        headers: { 'Authorization': `Bearer ${process.env.DASHBOARD_API_KEY}` }
                    });
                    if (botRes.ok) { botState = await botRes.json(); break; }
                } catch (e) {}
            }
        }

        const configRef = db.collection('guild_configs').doc(guildId);
        const configDoc = await configRef.get();

        if (!configDoc.exists && !botState) {
            // Return default config if neither exists
            return res.json({
                prefix: '$',
                modules: {
                    moderation: false,
                    automod: false,
                    antinuke: false,
                    logging: false,
                    fun: false // Requirement: Don't auto-enable fun module, check bot first
                },
                automod: { spamLevel: 'low', linkBlock: false, capsFilter: false },
                antinuke: { roleShield: false, channelShield: false, botShield: false }
            });
        }

        // Merge bot state (MongoDB) with Firebase config, prioritizing bot state for live toggles
        const firebaseConfig = configDoc.exists ? configDoc.data() : {};
        const mergedConfig = { ...firebaseConfig, ...botState };
        
        res.json(mergedConfig);
    } catch (error) {
        console.error('Fetch Config Error:', error);
        res.status(500).json({ error: 'Failed to fetch guild configuration' });
    }
});

// GET Guild Channels (Proxied to Bot API)
router.get('/:guildId/channels', verifyGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
        // 1) Socket-first: ask the authenticated bot directly
        const io = req.app.get('socketio');
        const botId = req.app.get('primaryBotSocketId');
        if (io && botId) {
            const resp = await new Promise(resolve => {
                try {
                    io.to(botId).timeout(7000).emit('getChannels', { 
                        token: process.env.DASHBOARD_WS_TOKEN, 
                        guildId 
                    }, (err, responses) => {
                        if (err && err.length) return resolve(null);
                        resolve(Array.isArray(responses) ? responses[0] : responses);
                    });
                } catch (e) {
                    resolve(null);
                }
            });
            if (resp && resp.success && Array.isArray(resp.data)) {
                const normalized = resp.data.map(c => ({ id: c.id, name: c.name })).filter(c => c.id && c.name);
                return res.json(normalized);
            }
        }

        // 2) Fallback to Bot REST API if socket didn't respond
        const bases = getBotApiCandidates();
        for (const base of bases) {
            try {
                const botRes = await fetch(`${base}/api/guilds/${guildId}/channels`, {
                    headers: { 'Authorization': `Bearer ${process.env.DASHBOARD_API_KEY}` }
                });
                if (!botRes.ok) continue;
                const channels = await botRes.json().catch(() => []);
                return res.json(Array.isArray(channels) ? channels : []);
            } catch (e) {}
        }
        res.json([]);
    } catch (error) {
        // Graceful empty with minimal noise when bot API is offline
        res.json([]);
    }
});

// GET Guild Members (Proxied to Bot API)
router.get('/:guildId/members', verifyGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
        const bases = getBotApiCandidates();
        for (const base of bases) {
            try {
                const botRes = await fetch(`${base}/api/guilds/${guildId}/members`, {
                    headers: { 'Authorization': `Bearer ${process.env.DASHBOARD_API_KEY}` }
                });
                if (!botRes.ok) continue;
                const members = await botRes.json().catch(() => []);
                return res.json(Array.isArray(members) ? members : []);
            } catch (e) {}
        }
        return res.json([]);
    } catch (error) {
        // Fallback empty
        res.json([]);
    }
});
router.post('/:guildId/modules/:module', verifyGuildAccess, rateLimit, async (req, res) => {
    const { guildId, module } = req.params;
    const enabled = !!req.body?.enabled;
    try {
        const modKey = String(module || '').toLowerCase().replace(/[^a-z]/g, '');
        const configRef = db.collection('guild_configs').doc(guildId);
        const snap = await configRef.get();
        const base = snap.exists ? snap.data() : {};
        const modules = { ...(base.modules || {}) };
        modules[modKey] = enabled;
        const updateData = { modules, guildId, lastUpdated: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.id };
        if (modKey === 'automod' || modKey === 'automoderation') {
            updateData.automod = { ...(base.automod || {}), enabled };
        }
        await configRef.set(updateData, { merge: true });

        const io = req.app.get('socketio');
        if (io) {
            const basePayload = { guildID: guildId, guild_id: guildId, guildid: guildId, token: process.env.DASHBOARD_WS_TOKEN };
            const modulePayload = { ...basePayload, type: 'MODULE_UPDATE', module: modKey, status: enabled, enabled };
            io.emit('configUpdate', modulePayload);
            const u = req.user || {};
            io.emit('recent_log', {
                id: `${Date.now()}-mod-${modKey}`,
                type: 'MODULE_UPDATE',
                guildId,
                userId: u.id,
                userName: u.name || u.username || '',
                userAvatar: u.avatar || '',
                details: `${modKey} ${enabled ? 'enabled' : 'disabled'} via dashboard`,
                timestamp: new Date().toISOString()
            });
        }
        res.json({ success: true, module: modKey, enabled });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update module state' });
    }
});

// GET Single Module State (socket-first, fallback to stored config)
router.get('/:guildId/modules/:module', verifyGuildAccess, async (req, res) => {
    const { guildId, module } = req.params;
    const io = req.app.get('socketio');
    const botId = req.app.get('primaryBotSocketId');
    const norm = String(module || '').toLowerCase().replace(/[^a-z]/g, '');
    try {
        if (io && botId) {
            const resp = await new Promise(resolve => {
                try {
                    io.to(botId).timeout(7000).emit('getModuleState', {
                        token: process.env.DASHBOARD_WS_TOKEN,
                        guildId,
                        module: norm
                    }, (err, responses) => {
                        if (err && err.length) return resolve(null);
                        resolve(Array.isArray(responses) ? responses[0] : responses);
                    });
                } catch (e) {
                    resolve(null);
                }
            });
            if (resp && (typeof resp.enabled !== 'undefined')) {
                return res.json({ enabled: !!resp.enabled });
            }
        }
        // Fallback to stored config
        const snap = await db.collection('guild_configs').doc(guildId).get();
        let enabled = false;
        if (snap.exists) {
            const data = snap.data() || {};
            if (norm === 'automod' || norm === 'automoderation') {
                enabled = !!(data.automod?.enabled ?? data.modules?.automod);
            } else if (norm === 'antinuke') {
                enabled = !!(data.modules?.antinuke);
            } else if (data.modules && typeof data.modules[norm] !== 'undefined') {
                enabled = !!data.modules[norm];
            }
        }
        res.json({ enabled });
    } catch (e) {
        res.json({ enabled: false });
    }
});

// POST Update Guild Configuration (Sync Bridge Trigger)
router.post('/:guildId/config', verifyGuildAccess, rateLimit, async (req, res) => {
    const { guildId } = req.params;
    const newConfig = req.body;

    try {
        const configRef = db.collection('guild_configs').doc(guildId);
        
        // 1. Save to Firebase (Unified Schema)
        const updateData = {
            ...newConfig,
            guildId,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: req.user.id
        };

        await configRef.set(updateData, { merge: true });

        // 2. Trigger Sync Bridge (Push to MongoDB Bot API)
        const syncBridgeUrl = process.env.SYNC_BRIDGE_URL || 'http://localhost:5001/api/sync';
        const syncKey = process.env.SYNC_BRIDGE_KEY;

        try {
            const syncResponse = await fetch(syncBridgeUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${syncKey}`
                },
                body: JSON.stringify({
                    type: 'GUILD_CONFIG_UPDATE',
                    guildId,
                    data: updateData
                })
            });

            if (!syncResponse.ok) {
                console.warn('Sync Bridge Warning: MongoDB sync might have failed or delayed.');
            }
        } catch (syncError) {
            console.error('Sync Bridge Connection Error:', syncError);
            // We don't fail the user request, but we log the sync failure
        }

        // 3. Log Action
        await db.collection('audit_logs').add({
            action: 'CONFIG_UPDATE',
            guildId,
            userId: req.user.id,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            details: `Updated configuration for guild ${guildId}`
        });

        // 4. Broadcast via WebSocket for Live Sync (Requirement: configUpdate)
        const io = req.app.get('socketio');
        if (io) {
            console.log(`[WS DEBUG] Preparing broadcast for guild: ${guildId}`);
            
            // The core payload with multiple ID formats to ensure the bot catches it
            const basePayload = {
                guildID: guildId,      // Format 1: CamelCase
                guild_id: guildId,     // Format 2: Snake_case
                guildid: guildId,      // Format 3: lowercase
                token: process.env.DASHBOARD_WS_TOKEN
            };

            // 1. Send Prefix Update (High Priority)
            const prefixPayload = { 
                ...basePayload, 
                type: 'PREFIX_UPDATE', 
                prefix: newConfig.prefix,
                new_prefix: newConfig.prefix 
            };
            console.log(`[WS DEBUG] Emitting prefixUpdate:`, prefixPayload);
            io.emit('configUpdate', prefixPayload);
            try {
                const u = req.user || {};
                io.emit('recent_log', {
                    id: `${Date.now()}-pref`,
                    type: 'PREFIX_UPDATE',
                    guildId,
                    userId: u.id,
                    userName: u.name || u.username || '',
                    userAvatar: u.avatar || '',
                    details: `Prefix set to "${newConfig.prefix || ''}"`,
                    timestamp: new Date().toISOString()
                });
            } catch (e) {}

            // 2. Send Module Toggles (Flat format as requested originally)
            if (newConfig.modules) {
                Object.keys(newConfig.modules).forEach(moduleName => {
                    const modulePayload = {
                        ...basePayload,
                        type: 'MODULE_UPDATE',
                        module: moduleName,
                        status: newConfig.modules[moduleName],
                        enabled: newConfig.modules[moduleName]
                    };
                    console.log(`[WS DEBUG] Emitting moduleUpdate (${moduleName}):`, modulePayload);
                    io.emit('configUpdate', modulePayload);
                    try {
                        const u = req.user || {};
                        io.emit('recent_log', {
                            id: `${Date.now()}-mod-${moduleName}`,
                            type: 'MODULE_UPDATE',
                            guildId,
                            userId: u.id,
                            userName: u.name || u.username || '',
                            userAvatar: u.avatar || '',
                            details: `${moduleName} ${newConfig.modules[moduleName] ? 'enabled' : 'disabled'}`,
                            timestamp: new Date().toISOString()
                        });
                    } catch (e) {}
                });
            }

            // 3. Send Full Sync (The "Safety Net" with all data)
            const fullSyncPayload = {
                ...basePayload,
                type: 'FULL_SYNC',
                data: {
                    prefix: newConfig.prefix,
                    modules: newConfig.modules,
                    automod: newConfig.automod,
                    antinuke: newConfig.antinuke,
                    whitelist: newConfig.whitelist || []
                }
            };
            console.log(`[WS DEBUG] Emitting fullSync`);
            io.emit('configUpdate', fullSyncPayload);
            try {
                const u = req.user || {};
                io.emit('recent_log', {
                    id: `${Date.now()}-sync`,
                    type: 'FULL_SYNC',
                    guildId,
                    userId: u.id,
                    userName: u.name || u.username || '',
                    userAvatar: u.avatar || '',
                    details: 'Configuration synced to bot',
                    timestamp: new Date().toISOString()
                });
            } catch (e) {}

            // 4. Send Whitelist Update if provided
            if (newConfig.whitelist) {
                const whitelistPayload = {
                    ...basePayload,
                    type: 'WHITELIST_UPDATE',
                    whitelist: newConfig.whitelist
                };
                console.log(`[WS DEBUG] Emitting whitelistUpdate:`, whitelistPayload);
                io.emit('configUpdate', whitelistPayload);
                try {
                    const u = req.user || {};
                    io.emit('recent_log', {
                        id: `${Date.now()}-wl`,
                        type: 'WHITELIST_UPDATE',
                        guildId,
                        userId: u.id,
                        userName: u.name || u.username || '',
                        userAvatar: u.avatar || '',
                        details: `Whitelist saved (${(newConfig.whitelist || []).length} IDs)`,
                        timestamp: new Date().toISOString()
                    });
                } catch (e) {}
            }

            try {
                const u = req.user || {};
                io.emit('recent_log', {
                    id: `${Date.now()}`,
                    type: 'CONFIG_UPDATE',
                    guildId,
                    userId: req.user.id,
                    userName: u.name || u.username || '',
                    userAvatar: u.avatar || '',
                    details: 'Configuration updated',
                    timestamp: new Date().toISOString()
                });
            } catch (e) {}
        }

        res.json({ message: 'Configuration saved and sync triggered successfully' });
    } catch (error) {
        console.error('Update Config Error:', error);
        res.status(500).json({ error: 'Failed to update guild configuration' });
    }
});

module.exports = router;
