// ===================== DATA MANAGER =====================
// Uses localStorage to persist all data

const DB_KEYS = {
    users: 'betmgr_users',
    currentUser: 'betmgr_current_user',
    bets: 'betmgr_bets',
    transactions: 'betmgr_transactions',
};

const DEFAULT_BALANCE = 0.00;

const DataManager = {
    // ---- USERS ----
    getUsers() {
        return JSON.parse(localStorage.getItem(DB_KEYS.users) || '[]');
    },
    saveUsers(users) {
        localStorage.setItem(DB_KEYS.users, JSON.stringify(users));
    },
    getUserById(id) {
        return this.getUsers().find(u => u.id === id);
    },
    getUserByEmail(email) {
        return this.getUsers().find(u => u.email.toLowerCase() === email.toLowerCase());
    },
    createUser(name, email, password) {
        const users = this.getUsers();
        if (this.getUserByEmail(email)) return { error: 'E-mail já cadastrado.' };
        const user = {
            id: 'u_' + Date.now(),
            name: name.trim(),
            email: email.trim().toLowerCase(),
            password: password,
            balance: DEFAULT_BALANCE,
            createdAt: new Date().toISOString(),
            avatar: name.trim().charAt(0).toUpperCase(),
        };
        users.push(user);
        this.saveUsers(users);
        return { user };
    },
    updateUser(id, updates) {
        const users = this.getUsers();
        const idx = users.findIndex(u => u.id === id);
        if (idx === -1) return false;
        users[idx] = { ...users[idx], ...updates };
        this.saveUsers(users);
        if (this.getCurrentUser()?.id === id) {
            localStorage.setItem(DB_KEYS.currentUser, JSON.stringify(users[idx]));
        }
        return users[idx];
    },
    updateBalance(userId, delta) {
        const users = this.getUsers();
        const idx = users.findIndex(u => u.id === userId);
        if (idx === -1) return false;
        users[idx].balance = parseFloat((users[idx].balance + delta).toFixed(2));
        if (users[idx].balance < 0) users[idx].balance = 0;
        this.saveUsers(users);
        localStorage.setItem(DB_KEYS.currentUser, JSON.stringify(users[idx]));
        return users[idx];
    },

    // ---- SESSION ----
    getCurrentUser() {
        return JSON.parse(localStorage.getItem(DB_KEYS.currentUser) || 'null');
    },
    setCurrentUser(user) {
        localStorage.setItem(DB_KEYS.currentUser, JSON.stringify(user));
    },
    logout() {
        localStorage.removeItem(DB_KEYS.currentUser);
    },

    // ---- BETS ----
    getBets() {
        return JSON.parse(localStorage.getItem(DB_KEYS.bets) || '[]');
    },
    getUserBets(userId) {
        return this.getBets().filter(b => b.userId === userId);
    },
    getBetById(id) {
        return this.getBets().find(b => b.id === id);
    },
    saveBets(bets) {
        localStorage.setItem(DB_KEYS.bets, JSON.stringify(bets));
    },
    createBet(userId, data) {
        const bets = this.getBets();
        const bet = {
            id: 'b_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            userId,
            ...data,
            status: 'pending',
            type: 'single',
            unique: true,
            createdAt: new Date().toISOString(),
        };
        bets.push(bet);
        this.saveBets(bets);
        this.updateBalance(userId, -parseFloat(data.amount));
        this.addTransaction(userId, {
            type: 'bet',
            description: `Aposta Única: ${data.title}`,
            amount: -parseFloat(data.amount),
            betId: bet.id,
        });
        return bet;
    },

    // Multiple bet: selections = [{ title, category, selection, odds }]
    createMultipleBet(userId, data) {
        const bets = this.getBets();
        // totalOdds = product of all selection odds
        const totalOdds = data.selections.reduce((acc, s) => acc * parseFloat(s.odds), 1);
        const bet = {
            id: 'bm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            userId,
            title: data.title,
            amount: parseFloat(data.amount),
            odds: parseFloat(totalOdds.toFixed(2)),
            selections: data.selections,
            notes: data.notes || '',
            status: 'pending',
            type: 'multiple',
            unique: false,
            createdAt: new Date().toISOString(),
        };
        bets.push(bet);
        this.saveBets(bets);
        this.updateBalance(userId, -parseFloat(data.amount));
        this.addTransaction(userId, {
            type: 'bet_multiple',
            description: `Múltipla: ${data.title}`,
            amount: -parseFloat(data.amount),
            betId: bet.id,
        });
        return bet;
    },
    resolveBet(betId, result) {
        const bets = this.getBets();
        const idx = bets.findIndex(b => b.id === betId);
        if (idx === -1) return false;
        bets[idx].status = result; // 'won' or 'lost'
        bets[idx].resolvedAt = new Date().toISOString();
        const bet = bets[idx];
        if (result === 'won') {
            const winnings = parseFloat((bet.amount * bet.odds).toFixed(2));
            this.updateBalance(bet.userId, winnings);
            this.addTransaction(bet.userId, {
                type: 'win',
                description: `Ganho: ${bet.title}`,
                amount: winnings,
                betId: betId,
            });
        }
        this.saveBets(bets);
        return bets[idx];
    },
    cancelBet(betId) {
        const bets = this.getBets();
        const idx = bets.findIndex(b => b.id === betId);
        if (idx === -1) return false;
        if (bets[idx].status !== 'pending') return false;
        bets[idx].status = 'cancelled';
        bets[idx].resolvedAt = new Date().toISOString();
        const bet = bets[idx];
        // Refund
        this.updateBalance(bet.userId, parseFloat(bet.amount));
        this.addTransaction(bet.userId, {
            type: 'refund',
            description: `Reembolso: ${bet.title}`,
            amount: parseFloat(bet.amount),
            betId: betId,
        });
        this.saveBets(bets);
        return bets[idx];
    },

    // ---- TRANSACTIONS ----
    getTransactions() {
        return JSON.parse(localStorage.getItem(DB_KEYS.transactions) || '[]');
    },
    getUserTransactions(userId) {
        return this.getTransactions().filter(t => t.userId === userId).reverse();
    },
    addTransaction(userId, data) {
        const txs = this.getTransactions();
        const tx = {
            id: 'tx_' + Date.now(),
            userId,
            ...data,
            createdAt: new Date().toISOString(),
        };
        txs.push(tx);
        localStorage.setItem(DB_KEYS.transactions, JSON.stringify(txs));
        return tx;
    },
    deposit(userId, amount) {
        const amt = parseFloat(amount);
        if (isNaN(amt) || amt <= 0) return false;
        this.updateBalance(userId, amt);
        this.addTransaction(userId, {
            type: 'deposit',
            description: 'Depósito',
            amount: amt,
        });
        return true;
    },
    withdraw(userId, amount) {
        const amt = parseFloat(amount);
        const user = this.getUserById(userId);
        if (!user || isNaN(amt) || amt <= 0 || user.balance < amt) return false;
        this.updateBalance(userId, -amt);
        this.addTransaction(userId, {
            type: 'withdraw',
            description: 'Saque',
            amount: -amt,
        });
        return true;
    },

    // ---- STATS ----
    getUserStats(userId) {
        const bets = this.getUserBets(userId);
        const singles = bets.filter(b => b.type !== 'multiple');
        const multiples = bets.filter(b => b.type === 'multiple');
        const total = bets.length;
        const totalSingles = singles.length;
        const totalMultiples = multiples.length;
        const pending = bets.filter(b => b.status === 'pending').length;
        const won = bets.filter(b => b.status === 'won').length;
        const lost = bets.filter(b => b.status === 'lost').length;
        const cancelled = bets.filter(b => b.status === 'cancelled').length;
        const totalInvested = bets.filter(b => b.status !== 'cancelled').reduce((s, b) => s + parseFloat(b.amount), 0);
        const totalWon = bets.filter(b => b.status === 'won').reduce((s, b) => s + (b.amount * b.odds), 0);
        const winRate = total > 0 ? ((won / (won + lost)) * 100 || 0) : 0;
        const roi = totalInvested > 0 ? (((totalWon - totalInvested) / totalInvested) * 100) : 0;
        return { total, totalSingles, totalMultiples, pending, won, lost, cancelled, totalInvested, totalWon, winRate, roi };
    },
};

