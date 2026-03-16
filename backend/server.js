const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// DEBUG: Log ALL io.emit calls for configUpdate
const originalIoEmit = io.emit;
io.emit = function(event, ...args) {
  if (event === 'configUpdate') {
    console.log(`[IO BROADCAST] ${event}:`, JSON.stringify(args[0], null, 2));
  }
  return originalIoEmit.apply(this, [event, ...args]);
};
const PORT = process.env.PORT || 5000;

const bodyParser = require('body-parser');

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

app.use((req, res, next) => {
  if (req.url.includes('/api/bugs')) {
    console.log(`[BUG-DEBUG] ${req.method} ${req.url} - Content-Length: ${req.headers['content-length']}`);
  }
  next();
});

// Socket.io Real-time Chat
const { db } = require('./firebaseConfig');

let onlineUsers = new Set();
let authenticatedBots = new Set();
let primaryBotSocketId = null;
let lastBotStats = {
  online: false,
  latency: 0,
  guild_count: 0,
  uptime: 'Offline'
};

io.on('connection', (socket) => {
  console.log('User connected to socket');
  onlineUsers.add(socket.id);
  io.emit('user_count_update', onlineUsers.size);

  // Send current bot stats to newly connected user
  socket.emit('bot_status_update', lastBotStats);

  // DEBUG: Log all outgoing events to this socket
  const originalEmit = socket.emit;
  socket.emit = function(event, ...args) {
    if (event === 'configUpdate') {
      console.log(`[SOCKET OUT] To ${socket.id}: ${event}`, JSON.stringify(args[0], null, 2));
    }
    return originalEmit.apply(this, [event, ...args]);
  };

  // Bot Authentication Logic
  socket.on('bot_auth', (data) => {
    const { token } = data;
    if (token === process.env.DASHBOARD_WS_TOKEN) {
      console.log(`Bot authenticated: ${socket.id}`);
      authenticatedBots.add(socket.id);
      primaryBotSocketId = socket.id;
      try { app.set('primaryBotSocketId', primaryBotSocketId); app.set('botOnline', true); } catch (e) {}
      lastBotStats.online = true;
      socket.emit('auth_success', { message: 'Authenticated successfully' });
      io.emit('bot_status_update', lastBotStats);
    } else {
      console.log(`Bot authentication failed for: ${socket.id}`);
      socket.emit('auth_failure', { error: 'Invalid secret token' });
      socket.disconnect();
    }
  });

  // Bot Status Update from Python Bot
   socket.on('bot_stats_push', (data) => {
     const { token } = data;
     
     // Auto-authenticate if token is provided in the stats push
     if (token === process.env.DASHBOARD_WS_TOKEN) {
       if (!authenticatedBots.has(socket.id)) {
         console.log(`Bot auto-authenticated via stats push: ${socket.id}`);
         authenticatedBots.add(socket.id);
         primaryBotSocketId = socket.id;
         try { app.set('primaryBotSocketId', primaryBotSocketId); app.set('botOnline', true); } catch (e) {}
       }
     }

     if (!authenticatedBots.has(socket.id)) {
       console.log(`Unauthorized stats push attempt from: ${socket.id}`);
       return;
     }
     
     console.log(`Received bot stats: Latency=${data.latency}ms, Guilds=${data.guild_count}`);
     
     lastBotStats = {
       online: true,
       latency: data.latency || 0,
       guild_count: data.guild_count || 0,
       uptime: data.uptime || '0s'
     };
     
     // Broadcast to all dashboard users
     io.emit('bot_status_update', lastBotStats);
   });

  // Proxy dashboard 'getGuilds' to the authenticated bot (ack style)
  socket.on('getGuilds', (payload, ack) => {
    try {
      if (!payload || !payload.userId) {
        return typeof ack === 'function' && ack({ success: false, error: 'Missing userId' });
      }
      if (!primaryBotSocketId || !authenticatedBots.has(primaryBotSocketId)) {
        return typeof ack === 'function' && ack({ success: false, error: 'Bot offline' });
      }
      io.to(primaryBotSocketId).timeout(8000).emit('getGuilds', payload, (err, responses) => {
        if (err && err.length) {
          return typeof ack === 'function' && ack({ success: false, error: 'Bot timeout' });
        }
        if (typeof ack === 'function') {
          const res = Array.isArray(responses) ? responses[0] : responses;
          if (res && res.success && Array.isArray(res.data)) {
            const data = res.data.map(g => ({
              id: g.id || g.guild_id || g.guildID,
              name: g.name || '',
              icon: g.icon || null
            })).filter(g => g.id);
            ack({ success: true, data });
          } else {
            ack({ success: false, error: (res && res.error) || 'Unknown error' });
          }
        }
      });
    } catch (e) {
      if (typeof ack === 'function') ack({ success: false, error: 'Proxy error' });
    }
  });

  // Proxy dashboard 'getMembers' to bot
  socket.on('getMembers', (payload, ack) => {
    try {
      if (!payload || !payload.guildId) {
        return typeof ack === 'function' && ack({ success: false, error: 'Missing guildId' });
      }
      if (!primaryBotSocketId || !authenticatedBots.has(primaryBotSocketId)) {
        return typeof ack === 'function' && ack({ success: false, error: 'Bot offline' });
      }
      io.to(primaryBotSocketId).timeout(10000).emit('getMembers', payload, (err, responses) => {
        if (err && err.length) {
          return typeof ack === 'function' && ack({ success: false, error: 'Bot timeout' });
        }
        const res = Array.isArray(responses) ? responses[0] : responses;
        if (typeof ack === 'function') {
          if (res && res.success && Array.isArray(res.data)) {
            const data = res.data.map(m => ({
              id: m.id || (m.user && m.user.id) || '',
              username: m.username || m.name || (m.user && m.user.username) || '',
              nick: m.nick || m.nickname || '',
              avatar: m.avatar || (m.user && m.user.avatar) || ''
            })).filter(m => m.id);
            ack({ success: true, data });
          } else {
            ack({ success: false, error: (res && res.error) || 'Unknown error' });
          }
        }
      });
    } catch (e) {
      if (typeof ack === 'function') ack({ success: false, error: 'Proxy error' });
    }
  });

  // Proxy dashboard 'getChannels' to bot
  socket.on('getChannels', (payload, ack) => {
    try {
      if (!payload || !payload.guildId) {
        return typeof ack === 'function' && ack({ success: false, error: 'Missing guildId' });
      }
      if (!primaryBotSocketId || !authenticatedBots.has(primaryBotSocketId)) {
        return typeof ack === 'function' && ack({ success: false, error: 'Bot offline' });
      }
      io.to(primaryBotSocketId).timeout(8000).emit('getChannels', payload, (err, responses) => {
        if (err && err.length) {
          return typeof ack === 'function' && ack({ success: false, error: 'Bot timeout' });
        }
        const res = Array.isArray(responses) ? responses[0] : responses;
        if (typeof ack === 'function') {
          if (res && res.success && Array.isArray(res.data)) {
            const data = res.data.map(c => ({
              id: c.id,
              name: c.name
            })).filter(c => c.id && c.name);
            ack({ success: true, data });
          } else {
            ack({ success: false, error: (res && res.error) || 'Unknown error' });
          }
        }
      });
    } catch (e) {
      if (typeof ack === 'function') ack({ success: false, error: 'Proxy error' });
    }
  });

  // Proxy dashboard 'getModuleState' to bot
  socket.on('getModuleState', (payload, ack) => {
    try {
      const norm = (payload && payload.module ? String(payload.module) : '').toLowerCase().replace(/[^a-z]/g,'');
      if (!payload || !payload.guildId || !norm) {
        return typeof ack === 'function' && ack({ success: false, error: 'Missing parameters' });
      }
      if (!primaryBotSocketId || !authenticatedBots.has(primaryBotSocketId)) {
        return typeof ack === 'function' && ack({ success: false, error: 'Bot offline' });
      }
      io.to(primaryBotSocketId).timeout(7000).emit('getModuleState', { ...payload, module: norm }, (err, responses) => {
        if (err && err.length) {
          return typeof ack === 'function' && ack({ success: false, error: 'Bot timeout' });
        }
        const res = Array.isArray(responses) ? responses[0] : responses;
        if (typeof ack === 'function') {
          if (res && (typeof res.enabled !== 'undefined')) {
            ack({ success: true, enabled: !!res.enabled });
          } else {
            ack({ success: false, error: (res && res.error) || 'Unknown error' });
          }
        }
      });
    } catch (e) {
      if (typeof ack === 'function') ack({ success: false, error: 'Proxy error' });
    }
  });

  // Proxy dashboard 'getGuildConfig' to bot
  socket.on('getGuildConfig', (payload, ack) => {
    try {
      if (!payload || !payload.guildId) {
        return typeof ack === 'function' && ack({ success: false, error: 'Missing guildId' });
      }
      if (!primaryBotSocketId || !authenticatedBots.has(primaryBotSocketId)) {
        return typeof ack === 'function' && ack({ success: false, error: 'Bot offline' });
      }
      io.to(primaryBotSocketId).timeout(8000).emit('getGuildConfig', payload, (err, responses) => {
        if (err && err.length) {
          return typeof ack === 'function' && ack({ success: false, error: 'Bot timeout' });
        }
        const res = Array.isArray(responses) ? responses[0] : responses;
        if (typeof ack === 'function') {
          if (res && res.success && res.data) {
            ack({ success: true, data: res.data });
          } else {
            ack({ success: false, error: (res && res.error) || 'Unknown error' });
          }
        }
      });
    } catch (e) {
      if (typeof ack === 'function') ack({ success: false, error: 'Proxy error' });
    }
  });

  // Bot -> Dashboard: Realtime module state push (e.g., antinuke toggled via command)
  socket.on('module_state_push', (data) => {
    try {
      const { token, guildId, module, enabled } = data || {};
      const authed = authenticatedBots.has(socket.id) || (token && token === process.env.DASHBOARD_WS_TOKEN);
      if (!authed || !guildId || !module) return;
      const payload = {
        guildId: String(guildId),
        module: String(module),
        enabled: Boolean(enabled),
        timestamp: new Date().toISOString()
      };
      io.emit('module_state_update', payload);
      // Also reflect in recent dashboard logs for transparency
      io.emit('recent_log', {
        id: `${Date.now()}-module-${module}`,
        type: 'MODULE_UPDATE',
        guildId: payload.guildId,
        userId: 'BOT',
        userName: 'HITMAN Bot',
        userAvatar: '',
        details: `${module} ${payload.enabled ? 'enabled' : 'disabled'} via bot command`,
        timestamp: payload.timestamp
      });
    } catch (e) {}
  });

  if (db) {
    db.collection('chat_messages').orderBy('timestamp', 'asc').limitToLast(50).get().then(snapshot => {
      const messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      socket.emit('load_messages', messages);
    });
    (async () => {
      try {
        const snap = await db.collection('audit_logs').orderBy('timestamp', 'desc').limit(20).get();
        const base = snap.docs.map(doc => {
          const d = doc.data() || {};
          return {
            id: doc.id,
            type: d.action || d.type || 'UNKNOWN',
            guildId: d.guildId || d.guild_id || '',
            userId: d.userId || d.user_id || '',
            details: d.details || '',
            timestamp: d.timestamp ? (d.timestamp.toDate ? d.timestamp.toDate().toISOString() : d.timestamp) : new Date().toISOString()
          };
        });
        const uids = Array.from(new Set(base.map(l => l.userId).filter(Boolean)));
        let userMap = {};
        if (uids.length) {
          const gets = await Promise.all(uids.map(id => db.collection('users').doc(id).get().then(d => ({ id, d })).catch(() => null)));
          gets.forEach(x => {
            if (x && x.d && x.d.exists) {
              const u = x.d.data() || {};
              userMap[x.id] = { name: u.name || u.username || '', avatar: u.avatar || '' };
            }
          });
        }
        const enriched = base.map(l => ({
          ...l,
          userName: (userMap[l.userId] && userMap[l.userId].name) || '',
          userAvatar: (userMap[l.userId] && userMap[l.userId].avatar) || ''
        }));
        socket.emit('recent_logs_snapshot', enriched);
      } catch (e) {}
    })();
  }

  socket.on('typing', (data) => {
    socket.broadcast.emit('user_typing', data);
  });

  socket.on('send_message', async (data) => {
    try {
      const userId = data && data.userId;
      if (!userId) return;
      
      if (db) {
        try {
          const userDoc = await db.collection('users').doc(userId).get();
          if (userDoc.exists) {
            const u = userDoc.data() || {};
            if (u.banned) {
              const reason = u.banReason || 'You are banned. For unban, make a ticket in our support server.';
              socket.emit('ban_notice', { reason });
              return;
            }
          }
        } catch (e) {}
      }

      const newMessage = {
        ...data,
        replyTo: data.replyTo || null,
        timestamp: new Date().toISOString()
      };

      if (db) {
        try {
          await db.collection('chat_messages').add(newMessage);
        } catch (err) {
          console.error('Error saving message to Firestore:', err);
        }
      }

      io.emit('receive_message', newMessage);
    } catch (e) {
      console.error('send_message error:', e);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
    onlineUsers.delete(socket.id);
    if (authenticatedBots.has(socket.id)) {
      authenticatedBots.delete(socket.id);
      if (primaryBotSocketId === socket.id) {
        primaryBotSocketId = null;
        try { app.set('primaryBotSocketId', null); app.set('botOnline', false); } catch (e) {}
      }
      lastBotStats.online = false;
      io.emit('bot_status_update', lastBotStats);
    }
    io.emit('user_count_update', onlineUsers.size);
  });
});

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Redirect *.html -> clean path BEFORE static middleware
app.get(/(.+)\\.html$/i, (req, res) => {
  const page = req.params[0];
  res.redirect(301, page.startsWith('/') ? page : `/${page}`);
});

// Static assets
app.use(express.static(path.join(__dirname, '../frontend')));

// Root redirect to /home
app.get('/', (req, res) => res.redirect('/home'));

// Serve clean URLs for pages; skip if the segment contains a dot (assets)
app.get('/:page', (req, res, next) => {
  if (req.params.page.includes('.')) return next();
  const filePath = path.join(__dirname, '../frontend', `${req.params.page}.html`);
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) return next();
    res.sendFile(filePath);
  });
});

