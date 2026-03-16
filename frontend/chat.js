// DOM Elements
const loginOverlay = document.getElementById('login-overlay');
const discordLoginBtn = document.getElementById('discord-login');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const currentUserAvatar = document.getElementById('current-user-avatar');
const currentUserName = document.getElementById('current-user-name');
const currentUserRankText = document.getElementById('current-user-rank');
const logoutBtn = document.getElementById('logout-btn');
const emojiBtn = document.getElementById('emoji-btn');
const emojiPicker = document.getElementById('emoji-picker');
const typingIndicator = document.getElementById('typing-indicator');
const userCountText = document.getElementById('user-count-text');
const statusDot = document.getElementById('status-dot');

// Reply System Elements
const replyPreviewBar = document.getElementById('reply-preview-bar');
const replyUser = document.getElementById('reply-user');
const replyText = document.getElementById('reply-text');
const cancelReplyBtn = document.getElementById('cancel-reply-btn');

let currentReplyTo = null; // Stores { id, userName, text }
const socket = io(FRONTEND_CONFIG.BACKEND_URL);

// Profile Modal Elements
const profileModal = document.getElementById('profile-modal');
const editUsernameInput = document.getElementById('edit-username');
const editAvatarFile = document.getElementById('edit-avatar-file');
const avatarPreview = document.getElementById('avatar-preview');
const saveProfileBtn = document.getElementById('save-profile');
const cancelProfileBtn = document.getElementById('cancel-profile');
const headerProfileBtn = document.getElementById('header-profile-btn');

// User Management Modal Elements
const userManageModal = document.getElementById('user-manage-modal');
const manageUserName = document.getElementById('manage-user-name');
const assignRankSelect = document.getElementById('assign-rank-select');
const closeUserManageBtn = document.getElementById('close-user-manage');
const saveUserRankBtn = document.getElementById('save-user-rank');
const banUserBtn = document.getElementById('ban-user-btn');
const unbanUserBtn = document.getElementById('unban-user-btn');

let targetUserForManage = null;
let currentConfirmCallback = null;

// Confirmation Modal Elements
const confirmModal = document.getElementById('confirm-modal');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
const confirmActionBtn = document.getElementById('confirm-action-btn');

function showConfirm({ title, message, confirmText, confirmColor, onConfirm }) {
    confirmTitle.innerText = title || 'Are you sure?';
    confirmMessage.innerText = message || 'This action cannot be undone.';
    confirmActionBtn.innerText = confirmText || 'Confirm';
    confirmActionBtn.style.background = confirmColor || '#ff4d4d';
    
    currentConfirmCallback = onConfirm;
    confirmModal.classList.add('active');
}

confirmCancelBtn.onclick = () => {
    confirmModal.classList.remove('active');
    currentConfirmCallback = null;
};

confirmActionBtn.onclick = () => {
    if (currentConfirmCallback) currentConfirmCallback();
    confirmModal.classList.remove('active');
    currentConfirmCallback = null;
};

// Close modals when clicking outside
window.onclick = (event) => {
    if (event.target === profileModal) {
        profileModal.classList.remove('active');
    }
    if (event.target === userManageModal) {
        userManageModal.classList.remove('active');
    }
    if (event.target === confirmModal) {
        confirmModal.classList.remove('active');
        currentConfirmCallback = null;
    }
};

// State
let user = null;
let pendingAvatarBase64 = null;
let typingTimeout = null;
let lastOnlineCount = 0;

// Update UI Status
function updateStatusUI(status, count) {
    if (!userCountText) return;
    
    if (count !== undefined) {
        lastOnlineCount = count;
        userCountText.textContent = `Connected • ${count} online`;
    } else if (status === 'connected') {
        userCountText.textContent = lastOnlineCount > 0 ? `Connected • ${lastOnlineCount} online` : 'Connected';
    } else {
        userCountText.textContent = status;
    }

    if (statusDot) {
        if (status === 'connected' || count !== undefined) statusDot.style.background = '#22c55e';
        else if (status === 'Disconnected' || status === 'Reconnecting...') statusDot.style.background = '#ff4d4d';
        else statusDot.style.background = '#666';
    }
}

// Socket Events
socket.on('connect', () => {
    console.log('Connected to chat server');
    updateStatusUI('connected');
    // Show loading state for messages
    chatMessages.innerHTML = '<div style="text-align: center; opacity: 0.3; margin-top: 2rem;">Loading messages...</div>';
});

