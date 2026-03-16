// Navbar Scroll Effect
window.addEventListener('scroll', () => {
    const navbar = document.querySelector('.navbar');
    if (window.scrollY > 50) {
        navbar.classList.add('scrolled');
    } else {
        navbar.classList.remove('scrolled');
    }
});

// Intersection Observer for Smooth Reveals
const revealOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('active');
            revealObserver.unobserve(entry.target);
        }
    });
}, revealOptions);

// Initialize Reveal Animations
document.querySelectorAll('.feature-card, .stat-item, .hero h1, .hero p, .hero-btns').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(30px)';
    el.style.transition = 'all 0.8s cubic-bezier(0.16, 1, 0.3, 1)';
    revealObserver.observe(el);
});

// Counter Animation Logic
const startCounter = (el) => {
    const target = parseInt(el.getAttribute('data-target'));
    const duration = 2000; // 2 seconds
    const increment = target / (duration / 16);
    let current = 0;

    const update = () => {
        current += increment;
        if (current < target) {
            el.innerText = Math.ceil(current) + (target === 99 ? '%' : '+');
            requestAnimationFrame(update);
        } else {
            el.innerText = target + (target === 99 ? '%' : '+');
        }
    };
    update();
};

// Update Intersection Observer to handle counters
const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            startCounter(entry.target);
            counterObserver.unobserve(entry.target);
        }
    });
}, { threshold: 0.5 });

document.querySelectorAll('.counter').forEach(counter => {
    counterObserver.observe(counter);
});

// Add CSS for active state via JS to keep it clean
const style = document.createElement('style');
style.textContent = `
    .feature-card.active, .stat-item.active, .hero h1.active, .hero p.active, .hero-btns.active {
        opacity: 1 !important;
        transform: translateY(0) !important;
    }
`;
document.head.appendChild(style);

// Button Click Feedback
document.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('mousedown', () => {
        btn.style.transform = 'scale(0.95)';
    });
    btn.addEventListener('mouseup', () => {
        btn.style.transform = 'translateY(-2px) scale(1)';
    });
});

// Smart Dashboard routing: prefer Dashboard once ever accessed or bot invited
document.addEventListener('DOMContentLoaded', () => {
    const dashLinks = Array.from(document.querySelectorAll('a')).filter(a => a.textContent.trim().toLowerCase() === 'dashboard');
    dashLinks.forEach(link => {
        link.addEventListener('click', async (e) => {
            e.preventDefault();
            const hasDash = (() => { try { return localStorage.getItem('has_dashboard') === '1'; } catch { return false; } })();
            const postAfterInvite = (() => { try { return localStorage.getItem('post_after_invite') === 'dashboard'; } catch { return false; } })();
            const goDashboard = () => { window.location.href = 'dashboard.html'; };
            const goInvite = () => { window.location.href = 'dashboard'; };
            if (postAfterInvite) { try { localStorage.removeItem('post_after_invite'); } catch {} goDashboard(); return; }
            let timedOut = false;
            const to = setTimeout(() => { timedOut = true; hasDash ? goDashboard() : goInvite(); }, 3500);
            try {
                const res = await fetch(`${FRONTEND_CONFIG.BACKEND_URL}/api/bot/guilds/list`, { cache: 'no-store' });
                clearTimeout(to);
                if (!res.ok) return hasDash ? goDashboard() : goInvite();
                const data = await res.json().catch(() => []);
                const hasServers = Array.isArray(data) && data.length > 0;
                if (hasServers) return goDashboard();
                if (hasDash) return goDashboard();
                return goInvite();
            } catch {
                clearTimeout(to);
                return hasDash ? goDashboard() : goInvite();
            }
        });
    });
});