// Routes
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is working!' });
});
app.set('socketio', io); // Share io with routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/bot/guilds', require('./routes/config'));

app.get('/api/socket-token', (req, res) => {
  res.json({ token: process.env.DASHBOARD_WS_TOKEN || '' });
});

// Sync Bridge API Endpoint (Internal/Secure)
// This endpoint receives updates from the dashboard and triggers MongoDB sync
app.post('/api/sync', async (req, res) => {
  const { type, guildId, data } = req.body;
  const authHeader = req.headers.authorization;
  
  if (!authHeader || authHeader !== `Bearer ${process.env.SYNC_BRIDGE_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized sync attempt' });
  }

  console.log(`Sync Bridge: Received ${type} for guild ${guildId}`);

  try {
    // 1. In a real scenario, this would push to MongoDB
    // const mongoDb = getMongoConnection();
    // await mongoDb.collection('guilds').updateOne({ guildId }, { $set: data }, { upsert: true });

    // 2. Notify the Python bot via its API if it's listening
    const botApiUrl = process.env.BOT_API_URL || 'http://localhost:5001';
    await fetch(`${botApiUrl}/api/sync-notify`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DASHBOARD_API_KEY}`
      },
      body: JSON.stringify({ type, guildId })
    }).catch(err => console.log('Bot notify skipped (offline)'));

    res.json({ success: true, message: 'Sync processed successfully' });
  } catch (error) {
    console.error('Sync Error:', error);
    res.status(500).json({ error: 'Sync processing failed' });
  }
});

