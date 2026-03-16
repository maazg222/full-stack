const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebaseConfig');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

// Discord OAuth2 Config
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1405503287129804883';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

// Use the environment variable, but allow it to be dynamic based on the request host if needed
// However, Discord requires EXACT matches in the portal.
const getRedirectUri = (req) => {
  // Use the environment variable if available, otherwise fallback to localhost
  return process.env.DISCORD_REDIRECT_URI || 'http://localhost:5000/api/auth/discord/callback';
};

router.get('/user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'User ID required' });
    const docRef = db.collection('users').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ message: 'User not found' });
    const data = doc.data() || {};
    const founderIds = (process.env.FOUNDER_IDS || '').split(',').map(v => v.trim());
    const isFounder = founderIds.includes(id);
    const rank = isFounder ? 'founder' : (data.rank || 'member');
    const user = {
      id,
      name: data.name || data.username || 'User',
      avatar: data.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png',
      rank,
      isEnvFounder: isFounder,
      guilds: data.guilds || []
    };
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch user' });
  }
});

// Discord Login Redirect
router.get('/discord', (req, res) => {
  const state = (req.query.state || '').toLowerCase();
  const guildId = req.query.guild_id;
  const stateParam = state ? `&state=${encodeURIComponent(state)}` : '';
  
  // If guild_id is provided, include bot scopes and permissions
  const scope = guildId ? 'identify+email+guilds+bot+applications.commands' : 'identify+email+guilds';
  const permissions = guildId ? '&permissions=8' : '';
  const guildParam = (guildId && guildId !== 'new') ? `&guild_id=${guildId}` : '';
  
  const currentRedirect = getRedirectUri(req);
  console.log('Redirecting to Discord with URI:', currentRedirect);
  
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(currentRedirect)}&response_type=code&scope=${scope}${permissions}${guildParam}${stateParam}`;
  res.redirect(url);
});

// Common Callback Handler
async function handleDiscordCallback(req, res) {
  const code = req.query.code;
  console.log('Login Callback - Received code');
  
  if (!code) {
    return res.status(400).send('No code provided from Discord. Authentication failed.');
  }

  try {
    const currentRedirect = getRedirectUri(req);
    console.log(`Using redirect_uri: ${currentRedirect}`);
    
    // Exchange code for token
    const tokenParams = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: currentRedirect,
        scope: 'identify email guilds',
    });

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      body: tokenParams.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      console.error('Discord Token Exchange Error:', tokenData);
      throw new Error(`Token Exchange Error: ${tokenData.error_description || tokenData.error}`);
    }

    if (!tokenData.access_token) {
        throw new Error('Discord did not return an access token.');
    }

    // Get user data
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
    });
    const userData = await userResponse.json();
    if (!userData || userData.error || !userData.id) {
        console.error('Discord User Data Error:', userData);
        throw new Error(`Failed to fetch User Data: ${userData ? (userData.error_description || userData.error || 'Invalid user data') : 'No response'}`);
    }

    // Get user guilds
    const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
    });
    const guildsData = await guildsResponse.json();
    if (!Array.isArray(guildsData)) {
        console.error('Discord Guilds Data Error:', guildsData);
        // We don't fail the whole login if guilds fail, just use empty list
    }

    // Filter guilds with Administrator permission (0x8)
    const manageableGuilds = Array.isArray(guildsData) ? guildsData.filter(guild => (guild.permissions & 0x8) === 0x8) : [];
    
    // Check founder status
    const founderIds = (process.env.FOUNDER_IDS || '').split(',').map(id => id.trim());
    const isFounder = founderIds.includes(userData.id);

    let user;
    
    if (!db) {
        console.error('Firestore DB is not initialized!');
        // Fallback for when DB is offline - still let user login but without persistent storage
        user = {
            id: userData.id,
            name: userData.global_name || userData.username,
            avatar: userData.avatar 
              ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
              : `https://cdn.discordapp.com/embed/avatars/${(userData.discriminator || 0) % 5}.png`,
            rank: isFounder ? 'founder' : 'member',
            isEnvFounder: isFounder,
            guilds: manageableGuilds
        };
    } else {
        // Check if user exists in Firestore
        const userRef = db.collection('users').doc(userData.id);
        const userDoc = await userRef.get();
        
        if (userDoc.exists) {
          const storedData = userDoc.data();
          user = {
            id: userData.id,
            name: storedData.name || userData.global_name || userData.username,
            avatar: storedData.avatar || (userData.avatar 
            ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/${(userData.discriminator || 0) % 5}.png`),
            rank: isFounder ? 'founder' : (storedData.rank || 'member'),
            isEnvFounder: isFounder,
            guilds: manageableGuilds
          };
          
          await userRef.update({ 
            rank: isFounder ? 'founder' : (storedData.rank || 'member'),
            guilds: manageableGuilds
          });
        } else {
          user = {
            id: userData.id,
            name: userData.global_name || userData.username,
            avatar: userData.avatar 
            ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/${(userData.discriminator || 0) % 5}.png`,
            rank: isFounder ? 'founder' : 'member',
            isEnvFounder: isFounder,
            guilds: manageableGuilds
          };
          await userRef.set({
            ...user,
            email: userData.email || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
    }

    return redirectUser(req, res, user);
  } catch (err) {
    console.error('Discord Auth Error:', err);
    // Send a more user-friendly error page that also explains the cause
    res.status(500).send(`
        <div style="background:#0c0c0c; color:#ff4d4d; padding:2rem; font-family:sans-serif; border-radius:12px; border:1px solid #333; max-width:600px; margin: 4rem auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
            <h1 style="margin-top:0; font-size: 1.8rem;">Authentication Failed</h1>
            <p style="color:#aaa; line-height: 1.6;">The server encountered an error while communicating with Discord. This usually happens if your <b>Client Secret</b> is wrong or your <b>Redirect URI</b> is not set correctly in the Discord portal.</p>
            <div style="background:#1a1a1a; padding:1.2rem; border-radius:8px; color:#fff; font-family:monospace; font-size:0.95rem; margin: 1.5rem 0; border-left: 4px solid #ff4d4d;">
                <strong>Error Details:</strong><br>
                ${err.message || 'Unknown Error'}
            </div>
            <div style="margin-top: 2rem;">
                <a href="/home" style="display:inline-block; padding:12px 24px; background:#ff4d4d; color:#fff; text-decoration:none; border-radius:6px; font-weight:700; transition: opacity 0.2s;">Try Again</a>
                <p style="margin-top: 1rem; font-size: 0.8rem; color: #666;">If you are the developer, check your server console for the full error log.</p>
            </div>
        </div>
    `);
  }
}

function redirectUser(req, res, user) {
    try {
        const userJson = JSON.stringify(user);
        const hash = `#user_data=${encodeURIComponent(userJson)}`;
        const redirectPath = `http://localhost:5000/dashboard.html${hash}`;
        
        console.log('Redirecting user to:', redirectPath);

        // Standard HTML redirect to local dashboard
        res.setHeader('Content-Type', 'text/html');
        return res.send(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>Redirecting...</title>
                    <style>
                        body { background: #0c0c0c; color: white; display: flex; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; margin: 0; }
                        .loader { width: 40px; height: 40px; border: 4px solid rgba(255,255,255,0.1); border-top-color: #ff4d4d; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
                        @keyframes spin { to { transform: rotate(360deg); } }
                        .text { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.5px; opacity: 0.8; }
                    </style>
                </head>
                <body>
                    <div style="text-align: center;">
                        <div class="loader"></div>
                        <div class="text">Authenticating with Agency...</div>
                        <script>
                            // Save to localStorage immediately
                            try {
                                localStorage.setItem('agency_chat_user', decodeURIComponent("${encodeURIComponent(userJson)}"));
                            } catch (e) {}
                            
                            // Perform the redirect to the local dashboard
                            window.location.replace("${redirectPath}");
                        </script>
                    </div>
                </body>
            </html>
        `);
    } catch (err) {
        console.error('Redirect Error:', err);
        res.status(500).send('Redirect failed: ' + err.message);
    }
}

// Simplified Callback
router.get('/discord/callback', async (req, res, next) => {
  try {
    await handleDiscordCallback(req, res);
  } catch (err) {
    next(err);
  }
});

// Remove unused dashboard-callback
router.get('/discord/dashboard-callback', async (req, res, next) => {
  try {
    await handleDiscordCallback(req, res);
  } catch (err) {
    next(err);
  }
});

// Update Profile Route
router.post('/update-profile', async (req, res) => {
  try {
    const { userId, name, avatar } = req.body;
    if (!userId) return res.status(400).json({ message: 'User ID required' });

    const userRef = db.collection('users').doc(userId);
    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    if (name !== undefined) updateData.name = name;
    if (avatar !== undefined) updateData.avatar = avatar;

    await userRef.set(updateData, { merge: true });

    res.json({ message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Update Profile Error:', err);
    res.status(500).json({ message: 'Failed to update profile' });
  }
});

// Register Route
router.post('/register', async (req, res) => {
  try {
    console.log('Register request received:', req.body);
    if (!db) {
      console.error('Firebase DB not initialized');
      return res.status(500).json({ message: 'Firebase not configured on server' });
    }

    const { username, email, password } = req.body;
    
    // Check if user already exists in Firestore
    const userRef = db.collection('users');
    const emailSnapshot = await userRef.where('email', '==', email).get();
    const userSnapshot = await userRef.where('username', '==', username).get();

    if (!emailSnapshot.empty || !userSnapshot.empty) {
      console.log('User already exists');
      return res.status(400).json({ message: 'User already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Save to Firestore
    const newUser = {
      username,
      email,
      password: hashedPassword,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await userRef.add(newUser);
    console.log('User registered successfully:', docRef.id);

    res.status(201).json({ message: 'User registered successfully', id: docRef.id });
  } catch (err) {
    console.error('Registration error details:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Login Route
router.post('/login', async (req, res) => {
  try {
    console.log('Login request received:', req.body.email);
    if (!db) {
      console.error('Firebase DB not initialized');
      return res.status(500).json({ message: 'Firebase not configured on server' });
    }

    const { email, password } = req.body;

    // Find user by email in Firestore
    const userRef = db.collection('users');
    const snapshot = await userRef.where('email', '==', email).limit(1).get();

    if (snapshot.empty) {
      console.log('User not found');
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();

    // Compare password
    const isMatch = await bcrypt.compare(password, userData.password);
    if (!isMatch) {
      console.log('Password mismatch');
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Create token
    const token = jwt.sign(
      { userId: userDoc.id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    console.log('User logged in successfully:', userData.username);
    res.json({
      token,
      user: {
        id: userDoc.id,
        username: userData.username,
        email: userData.email
      }
    });
  } catch (err) {
    console.error('Login error details:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Update Rank Route
router.post('/update-rank', async (req, res) => {
  const { adminId, targetUserId, newRank } = req.body;
  if (!adminId || !targetUserId || !newRank) return res.status(400).json({ message: 'Missing fields' });

  try {
    const adminRef = db.collection('users').doc(adminId);
    const adminDoc = await adminRef.get();
    
    if (!adminDoc.exists) return res.status(403).json({ message: 'Admin not found' });
    
    const adminData = adminDoc.data();
    const founderIds = (process.env.FOUNDER_IDS || '').split(',').map(id => id.trim());
    const isFounder = founderIds.includes(adminId);
    
    const allowedRanks = ['founder', 'owner'];
    const currentRank = adminData.rank?.toLowerCase();
    
    if (!isFounder && !allowedRanks.includes(currentRank)) {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }

    const targetUserRef = db.collection('users').doc(targetUserId);
    
    // Update user rank
    await targetUserRef.set({
      rank: newRank.toLowerCase()
    }, { merge: true });

    // Update all past messages for this user
    try {
      const messagesRef = db.collection('chat_messages');
      const userMessages = await messagesRef.where('userId', '==', targetUserId).get();
      
      if (!userMessages.empty) {
        const batch = db.batch();
        userMessages.docs.forEach(doc => {
          batch.update(doc.ref, { rank: newRank.toLowerCase() });
        });
        await batch.commit();
        console.log(`Updated rank for ${userMessages.size} past messages of user ${targetUserId}`);
      }
    } catch (err) {
      console.error('Error updating past messages rank:', err);
      // We don't fail the whole request if message update fails, 
      // but the main rank is already updated above.
    }

    res.json({ message: `User rank updated to ${newRank}` });
  } catch (err) {
    console.error('Update rank error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Delete Message Route
router.post('/delete-message', async (req, res) => {
    const { userId, messageId } = req.body;
    if (!userId || !messageId) return res.status(400).json({ message: 'Missing fields' });

    try {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) return res.status(403).json({ message: 'User not found' });

        const userData = userDoc.data();
        const founderIds = (process.env.FOUNDER_IDS || '').split(',').map(id => id.trim());
        const isFounder = founderIds.includes(userId);
        const rank = userData.rank?.toLowerCase() || 'member';
        const isAdmin = isFounder || ['founder', 'owner', 'staff', 'queen'].includes(rank);

        const messageRef = db.collection('chat_messages').doc(messageId);
        const messageDoc = await messageRef.get();
        if (!messageDoc.exists) return res.status(404).json({ message: 'Message not found' });

        const messageData = messageDoc.data();

        // Permission check: Admins can delete any, users can delete own
        if (isAdmin || messageData.userId === userId) {
            // Recursive delete function for replies
            const deleteMessageAndReplies = async (id) => {
                // Find all replies to this message
                const repliesSnapshot = await db.collection('chat_messages')
                    .where('replyTo.id', '==', id)
                    .get();

                // Delete the current message
                await db.collection('chat_messages').doc(id).delete();
                
                // Emit socket event for this message
                const io = req.app.get('socketio');
                if (io) {
                    io.emit('message_deleted', id);
                }

                // Recursively delete all replies
                if (!repliesSnapshot.empty) {
                    for (const replyDoc of repliesSnapshot.docs) {
                        await deleteMessageAndReplies(replyDoc.id);
                    }
                }
            };

            await deleteMessageAndReplies(messageId);
            res.json({ message: 'Message and all replies deleted successfully' });
        } else {
            res.status(403).json({ message: 'Insufficient permissions' });
        }
    } catch (err) {
        console.error('Delete message error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Ban User (Founder-only)
router.post('/ban-user', async (req, res) => {
  try {
    const { adminId, targetUserId, reason } = req.body;
    if (!adminId || !targetUserId) {
      return res.status(400).json({ message: 'Missing fields' });
    }
    const adminRef = db.collection('users').doc(adminId);
    const adminDoc = await adminRef.get();
    if (!adminDoc.exists) return res.status(403).json({ message: 'Admin not found' });

    const founderIds = (process.env.FOUNDER_IDS || '').split(',').map(id => id.trim());
    const isFounder = founderIds.includes(adminId);
    const adminRank = (adminDoc.data()?.rank || '').toLowerCase();
    if (!isFounder && adminRank !== 'founder') {
      return res.status(403).json({ message: 'Only founders can ban users' });
    }

    const targetRef = db.collection('users').doc(targetUserId);
    await targetRef.set({
      banned: true,
      banReason: reason || 'You are banned. For unban, make a ticket in our support server.'
    }, { merge: true });

    // Optional: write a ban log
    try {
      await db.collection('ban_logs').add({
        targetUserId,
        adminId,
        reason: reason || '',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch {}

    return res.json({ message: 'User banned successfully' });
  } catch (err) {
    console.error('Ban user error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/unban-user', async (req, res) => {
  try {
    const { adminId, targetUserId } = req.body;
    if (!adminId || !targetUserId) {
      return res.status(400).json({ message: 'Missing fields' });
    }
    const adminRef = db.collection('users').doc(adminId);
    const adminDoc = await adminRef.get();
    if (!adminDoc.exists) return res.status(403).json({ message: 'Admin not found' });

    const founderIds = (process.env.FOUNDER_IDS || '').split(',').map(id => id.trim());
    const isFounder = founderIds.includes(adminId);
    const adminRank = (adminDoc.data()?.rank || '').toLowerCase();
    if (!isFounder && adminRank !== 'founder') {
      return res.status(403).json({ message: 'Only founders can unban users' });
    }

    const targetRef = db.collection('users').doc(targetUserId);
    await targetRef.set({
      banned: false,
      banReason: admin.firestore.FieldValue.delete()
    }, { merge: true });

    return res.json({ message: 'User unbanned successfully' });
  } catch (err) {
    console.error('Unban user error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/ban-status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'User ID required' });
    const userDoc = await db.collection('users').doc(id).get();
    if (!userDoc.exists) return res.json({ banned: false });
    const data = userDoc.data() || {};
    return res.json({
      banned: !!data.banned,
      reason: data.banReason || ''
    });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch ban status' });
  }
});

module.exports = router;