// ===================== AUTH =====================
const Auth = {
    requireAuth() {
        const user = DataManager.getCurrentUser();
        if (!user) {
            window.location.href = '/';
            return null;
        }
        return user;
    },
    login(email, password) {
        const user = DataManager.getUserByEmail(email);
        if (!user) return { error: 'E-mail não encontrado.' };
        if (user.password !== password) return { error: 'Senha incorreta.' };
        // Refresh from DB
        const freshUser = DataManager.getUserById(user.id);
        DataManager.setCurrentUser(freshUser);
        return { user: freshUser };
    },
    register(name, email, password) {
        if (!name || name.trim().length < 2) return { error: 'Nome deve ter pelo menos 2 caracteres.' };
        if (!email || !/\S+@\S+\.\S+/.test(email)) return { error: 'E-mail inválido.' };
        if (!password || password.length < 6) return { error: 'Senha deve ter pelo menos 6 caracteres.' };
        const result = DataManager.createUser(name, email, password);
        if (result.error) return result;
        DataManager.setCurrentUser(result.user);
        return result;
    },
};

// ===================== TOAST =====================
const Toast = {
    container: null,
    init() {
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'toast-container';
            document.body.appendChild(this.container);
        }
    },
    show(msg, sub = '', type = 'info', duration = 3500) {
        this.init();
        const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><div class="toast-text"><div class="toast-msg">${msg}</div>${sub ? `<div class="toast-sub">${sub}</div>` : ''}</div>`;
        this.container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('removing');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    },
    success(msg, sub) { this.show(msg, sub, 'success'); },
    error(msg, sub) { this.show(msg, sub, 'error'); },
    warning(msg, sub) { this.show(msg, sub, 'warning'); },
    info(msg, sub) { this.show(msg, sub, 'info'); },
};

// ===================== UTILS =====================
const Utils = {
    fmt(amount) {
        return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount);
    },
    fmtDate(iso) {
        return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    },
    fmtDateShort(iso) {
        return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    },
    statusBadge(status) {
        const map = {
            pending: '<span class="badge badge-warning"><span class="badge-dot"></span>Pendente</span>',
            won: '<span class="badge badge-success"><span class="badge-dot"></span>Ganhou</span>',
            lost: '<span class="badge badge-danger"><span class="badge-dot"></span>Perdeu</span>',
            cancelled: '<span class="badge badge-muted"><span class="badge-dot"></span>Cancelada</span>',
        };
        return map[status] || status;
    },
    categoryIcon(cat) {
        const map = { 'Futebol': '⚽', 'Basquete': '🏀', 'Tênis': '🎾', 'E-Sports': '🎮', 'Fórmula 1': '🏎️', 'Vôlei': '🏐', 'MMA': '🥊', 'Ciclismo': '🚴', 'Baseball': '⚾', 'Outro': '🎯' };
        return map[cat] || '🎯';
    },
    txIcon(type) {
        const map = { deposit: '💰', withdraw: '💸', bet: '🎯', bet_multiple: '📋', win: '🏆', refund: '↩️' };
        return map[type] || '💳';
    },
    typeBadge(type) {
        if (type === 'multiple') return '<span class="badge-multiple">📋 Múltipla</span>';
        return '<span class="badge-unique">⭐ Única</span>';
    },
    txColor(type) {
        const map = { deposit: 'success', withdraw: 'danger', bet: 'danger', win: 'success', refund: 'success' };
        return map[type] || 'primary';
    },
    refreshBalance() {
        const user = DataManager.getCurrentUser();
        const els = document.querySelectorAll('.balance-display');
        els.forEach(el => { el.textContent = Utils.fmt(user?.balance || 0); });
    },
};

// Init
// (None needed for seed now)

// ===================== PWA SERVICE WORKER REGISTRATION =====================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('[PWA] Service Worker registered, scope:', reg.scope))
            .catch(err => console.warn('[PWA] SW registration failed (ok in local dev):', err));
    });
}

