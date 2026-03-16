// Central configuration for the frontend
const CONFIG = {
    // Determine the Backend URL based on the current environment
    BACKEND_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:5000'
        : 'https://your-backend-url.onrender.com', // <-- REPLACE with your actual production backend URL

    // Add other environment-specific settings here
    DISCORD_CLIENT_ID: '1405503287129804883'
};

// Export as a global variable if needed (for non-module scripts)
window.FRONTEND_CONFIG = CONFIG;