socket.on('message_deleted', (messageId) => {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
        messageElement.style.opacity = '0';
        messageElement.style.transform = 'translateX(20px)';
        setTimeout(() => messageElement.remove(), 300);
    }
});

socket.on('user_count_update', (count) => {
    updateStatusUI('connected', count);
});

socket.on('disconnect', () => {
    updateStatusUI('Reconnecting...');
});

socket.on('connect_error', (err) => {
    updateStatusUI('Server Offline');
});

socket.on('load_messages', (messages) => {
    chatMessages.innerHTML = '';
    if (Array.isArray(messages)) {
        if (messages.length === 0) {
            chatMessages.innerHTML = '<div style="text-align: center; opacity: 0.3; margin-top: 2rem;">No messages yet. Say hello!</div>';
        } else {
            messages.forEach(msg => {
                appendMessage(msg, user && msg.userId === user.id);
            });
        }
    }
});

async function deleteMessage(messageId) {
    if (!user || !messageId) return;
    
    showConfirm({
        title: 'Delete Message?',
        message: 'Are you sure you want to delete this message? This cannot be undone.',
        confirmText: 'Delete',
        confirmColor: '#ff4d4d',
        onConfirm: async () => {
            try {
                const response = await fetch('/api/auth/delete-message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: user.id,
                        messageId: messageId
                    })
                });

                const data = await response.json();
                if (!response.ok) {
                    showToast(data.message || 'Failed to delete message', 'error');
                }
            } catch (err) {
                console.error('Delete message error:', err);
                showToast('Error deleting message', 'error');
            }
        }
    });
}
const emojiMap = {
    ':blob_cool:': 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f60e/512.gif',
    ':blob_heart:': 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f973/512.gif',
    ':fire:': 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f525/512.gif',
    ':rocket:': 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f680/512.gif',
    ':crown:': 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f451/512.gif',
    ':laughing:': 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f602/512.gif',
    ':eyes:': 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f440/512.gif',
    ':party:': 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f389/512.gif',
    ':hundred:': 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f4af/512.gif',
    ':ghost:': 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f47b/512.gif'
};

// Discord Login Redirect
discordLoginBtn.addEventListener('click', () => {
    window.location.href = '/api/auth/discord';
});

function login(userData) {
    user = userData;
    // Ensure rank exists
    if (!user.rank) user.rank = 'member';
    
    // Check if user is a hardcoded founder (from env, passed in login)
    if (user.isEnvFounder) {
        user.rank = 'founder';
    }

    localStorage.setItem('agency_chat_user', JSON.stringify(user));
    
    // Update UI
    loginOverlay.style.display = 'none';
    chatInput.disabled = false;
    sendBtn.disabled = false;
    currentUserAvatar.src = user.avatar;
    currentUserName.textContent = user.name;
    if (currentUserRankText) {
        currentUserRankText.textContent = user.rank ? user.rank.charAt(0).toUpperCase() + user.rank.slice(1) : 'Member';
        currentUserRankText.style.color = getRankColor(user.rank);
    }
    if (user && user.id) {
        refreshUserProfile(user.id);
    }
}

function getRankColor(rank) {
    switch((rank || '').toLowerCase()) {
        case 'founder': return '#ff4d4d';
        case 'owner': return '#ff4d4d';
        case 'staff': return '#3b82f6';
        case 'queen': return '#ec4899';
        case 'friend': return '#10b981';
        default: return 'rgba(255,255,255,0.5)';
    }
}

