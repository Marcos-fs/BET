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
            console.error('Registration error detail:', error);
            if (error.code === '23505') return { error: 'Este e-mail já está cadastrado.' };
            return { error: 'Erro ao criar conta: ' + (error.message || 'Erro no servidor.') };
        }
        this.setCurrentUser(data);
        return { user: data };
    },

    async updateBalance(userId, delta) {
        // ALWAYS fetch a fresh version from the server before calculating new balance
        // to avoid "double debit" from optimistic local updates
        const user = await this.getCurrentUser(true);
        if (!user) return null;

        const newBalance = parseFloat((user.balance + delta).toFixed(2));

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

        if (bet) {
            // Processing balance and transaction in JS
            await Promise.all([
                this.updateBalance(userId, -betData.amount),
                this.addTransaction(userId, {
                    type: 'bet',
                    description: `Aposta: ${betData.title}`,
                    amount: -betData.amount,
                    bet_id: bet.id
                })
            ]);

            // Final refresh to be sure
            await this.getCurrentUser(true);
        }

        return bet;
    },

    async resolveBet(userId, betId, status) {
        const { data, error } = await sb
            .from('bets')
            .update({ status, resolved_at: new Date().toISOString() })
            .eq('id', betId)
            .select()
            .single();

        if (data && status === 'won') {
            const win = parseFloat((data.amount * data.odds).toFixed(2));
            await Promise.all([
                this.updateBalance(userId, win),
                this.addTransaction(userId, {
                    type: 'win',
                    description: `Ganho: ${data.title}`,
                    amount: win,
                    bet_id: betId
                })
            ]);
        }

        await this.getCurrentUser(true);
        return data;
    },

    async cancelBet(userId, betId) {
        const { data, error } = await sb
            .from('bets')
            .update({ status: 'cancelled', resolved_at: new Date().toISOString() })
            .eq('id', betId)
            .select()
            .single();

        if (data) {
            const refund = parseFloat(data.amount);
            await Promise.all([
                this.updateBalance(userId, refund),
                this.addTransaction(userId, {
                    type: 'refund',
                    description: `Reembolso: ${data.title}`,
                    amount: refund,
                    bet_id: betId
                })
            ]);
        }

        await this.getCurrentUser(true);
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

// ===================== UI ANIMATIONS =====================
const Animate = {
    // Show a floating "+R$ 100" or "-R$ 50" that drifts up and fades
    flashBalance(delta) {
        const isPlus = delta > 0;
        const displays = document.querySelectorAll('.balance-display');

        displays.forEach(el => {
            // Pulse effect
            el.classList.remove('anim-pulse-green', 'anim-pulse-red');
            void el.offsetWidth;
            el.classList.add(isPlus ? 'anim-pulse-green' : 'anim-pulse-red');

            // Floating indicator
            const rect = el.getBoundingClientRect();
            const floater = document.createElement('div');
            floater.className = `floating-amount ${isPlus ? 'plus' : 'minus'}`;
            floater.style.position = 'fixed';
            floater.style.left = `${rect.left + (rect.width / 2)}px`;
            floater.style.top = `${rect.top}px`;
            floater.style.zIndex = '99999';
            floater.textContent = (isPlus ? '+' : '') + Utils.fmt(delta);

            document.body.appendChild(floater);
            setTimeout(() => floater.remove(), 1200);
        });
    },

    shake(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('anim-shake');
        void el.offsetWidth;
        el.classList.add('anim-shake');
    },

    successBtn(id, oldText) {
        const el = document.getElementById(id);
        if (!el) return;
        const prevBg = el.style.background;
        el.innerHTML = '✅ Concluído!';
        el.style.background = '#00d4aa';
        setTimeout(() => { el.innerHTML = oldText; el.style.background = prevBg; }, 2000);
    }
};

// ===================== CLIENT TOAST =====================
const Toast = {
    show(msg, sub = '', type = 'info') {
        const t = document.createElement('div');
        const colors = { info: '#445577', success: '#00d4aa', error: '#ff4757', warning: '#ffa502' };
        t.style = `position:fixed;bottom:20px;right:20px;background:${colors[type]};color:#fff;padding:12px 20px;border-radius:12px;z-index:20000;box-shadow:0 10px 30px rgba(0,0,0,0.5);animation:float-up-fade 0.4s ease-out;display:flex;flex-direction:column;gap:4px;min-width:260px;border-left:5px solid rgba(0,0,0,0.2);`;
        t.innerHTML = `<div style="font-weight:800;font-size:14px;">${msg}</div><div style="font-size:12px;opacity:0.8;">${sub}</div>`;
        document.body.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(-20px)'; t.style.transition = '0.4s'; setTimeout(() => t.remove(), 400); }, 3500);
    },
    success(m, s) { this.show(m, s, 'success'); },
    error(m, s) { this.show(m, s, 'error'); }
};
