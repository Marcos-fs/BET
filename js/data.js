// ===================== SUPABASE CONFIG =====================
const SUPABASE_URL = 'https://tkxaegikkfsxwojwyglc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_6z8NaL9J_aYlq5UK5MAGOA_N7MbfVdN';

// Initialize Supabase Client
// Note: 'supabase' is the global object from the CDN script
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ===================== DATA MANAGER (SUPABASE VERSION) =====================
const DataManager = {
    // ---- SESSION ----
    async getCurrentUser(forceRefresh = false) {
        const local = JSON.parse(localStorage.getItem('betmgr_current_user'));
        if (!local) return null;

        // If not forcing refresh and we have local data, return it immediately for speed
        if (!forceRefresh) return local;

        try {
            const { data, error } = await sb.from('users').select('*').eq('id', local.id).single();
            if (data) {
                localStorage.setItem('betmgr_current_user', JSON.stringify(data));
                return data;
            }
        } catch (e) {
            console.error('Supabase fetch error:', e);
        }
        return local;
    },

    setCurrentUser(user) {
        localStorage.setItem('betmgr_current_user', JSON.stringify(user));
    },

    logout() {
        localStorage.removeItem('betmgr_current_user');
    },

    // ---- USERS ----
    async login(email, password) {
        const { data, error } = await sb
            .from('users')
            .select('*')
            .eq('email', email.toLowerCase())
            .eq('password', password)
            .single();

        if (error || !data) return { error: 'E-mail ou senha incorretos.' };
        this.setCurrentUser(data);
        return { user: data };
    },

    async register(name, email, password) {
        const { data, error } = await sb
            .from('users')
            .insert([{
                name,
                email: email.toLowerCase(),
                password,
                balance: 0,
                avatar: name.charAt(0).toUpperCase()
            }])
            .select()
            .single();

        if (error) {
            if (error.code === '23505') return { error: 'Este e-mail já está cadastrado.' };
            return { error: 'Erro ao criar conta.' };
        }
        this.setCurrentUser(data);
        return { user: data };
    },

    async updateBalance(userId, delta) {
        const user = await this.getCurrentUser();
        const newBalance = parseFloat((user.balance + delta).toFixed(2));

        // Update both Supabase and LocalStorage concurrently
        const { data, error } = await sb
            .from('users')
            .update({ balance: newBalance })
            .eq('id', userId)
            .select()
            .single();

        if (error) {
            console.error("Error updating balance:", error);
            return null;
        }
        if (data) this.setCurrentUser(data);
        return data;
    },

    // ---- BETS ----
    async getUserBets(userId) {
        const { data, error } = await sb
            .from('bets')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        return data || [];
    },

    async createBet(userId, betData) {
        // Optimistic UI update: reduce local balance immediately so the user doesn't see "delay"
        const local = JSON.parse(localStorage.getItem('betmgr_current_user'));
        if (local) {
            local.balance -= betData.amount;
            this.setCurrentUser(local);
        }

        const { data: bet, error } = await sb
            .from('bets')
            .insert([{
                user_id: userId,
                ...betData,
                status: 'pending'
            }])
            .select()
            .single();

        if (error) {
            console.error("Error creating bet:", error);
            // Rollback local change if error
            this.getCurrentUser(true);
            return null;
        }

        // Background sync
        this.getCurrentUser(true);

        return bet;
    },

    async resolveBet(userId, betId, status) {
        const { data, error } = await sb
            .from('bets')
            .update({ status, resolved_at: new Date().toISOString() })
            .eq('id', betId)
            .select()
            .single();

        // Supabase trigger handles the balance update and transaction logging
        await this.getCurrentUser();
        return data;
    },

    async cancelBet(userId, betId) {
        const { data, error } = await sb
            .from('bets')
            .update({ status: 'cancelled', resolved_at: new Date().toISOString() })
            .eq('id', betId)
            .select()
            .single();

        // Supabase trigger handles the refund and transaction logging
        await this.getCurrentUser();
        return data;
    },

    // ---- TRANSACTIONS ----
    async addTransaction(userId, tx) {
        await sb.from('transactions').insert([{
            user_id: userId,
            ...tx,
            date: tx.date || new Date().toISOString()
        }]);
    },

    async getTransactions(userId) {
        const { data } = await sb
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        return data || [];
    },

    async deposit(userId, amount) {
        const user = await this.updateBalance(userId, amount);
        if (user) {
            await this.addTransaction(userId, { type: 'deposit', description: 'Depósito em conta', amount: amount });
        }
        return user;
    },

    async withdraw(userId, amount) {
        const user = await this.updateBalance(userId, -amount);
        if (user) {
            await this.addTransaction(userId, { type: 'withdraw', description: 'Saque de conta', amount: -amount });
        }
        return user;
    },

    // ---- STATS ----
    async getUserStats(userId) {
        const bets = await this.getUserBets(userId);
        const total = bets.length;
        const won = bets.filter(b => b.status === 'won').length;
        const lost = bets.filter(b => b.status === 'lost').length;
        const pending = bets.filter(b => b.status === 'pending').length;
        const totalInvested = bets.filter(b => b.status !== 'cancelled').reduce((s, b) => s + parseFloat(b.amount), 0);
        const totalWon = bets.filter(b => b.status === 'won').reduce((s, b) => s + (b.amount * b.odds), 0);
        const winRate = total > 0 ? ((won / (won + lost || 1)) * 100) : 0;
        const roi = totalInvested > 0 ? (((totalWon - totalInvested) / totalInvested) * 100) : 0;

        return { total, won, lost, pending, winRate, roi, totalInvested, totalWon };
    }
};

// ===================== AUTH HELPER =====================
const Auth = {
    async requireAuth() {
        const userStr = localStorage.getItem('betmgr_current_user');
        if (!userStr) { window.location.href = '/'; return null; }
        return JSON.parse(userStr);
    },
    async login(email, password) { return await DataManager.login(email, password); },
    async register(name, email, password) { return await DataManager.register(name, email, password); }
};

// ===================== UTILS =====================
const Utils = {
    fmt(v) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v); },
    fmtDate(iso) { return new Date(iso).toLocaleString('pt-BR'); },
    fmtDateShort(iso) { return new Date(iso).toLocaleDateString('pt-BR'); },
    categoryIcon(cat) {
        const map = { 'Futebol': '⚽', 'Basquete': '🏀', 'Tênis': '🎾', 'E-Sports': '🎮', 'MMA': '🥊' };
        return map[cat] || '🎰';
    },
    statusBadge(status) {
        const map = { pending: '⏳ Pendente', won: '✅ Ganhou', lost: '❌ Perdeu', cancelled: '↩️ Cancelada' };
        const colors = { pending: 'warning', won: 'success', lost: 'danger', cancelled: 'muted' };
        return `<span class="badge badge-${colors[status]}">${map[status]}</span>`;
    },
    txIcon(type) {
        const map = { deposit: '💰', withdraw: '💸', bet: '🎯', win: '🏆', refund: '↩️' };
        return map[type] || '💳';
    },
    typeBadge(type) {
        return type === 'multiple' ? '<span class="badge badge-primary">Múltipla</span>' : '<span class="badge badge-accent">Única</span>';
    }
};