// Update all badges for a specific user in the chat view
function updateUserBadgesInChat(userId, newRank) {
    const messages = document.querySelectorAll('.message');
    messages.forEach(msgDiv => {
        const userNameSpan = msgDiv.querySelector('.user-name');
        if (userNameSpan && userNameSpan.getAttribute('data-user-id') === userId) {
            // Update the data-current-rank attribute for future reference
            userNameSpan.setAttribute('data-current-rank', newRank);
            
            // Found a message from the target user, update their badge
            const badgeContainer = msgDiv.querySelector('.badge');
            if (badgeContainer) {
                let badgeHTML = '';
                const rank = newRank.toLowerCase();
                switch(rank) {
                    case 'founder':
                        badgeHTML = '<i class="fas fa-crown rank-icon"></i> Founder';
                        badgeContainer.className = 'badge badge-founder';
                        break;
                    case 'owner':
                        badgeHTML = '<i class="fas fa-shield-halved rank-icon"></i> Owner';
                        badgeContainer.className = 'badge badge-owner';
                        break;
                    case 'staff':
                        badgeHTML = '<i class="fas fa-shield rank-icon"></i> Staff';
                        badgeContainer.className = 'badge badge-staff';
                        break;
                    case 'queen':
                        badgeHTML = '<i class="fas fa-heart rank-icon"></i> Queen';
                        badgeContainer.className = 'badge badge-queen';
                        break;
                    case 'friend':
                        badgeHTML = '<i class="fas fa-handshake rank-icon"></i> Friend';
                        badgeContainer.className = 'badge badge-friend';
                        break;
                    default:
                        badgeHTML = 'Member';
                        badgeContainer.className = 'badge badge-member';
                }
                badgeContainer.innerHTML = badgeHTML;
            }
        }
    });
}

function logout() {
    user = null;
    localStorage.removeItem('agency_chat_user');
    loginOverlay.style.display = 'flex';
    chatInput.disabled = true;
    sendBtn.disabled = true;
    currentUserName.textContent = "Guest User";
    currentUserAvatar.src = "https://cdn.discordapp.com/embed/avatars/0.png";
    if (currentUserRankText) {
        currentUserRankText.textContent = "Community Member";
        currentUserRankText.style.color = 'rgba(255,255,255,0.5)';
    }
}

logoutBtn.addEventListener('click', logout);

const toastContainer = document.getElementById('toast-container');

// Toast Notification System
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'fa-info-circle';
    if (type === 'success') icon = 'fa-check-circle';
    if (type === 'error') icon = 'fa-exclamation-circle';

    toast.innerHTML = `
        <i class="fas ${icon}"></i>
        <div class="toast-content">${message}</div>
        <div class="toast-progress" style="animation: toastProgress 3s linear forwards"></div>
    `;

    toastContainer.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('show'), 10);

    // Remove after 3s
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}

function checkLogin() {
    const urlParams = new URLSearchParams(window.location.search);
    const userFromUrl = urlParams.get('user_data');
    if (userFromUrl) {
        try {
            const userData = JSON.parse(decodeURIComponent(userFromUrl));
            login(userData);
            // Clean up the URL
            window.history.replaceState({}, document.title, window.location.pathname);
        } catch (e) {
            console.error('Failed to parse user data from URL', e);
        }
    }

    const savedUser = localStorage.getItem('agency_chat_user');
    if (savedUser) {
        login(JSON.parse(savedUser));
    }
}

// Check for existing session
checkLogin();