// Bot Status Route
app.get('/api/bot/status', async (req, res) => {
  res.json(lastBotStats);
});

app.post('/api/bot/module-state', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader || authHeader !== `Bearer ${process.env.DASHBOARD_WS_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { guildId, module, enabled, userId, userName, userAvatar } = req.body || {};
    if (!guildId || !module) return res.status(400).json({ error: 'Missing parameters' });
    const payload = {
      guildId: String(guildId),
      module: String(module),
      enabled: Boolean(enabled),
      timestamp: new Date().toISOString()
    };
    io.emit('module_state_update', payload);
    io.emit('recent_log', {
      id: `${Date.now()}-module-${module}`,
      type: 'MODULE_UPDATE',
      guildId: payload.guildId,
      userId: userId || 'BOT',
      userName: userName || 'HITMAN Bot',
      userAvatar: userAvatar || '',
      details: `${module} ${payload.enabled ? 'enabled' : 'disabled'} via bot command`,
      timestamp: payload.timestamp
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Bug Reports API
app.get('/api/bugs', async (req, res) => {
  try {
    if (!db) {
      return res.json([]); // Return empty array if DB not ready
    }
    const snapshot = await db.collection('bugs').orderBy('timestamp', 'desc').get();
    const bugs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(bugs);
  } catch (error) {
    console.error('Error fetching bugs:', error);
    res.status(500).json({ error: 'Failed to fetch bugs' });
  }
});

app.post('/api/bugs', async (req, res) => {
  console.log(`[POST /api/bugs] Received request. Body keys: ${Object.keys(req.body).join(', ')}`);
  try {
    if (!db) {
      console.error('Firestore not initialized. Cannot save bug report.');
      return res.status(500).json({ error: 'Database not initialized on server. Check serviceAccountKey.json' });
    }

    const report = req.body;
    
    // Basic validation
    if (!report.title || !report.description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }

    // Clean undefined values for Firestore
    const cleanReport = {};
    Object.keys(report).forEach(key => {
      const val = report[key];
      if (val !== undefined && val !== null) {
        cleanReport[key] = val;
      } else {
        cleanReport[key] = ""; 
      }
    });

    console.log(`Saving bug report: "${cleanReport.title}" by ${cleanReport.username} (Media: ${cleanReport.media ? (cleanReport.media.startsWith('data:') ? 'Base64(' + cleanReport.media.length + ')' : cleanReport.media) : 'None'})`);
    const docRef = await db.collection('bugs').add(cleanReport);
    console.log(`Bug report successfully saved with ID: ${docRef.id}`);
    try {
      io.emit('recent_log', {
        id: docRef.id,
        type: 'BUG_REPORT',
        guildId: cleanReport.guildId || '',
        userId: cleanReport.userId || '',
        userName: cleanReport.username || '',
        userAvatar: cleanReport.avatar || '',
        details: `Bug: ${cleanReport.title}`,
        timestamp: new Date().toISOString()
      });
    } catch (e) {}
    res.json({ success: true, id: docRef.id });
  } catch (error) {
    console.error('CRITICAL Error saving bug to Firestore:', error);
    res.status(500).json({ error: `Firestore Error: ${error.message}` });
  }
});

app.delete('/api/bugs/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const { id } = req.params;
    const userRank = req.headers['x-user-rank'];
    const userId = req.headers['x-user-id'];

    if (!userRank || !userId) {
      return res.status(401).json({ error: 'Unauthorized: User information missing' });
    }

    const rank = userRank.toLowerCase();
    if (rank !== 'founder' && rank !== 'owner') {
      return res.status(403).json({ error: 'Forbidden: Only Founders and Owners can delete reports' });
    }

    console.log(`Deleting bug report: ${id} by ${userId} (${userRank})`);
    
    // Verify document exists before deleting (optional but good for debugging)
    const doc = await db.collection('bugs').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Bug report not found' });
    }

    await db.collection('bugs').doc(id).delete();
    console.log(`Bug report ${id} deleted successfully`);
    
    res.json({ success: true, message: 'Bug report permanently removed from database' });
  } catch (error) {
    console.error('Error deleting bug:', error);
    res.status(500).json({ error: `Server Error: ${error.message}` });
  }
});

// Proxy for Bot API to handle CORS and auth
app.use('/api/bot', async (req, res) => {
  // Extract the path after /api/bot
  const apiPath = req.url.startsWith('/') ? req.url.substring(1) : req.url;
  const botApiUrl = process.env.BOT_API_URL || 'http://localhost:5001';
  const apiKey = process.env.DASHBOARD_API_KEY;

  try {
    const url = `${botApiUrl}/api/${apiPath}`;
    console.log(`Proxying ${req.method} request to: ${url}`);
    
    const fetchOptions = {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, fetchOptions);
    const contentType = response.headers.get('content-type');
    
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      res.status(response.status).json(data);
    } else {
      const text = await response.text();
      res.status(response.status).send(text);
    }
  } catch (error) {
    console.error('Bot API Proxy Error:', error);
    res.status(500).json({ error: 'Failed to communicate with Bot API' });
  }
});

// 404 handler at the very end
app.use((req, res) => {
  const notFound = path.join(__dirname, '../frontend/404.html');
  if (fs.existsSync(notFound)) return res.status(404).sendFile(notFound);
  return res.status(404).send('Not Found');
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('GLOBAL ERROR:', err);
  res.status(500).send(`
    <div style="background:#0c0c0c; color:#ff4d4d; padding:2rem; font-family:sans-serif; border-radius:12px; border:1px solid #333; max-width:600px; margin: 4rem auto;">
        <h1 style="margin-top:0;">Server Error</h1>
        <p style="color:#aaa;">An unexpected error occurred on the server.</p>
        <div style="background:#1a1a1a; padding:1rem; border-radius:8px; color:#fff; font-family:monospace; font-size:0.9rem; margin: 1.5rem 0;">
            ${err.message || err}
        </div>
        <a href="/home" style="display:inline-block; padding:10px 20px; background:#ff4d4d; color:#fff; text-decoration:none; border-radius:6px; font-weight:700;">Back to Home</a>
    </div>
  `);
});

// Start server
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Real-time Chat with Socket.io active');
});