async function refreshUserProfile(id) {
    try {
        const res = await fetch(`/api/auth/user/${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const latest = await res.json();
        if (!latest || !latest.id) return;
        user = { ...user, ...latest };
        localStorage.setItem('agency_chat_user', JSON.stringify(user));
        currentUserAvatar.src = user.avatar;
        currentUserName.textContent = user.name;
        if (currentUserRankText) {
            currentUserRankText.textContent = user.rank ? user.rank.charAt(0).toUpperCase() + user.rank.slice(1) : 'Member';
            currentUserRankText.style.color = getRankColor(user.rank);
        }
        await checkBanStatus(user.id);
    } catch (e) {}
}

async function checkBanStatus(id) {
    try {
        const res = await fetch(`/api/auth/ban-status/${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.banned) {
            user.banned = true;
            user.banReason = data.reason || '';
            localStorage.setItem('agency_chat_user', JSON.stringify(user));
            enforceBanUI(true, user.banReason);
        } else {
            user.banned = false;
            user.banReason = '';
            localStorage.setItem('agency_chat_user', JSON.stringify(user));
            enforceBanUI(false);
        }
    } catch {}
}

function enforceBanUI(banned, reason) {
    const message = reason || 'You are banned. For unban, make a ticket in the support server.';
    if (banned) {
        chatInput.disabled = true;
        sendBtn.disabled = true;
        chatInput.placeholder = message;
        typingIndicator.textContent = message;
    } else {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.placeholder = 'Message #general-chat...';
        typingIndicator.textContent = '';
    }
}

// User Management Logic
function openUserManageModal(userId, name, currentRank) {
    if (!user) return;
    
    // Admin check: Only Founders (env or rank) or Owners can manage users
    const isFounder = user.isEnvFounder || user.rank === 'founder';
    const isOwner = user.rank === 'owner';
    
    if (!isFounder && !isOwner) {
        showToast('You do not have permission to manage users', 'error');
        return;
    }

    targetUserForManage = { id: userId, name: name };
    manageUserName.textContent = `User: ${name}`;
    assignRankSelect.value = currentRank || 'member';
    userManageModal.classList.add('active');

    if (banUserBtn && unbanUserBtn) {
        const showBan = isFounder && userId !== user.id;
        banUserBtn.style.display = showBan ? 'inline-block' : 'none';
        unbanUserBtn.style.display = showBan ? 'inline-block' : 'none';
    }
}

closeUserManageBtn.addEventListener('click', () => {
    userManageModal.classList.remove('active');
    targetUserForManage = null;
});

// Remove any existing listeners to prevent duplicates
const newSaveUserRankBtn = saveUserRankBtn.cloneNode(true);
saveUserRankBtn.parentNode.replaceChild(newSaveUserRankBtn, saveUserRankBtn);

newSaveUserRankBtn.addEventListener('click', async () => {
    if (!user || !targetUserForManage) return;
    
    const newRank = assignRankSelect.value;
    
    try {
        const response = await fetch('/api/auth/update-rank', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                adminId: user.id,
                targetUserId: targetUserForManage.id,
                newRank: newRank
            })
        });

        const data = await response.json();
        if (response.ok) {
            showToast(`Success: ${data.message}`, 'success');
            
            // 1. Update local user object if we changed our own rank
            if (targetUserForManage && targetUserForManage.id === user.id) {
                user.rank = newRank;
                localStorage.setItem('agency_chat_user', JSON.stringify(user));
                
                // Update UI for the sidebar
                const sideBarRankText = document.getElementById('current-user-rank');
                if (sideBarRankText) {
                    sideBarRankText.textContent = user.rank.charAt(0).toUpperCase() + user.rank.slice(1);
                    sideBarRankText.style.color = getRankColor(user.rank);
                }
            }

            // 2. Update all badges for this user in the current chat window
            updateUserBadgesInChat(targetUserForManage.id, newRank);

            userManageModal.classList.remove('active');
            targetUserForManage = null;
        } else {
            showToast(data.message || 'Failed to update rank', 'error');
        }
    } catch (err) {
        console.error('Update rank error:', err);
        showToast('Error updating rank', 'error');
    }
});

// Profile Edit Logic
function openProfileModal() {
    if (!user) return;
    editUsernameInput.value = user.name;
    avatarPreview.src = user.avatar;
    avatarPreview.style.display = 'block';
    pendingAvatarBase64 = user.avatar;
    profileModal.classList.add('active');
}

currentUserName.addEventListener('click', openProfileModal);
headerProfileBtn.addEventListener('click', openProfileModal);

editAvatarFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        if (file.size > 2 * 1024 * 1024) {
            showToast('File is too large! Please choose an image under 2MB.', 'error');
            editAvatarFile.value = '';
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (event) => {
            pendingAvatarBase64 = event.target.result;
            avatarPreview.src = pendingAvatarBase64;
            avatarPreview.style.display = 'block';
        };
        reader.readAsDataURL(file);
    }
});

cancelProfileBtn.addEventListener('click', () => {
    profileModal.classList.remove('active');
});

saveProfileBtn.addEventListener('click', async () => {
    if (!user) return;
    
    const newName = editUsernameInput.value.trim();
    if (!newName) return;

    try {
        const response = await fetch('/api/auth/update-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: user.id,
                name: newName,
                avatar: pendingAvatarBase64 || user.avatar
            })
        });

        const data = await response.json();
        if (response.ok) {
            showToast('Profile updated successfully!', 'success');
            // Update local user data
            user.name = newName;
            if (pendingAvatarBase64) user.avatar = pendingAvatarBase64;
            localStorage.setItem('agency_chat_user', JSON.stringify(user));
            
            // Update UI
            currentUserName.textContent = user.name;
            currentUserAvatar.src = user.avatar;
            
            profileModal.classList.remove('active');
        } else {
            showToast(data.message || 'Update failed', 'error');
        }
    } catch (err) {
        console.error('Update profile error:', err);
        showToast('Error saving changes', 'error');
    }
});

if (banUserBtn) {
    banUserBtn.addEventListener('click', async () => {
        if (!user || !targetUserForManage) return;
        showConfirm({
            title: 'Ban User?',
            message: 'This will prevent the user from sending messages.',
            confirmText: 'Ban',
            confirmColor: '#ff4d4d',
            onConfirm: async () => {
                try {
                    const response = await fetch('/api/auth/ban-user', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            adminId: user.id,
                            targetUserId: targetUserForManage.id
                        })
                    });
                    const data = await response.json();
                    if (response.ok) {
                        showToast('User banned successfully', 'success');
                        userManageModal.classList.remove('active');
                    } else {
                        showToast(data.message || 'Failed to ban user', 'error');
                    }
                } catch (err) {
                    showToast('Error banning user', 'error');
                }
            }
        });
    });
}

if (unbanUserBtn) {
    unbanUserBtn.addEventListener('click', async () => {
        if (!user || !targetUserForManage) return;
        showConfirm({
            title: 'Unban User?',
            message: 'This will allow the user to chat again.',
            confirmText: 'Unban',
            confirmColor: '#10b981',
            onConfirm: async () => {
                try {
                    const response = await fetch('/api/auth/unban-user', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            adminId: user.id,
                            targetUserId: targetUserForManage.id
                        })
                    });
                    const data = await response.json();
                    if (response.ok) {
                        showToast('User unbanned successfully', 'success');
                        userManageModal.classList.remove('active');
                    } else {
                        showToast(data.message || 'Failed to unban user', 'error');
                    }
                } catch (err) {
                    showToast('Error unbanning user', 'error');
                }
            }
        });
    });
}

// Emoji Picker Logic
emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPicker.style.display = emojiPicker.style.display === 'grid' ? 'none' : 'grid';
});

document.querySelectorAll('.emoji-item').forEach(item => {
    item.addEventListener('click', () => {
        const emojiCode = item.getAttribute('data-emoji');
        chatInput.value += emojiCode + ' ';
        emojiPicker.style.display = 'none';
        chatInput.focus();
    });
});

document.addEventListener('click', () => {
    emojiPicker.style.display = 'none';
});

// Emoji Parser
function parseEmojis(text) {
    let parsedText = text;
    Object.keys(emojiMap).forEach(code => {
        const emojiImg = `<img src="${emojiMap[code]}" class="chat-emoji" alt="${code}">`;
        parsedText = parsedText.split(code).join(emojiImg);
    });
    return parsedText;
}

// Reply Logic
function setReply(messageId, userName, text) {
    currentReplyTo = { id: messageId, userName, text };
    replyUser.innerText = `Replying to ${userName}`;
    replyText.innerText = text;
    replyPreviewBar.classList.add('active');
    chatInput.focus();
}

function cancelReply() {
    currentReplyTo = null;
    replyPreviewBar.classList.remove('active');
}

cancelReplyBtn.onclick = cancelReply;

// Send Message
function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || !user) return;
    if (user.banned) {
        const msg = user.banReason || 'You are banned. For unban, make a ticket in the support server.';
        showToast(msg, 'error');
        enforceBanUI(true, msg);
        return;
    }

    const messageData = {
        text: text,
        userName: user.name,
        userAvatar: user.avatar,
        userId: user.id,
        rank: user.rank || 'member',
        replyTo: currentReplyTo // Add reply data
    };

    socket.emit('send_message', messageData);
    chatInput.value = '';
    cancelReply(); // Reset reply after sending
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

// Typing Indicator Logic
chatInput.addEventListener('input', () => {
    if (!user) return;
    socket.emit('typing', { userName: user.name, isTyping: true });
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('typing', { userName: user.name, isTyping: false });
    }, 2000);
});

// Receive Messages
socket.on('receive_message', (msg) => {
    appendMessage(msg, msg.userId === user?.id);
});

socket.on('user_typing', (data) => {
    if (data.isTyping) {
        typingIndicator.textContent = `${data.userName} is typing...`;
    } else {
        typingIndicator.textContent = '';
    }
});
// Ban notice from server
socket.on('ban_notice', (payload) => {
    const reason = payload && payload.reason ? payload.reason : 'You are banned. For unban, make a ticket in the support server.';
    if (user) {
        user.banned = true;
        localStorage.setItem('agency_chat_user', JSON.stringify(user));
    }
    enforceBanUI(true, reason);
    showToast(reason, 'error');
});

function appendMessage(msg, isOwn) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isOwn ? 'own' : ''}`;
    if (msg.id) messageDiv.setAttribute('data-message-id', msg.id);
    
    const parsedText = parseEmojis(msg.text);
    
    // Rank rendering logic
    let badgeHTML = '';
    const rank = (msg.rank || 'member').toLowerCase();
    
    switch(rank) {
        case 'founder':
            badgeHTML = '<span class="badge badge-founder"><i class="fas fa-crown rank-icon"></i> Founder</span>';
            break;
        case 'owner':
            badgeHTML = '<span class="badge badge-owner"><i class="fas fa-shield-halved rank-icon"></i> Owner</span>';
            break;
        case 'staff':
            badgeHTML = '<span class="badge badge-staff"><i class="fas fa-shield rank-icon"></i> Staff</span>';
            break;
        case 'queen':
            badgeHTML = '<span class="badge badge-queen"><i class="fas fa-heart rank-icon"></i> Queen</span>';
            break;
        case 'friend':
            badgeHTML = '<span class="badge badge-friend"><i class="fas fa-handshake rank-icon"></i> Friend</span>';
            break;
        default:
            badgeHTML = '<span class="badge badge-member">Member</span>';
    }
    
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    
    // Permission for delete button
    const userRank = (user?.rank || 'member').toLowerCase();
    const isEnvFounder = user?.isEnvFounder;
    const canDeleteAny = isEnvFounder || ['founder', 'owner', 'staff', 'queen'].includes(userRank);
    const canDeleteThis = canDeleteAny || (user && msg.userId === user.id);

    const deleteBtnHTML = (canDeleteThis && msg.id) ? `
        <button class="delete-msg-btn" onclick="event.stopPropagation(); deleteMessage('${msg.id}')" title="Delete Message">
            <i class="fas fa-trash-alt"></i>
        </button>
    ` : '';

    const replyBtnHTML = msg.id ? `
        <button class="reply-msg-btn" onclick="event.stopPropagation(); setReply('${msg.id}', '${msg.userName.replace(/'/g, "\\'")}', '${msg.text.replace(/'/g, "\\'").replace(/\n/g, " ")}')" title="Reply">
            <i class="fas fa-reply"></i>
        </button>
    ` : '';

    let replyQuoteHTML = '';
    if (msg.replyTo) {
        const parentExists = document.querySelector(`[data-message-id="${msg.replyTo.id}"]`);
        const parentUserName = parentExists ? msg.replyTo.userName : 'Deleted User';
        const parentText = parentExists ? msg.replyTo.text : 'Original message was deleted';
        
        replyQuoteHTML = `
            <div class="message-reply-quote" onclick="scrollToMessage('${msg.replyTo.id}')">
                <div class="reply-badge">@ ${parentUserName}</div>
                <div style="opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${parentText}</div>
            </div>
        `;
    }

    messageDiv.innerHTML = `
        <img src="${msg.userAvatar}" class="message-avatar">
        <div class="message-content">
            <div class="message-header">
                <span class="user-name" data-user-id="${msg.userId}" data-user-name="${msg.userName}" data-current-rank="${msg.rank || 'member'}">
                    <span class="name-text">${msg.userName}</span> ${badgeHTML}
                    <span class="time-text" style="font-size: 0.65rem; opacity: 0.4; font-weight: 400; margin-left: 4px;">${time}</span>
                </span>
                <div style="display: flex; gap: 4px;">
                    ${replyBtnHTML}
                    ${deleteBtnHTML}
                </div>
            </div>
            ${replyQuoteHTML}
            <div class="message-text">${parsedText}</div>
        </div>
    `;

    // Add click listener for rank management (Admins/Owners only)
    const nameText = messageDiv.querySelector('.name-text');
    nameText.style.cursor = 'pointer';
    nameText.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentUserRank = (user?.rank || 'member').toLowerCase();
        if (['founder', 'owner'].includes(currentUserRank) || user?.isEnvFounder) {
            openUserManageModal(
                msg.userId,
                msg.userName,
                msg.rank || 'member'
            );
        }
    });
    
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function scrollToMessage(messageId) {
    const element = document.querySelector(`[data-message-id="${messageId}"]`);
    if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.style.transition = 'background 0.5s';
        const originalBg = element.style.background;
        element.style.background = 'rgba(255, 77, 77, 0.2)';
        setTimeout(() => {
            element.style.background = originalBg;
        }, 2000);
    } else {
        showToast('Message not found or too old', 'info');
    }
}
