const app = {
    indexData: null,
    currentUser: null,
    pendingView: null,
    userAvatar: null,
    authSource: 'local',
    remoteId: null,
    userData: {
        mistakes: [],
        marathon: {}, 
        examStats: { passed: 0, failed: 0, total: 0 },
        ticketsSolved: 0
    },
    authMode: 'login',
    
    // Для свайпа
    touchStartX: 0,
    touchEndX: 0,
    minSwipeDistance: 50,
    
    // --- КОНФИГУРАЦИЯ ---
    GOOGLE_CLIENT_ID: "1096394669375-00j6f5olv616q08fcp6uju2pr091sa5r.apps.googleusercontent.com",
    
    VK_APP_ID: 54438630, 
    
    FIREBASE_CONFIG: {
        apiKey: "AIzaSyAPnAQXRmMRiJY5gHLImXbF8xlwHcQ89BA",
        authDomain: "pdd-unique.firebaseapp.com",
        databaseURL: "https://pdd-unique-default-rtdb.europe-west1.firebasedatabase.app",
        projectId: "pdd-unique",
        storageBucket: "pdd-unique.firebasestorage.app",
        messagingSenderId: "140779580830",
        appId: "1:140779580830:web:7cceba0219ba5e99957a8f"
    },

    state: {
        mode: 'training',
        questions: [],
        currentIndex: 0,
        answers: {}, 
        startTime: 0,
        wrongAnswersList: [],
        timer: null,
        timeLeft: 0,
        examSelection: null, 
        isExtraRound: false
    },

    async init() {
        try {
            // Инициализация Firebase
            if(window.firebase && !firebase.apps.length) {
                firebase.initializeApp(this.FIREBASE_CONFIG);
                this.db = firebase.database();
            }

            // Инициализация VK
            if (window.VK) {
                VK.init({ apiId: this.VK_APP_ID });
            }

            const res = await fetch('index.json');
            this.indexData = await res.json();
            
            this.initGoogleAuth();

            // 1. Сначала пробуем восстановить сессию вопросов
            const restored = this.restoreQuestionSession();
            
            // 2. Проверка сохраненной сессии пользователя
            const savedUser = localStorage.getItem('pdd_current_user');
            const savedAvatar = localStorage.getItem('pdd_current_avatar');
            const savedSource = localStorage.getItem('pdd_auth_source');
            const savedRemoteId = localStorage.getItem('pdd_remote_id');
            
            if (savedUser) {
                this.currentUser = savedUser;
                this.userAvatar = savedAvatar;
                this.authSource = savedSource || 'local';
                this.remoteId = savedRemoteId;
                
                await this.loadUserData();
                this.onLoginSuccess();
                
                // Если восстановили сессию вопросов, показываем их сразу
                if (restored && this.state.questions.length > 0) {
                    this.navigate('questions');
                    this.renderTrainingView();
                    return;
                }
            } else {
                // Если нет пользователя, но есть сессия вопросов - показываем вопросы
                if (restored && this.state.questions.length > 0) {
                    this.navigate('questions');
                    this.renderTrainingView();
                    return;
                }
                // Иначе показываем авторизацию
                this.navigate('auth');
            }
            
            this.setupKeyboard();
            this.setupSwipe();
            this.renderMenu();
            this.updateMobileNavUser();
        } catch (e) { 
            console.error("Init Error:", e);
            this.navigate('auth');
        }
    },

    // --- СОХРАНЕНИЕ И ВОССТАНОВЛЕНИЕ СЕССИИ ---
    saveQuestionSession() {
        if (this.state.questions.length > 0 && this.state.mode !== 'exam') {
            const sessionData = {
                mode: this.state.mode,
                questions: this.state.questions,
                currentIndex: this.state.currentIndex,
                answers: this.state.answers,
                startTime: this.state.startTime,
                wrongAnswersList: this.state.wrongAnswersList,
                timestamp: Date.now()
            };
            
            localStorage.setItem('pdd_question_session', JSON.stringify(sessionData));
        }
    },

    restoreQuestionSession() {
        try {
            const savedSession = localStorage.getItem('pdd_question_session');
            if (savedSession) {
                const session = JSON.parse(savedSession);
                const hourAgo = Date.now() - (60 * 60 * 1000);
                
                if (session.timestamp > hourAgo) {
                    this.state.mode = session.mode;
                    this.state.questions = session.questions;
                    this.state.currentIndex = session.currentIndex;
                    this.state.answers = session.answers;
                    this.state.startTime = session.startTime || Date.now();
                    this.state.wrongAnswersList = session.wrongAnswersList || [];
                    return true;
                } else {
                    localStorage.removeItem('pdd_question_session');
                }
            }
        } catch (e) {
            localStorage.removeItem('pdd_question_session');
        }
        return false;
    },

    clearQuestionSession() {
        localStorage.removeItem('pdd_question_session');
    },

    // --- DB SYNC LOGIC ---
    async loadUserData() {
        // 1. Сначала пытаемся загрузить локально (быстро)
        let localData = null;
        if (this.currentUser) {
            const data = localStorage.getItem(`pdd_data_${this.currentUser}`);
            if (data) localData = JSON.parse(data);
        }

        // 2. Если есть удаленный ID и доступна БД - грузим оттуда
        if (this.remoteId && this.db) {
            try {
                const snapshot = await this.db.ref('users/' + this.remoteId).get();
                if (snapshot.exists()) {
                    const remoteData = snapshot.val();
                    this.userData = remoteData;
                    this.saveLocal(); 
                } else {
                    if (localData) {
                        this.userData = localData;
                        this.saveUserData();
                    } else {
                        this.resetUserData();
                    }
                }
            } catch (e) {
                console.error("Firebase Load Error:", e);
                this.userData = localData || this.resetUserData();
            }
        } else {
            this.userData = localData || this.resetUserData();
        }
        
        // Гарантируем структуру
        if (!this.userData.mistakes) this.userData.mistakes = [];
        if (!this.userData.marathon) this.userData.marathon = {};
        if (!this.userData.examStats) this.userData.examStats = { passed: 0, failed: 0, total: 0 };
    },

    resetUserData() {
        return { mistakes: [], marathon: {}, examStats: { passed: 0, failed: 0, total: 0 }, ticketsSolved: 0 };
    },

    saveUserData() {
        if (!this.currentUser) return;
        
        // 1. Сохраняем локально
        this.saveLocal();

        // 2. Если есть синхронизация - отправляем в облако
        if (this.remoteId && this.db) {
            this.db.ref('users/' + this.remoteId).set(this.userData).catch(err => {
                console.error("Sync Error:", err);
            });
        }
    },

    saveLocal() {
        localStorage.setItem(`pdd_data_${this.currentUser}`, JSON.stringify(this.userData));
    },

    // --- AUTH SYSTEM (VK) ---
    loginVK() {
        if (!window.VK) {
            alert('VK API не загрузился. Проверьте интернет или блокировщики рекламы.');
            return;
        }
        VK.Auth.login((response) => {
            if (response.session) {
                console.log("VK Session:", response.session);
                const user = response.session.user;
                
                this.currentUser = (user.first_name + " " + user.last_name).trim();
                this.userAvatar = `https://vk.com/images/camera_200.png`; 
                this.authSource = 'vk';
                this.remoteId = 'vk_' + user.id;

                this.saveSession();
                this.loadUserData().then(() => this.onLoginSuccess());
            } else {
                alert('Не удалось войти через VK');
            }
        }, 4);
    },

    // --- AUTH SYSTEM (Google) ---
    initGoogleAuth() {
        if (!window.google) return;
        window.google.accounts.id.initialize({
            client_id: this.GOOGLE_CLIENT_ID,
            callback: this.handleGoogleCredential.bind(this)
        });
        window.google.accounts.id.renderButton(
            document.getElementById("google_btn_container"),
            { theme: "outline", size: "large", width: "100%", text: "continue_with" } 
        );
    },

    handleGoogleCredential(response) {
        const payload = this.decodeJwt(response.credential);
        
        this.currentUser = payload.name || payload.email;
        this.userAvatar = payload.picture;
        this.authSource = 'google';
        this.remoteId = 'google_' + (payload.email.replace(/\./g, ',').replace(/@/g, '_at_'));

        this.saveSession();
        this.loadUserData().then(() => this.onLoginSuccess());
    },

    decodeJwt(token) {
        try {
            const base64Url = token.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(decodeURIComponent(atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
        } catch (e) { return {}; }
    },

    // --- AUTH SYSTEM (Local) ---
    performAuth() {
        const loginInput = document.getElementById('auth-login').value.trim();
        const passInput = document.getElementById('auth-pass').value.trim();
        if (!loginInput || !passInput) return alert("Введите логин и пароль");

        if (this.authMode === 'register') this.registerLocal(loginInput, passInput);
        else this.loginLocal(loginInput, passInput);
    },

    registerLocal(login, pass) {
        let users = JSON.parse(localStorage.getItem('pdd_users_db') || '{}');
        if (users[login]) return alert("Пользователь уже существует");
        users[login] = pass; 
        localStorage.setItem('pdd_users_db', JSON.stringify(users));
        this.loginLocal(login, pass);
    },

    loginLocal(login, pass) {
        let users = JSON.parse(localStorage.getItem('pdd_users_db') || '{}');
        if (users[login] === pass) {
            this.currentUser = login;
            this.userAvatar = null;
            this.authSource = 'local';
            this.remoteId = null;
            
            this.saveSession();
            this.loadUserData().then(() => this.onLoginSuccess());
        } else {
            alert("Неверный логин или пароль");
        }
    },

    saveSession() {
        localStorage.setItem('pdd_current_user', this.currentUser);
        localStorage.setItem('pdd_auth_source', this.authSource);
        if (this.userAvatar) localStorage.setItem('pdd_current_avatar', this.userAvatar);
        if (this.remoteId) localStorage.setItem('pdd_remote_id', this.remoteId);
        this.updateMobileNavUser();
    },

    toggleAuthMode() {
        this.authMode = this.authMode === 'login' ? 'register' : 'login';
        document.getElementById('auth-title').innerText = this.authMode === 'login' ? 'Вход в профиль' : 'Регистрация';
        document.getElementById('auth-toggle-text').innerText = this.authMode === 'login' ? 'Нет аккаунта?' : 'Есть аккаунт?';
        document.querySelector('.auth-footer button').innerText = this.authMode === 'login' ? 'Зарегистрироваться' : 'Войти';
        document.querySelector('.auth-form button').innerText = this.authMode === 'login' ? 'Войти' : 'Создать аккаунт';
    },

    onLoginSuccess() {
        this.renderHeaderUser();
        this.updateMobileNavUser();
        document.getElementById('main-header').style.display = 'flex'; 
        this.navigate('tickets');
    },

    logout() {
        this.currentUser = null;
        this.userAvatar = null;
        this.remoteId = null;
        this.authSource = 'local';
        this.userData = this.resetUserData();
        this.clearQuestionSession();
        
        localStorage.removeItem('pdd_current_user');
        localStorage.removeItem('pdd_current_avatar');
        localStorage.removeItem('pdd_auth_source');
        localStorage.removeItem('pdd_remote_id');
        
        document.getElementById('main-header').style.display = 'none';
        this.navigate('auth');
        setTimeout(() => this.initGoogleAuth(), 100);
    },

    // --- МОБИЛЬНАЯ НАВИГАЦИЯ ---
    openMobileNav() {
        document.getElementById('mobile-nav').classList.add('active');
        document.getElementById('mobile-nav-overlay').classList.add('active');
        document.body.style.overflow = 'hidden';
    },

    closeMobileNav() {
        document.getElementById('mobile-nav').classList.remove('active');
        document.getElementById('mobile-nav-overlay').classList.remove('active');
        document.body.style.overflow = '';
    },

    updateMobileNavUser() {
        const nameEl = document.getElementById('mobile-username');
        const avatarEl = document.getElementById('mobile-avatar');
        if (this.currentUser) {
            nameEl.innerText = this.currentUser.split(' ')[0];
            avatarEl.innerHTML = this.userAvatar ? `<img src="${this.userAvatar}" alt="ava">` : '👤';
        } else {
            nameEl.innerText = 'Профиль';
            avatarEl.innerHTML = '👤';
        }
    },

    // --- UI HELPERS ---
    renderHeaderUser() {
        const nameEl = document.getElementById('header-username');
        const avatarEl = document.getElementById('header-avatar');
        if (this.currentUser) {
            nameEl.innerText = this.currentUser.split(' ')[0];
            avatarEl.innerHTML = this.userAvatar ? `<img src="${this.userAvatar}" alt="ava">` : '👤';
        }
    },

    handleProfileClick() {
        if (this.currentUser) {
            this.navigate('profile');
            this.renderProfileStats();
        } else {
            this.navigate('auth');
        }
        this.closeMobileNav();
    },

    renderProfileStats() {
        document.getElementById('profile-name').innerText = this.currentUser;
        
        const syncText = document.getElementById('profile-sync-status');
        if (this.authSource === 'vk') syncText.innerText = "Синхронизация VK активна";
        else if (this.authSource === 'google') syncText.innerText = "Синхронизация Google активна";
        else syncText.innerText = "Локальный профиль (нет синхронизации)";
        
        const bigAvatar = document.getElementById('profile-avatar-large');
        bigAvatar.innerHTML = this.userAvatar ? `<img src="${this.userAvatar}">` : '👤';

        document.getElementById('stat-tickets').innerText = this.userData.ticketsSolved || 0;
        document.getElementById('stat-mistakes').innerText = (this.userData.mistakes || []).length;
        
        const exams = this.userData.examStats || {passed:0, failed:0};
        const totalExams = exams.passed + exams.failed;
        const rate = totalExams > 0 ? Math.round((exams.passed / totalExams) * 100) : 0;
        document.getElementById('stat-exam').innerText = `${rate}%`;

        const marathonDone = Object.keys(this.userData.marathon || {}).length;
        document.getElementById('stat-marathon').innerText = `${marathonDone}/800`;
    },

    navigate(view) {
        // Сохраняем сессию вопросов при уходе
        if (view !== 'questions' && this.state.questions.length > 0) {
            this.saveQuestionSession();
        }

        if (!this.currentUser && view !== 'auth' && view !== 'questions') view = 'auth';

        const isExamActive = this.state.mode === 'exam' && this.state.timeLeft > 0;
        const isExamViews = view === 'exam-dashboard' || view === 'exam-start' || view === 'result';
        
        if (isExamActive && !isExamViews) {
            this.pendingView = view;
            document.getElementById('confirm-modal').classList.add('open');
            return;
        }

        document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.mobile-nav-item').forEach(el => el.classList.remove('active'));
        
        // Обновляем мобильное меню
        let menuView = view;
        if (['questions', 'summary'].includes(view)) {
            if (this.state.mode === 'range') menuView = 'ranges';
            else if (this.state.mode === 'mistakes') menuView = 'mistakes';
            else if (this.state.mode === 'marathon') menuView = 'marathon-intro';
            else menuView = 'tickets';
        }
        
        const mobileBtn = document.querySelector(`.mobile-nav-item[onclick*="'${menuView}'"]`);
        if (mobileBtn) mobileBtn.classList.add('active');

        const targetId = `view-${view}`;
        const el = document.getElementById(targetId);
        if (el) {
            el.classList.add('active');
            setTimeout(() => {
                el.scrollTop = 0;
            }, 50);
        }
        
        if (view === 'mistakes') this.renderMistakesMenu();
        
        this.closeMobileNav();
    },

    goBack() {
        if (this.state.mode === 'exam' && this.state.timeLeft > 0) {
            this.navigate('exam-start'); 
        } else if (this.state.mode === 'range') {
            this.navigate('ranges');
        } else if (this.state.mode === 'mistakes') {
            this.navigate('mistakes');
        } else {
            this.navigate('tickets');
        }
        if (this.state.mode !== 'exam') {
            this.state.questions = [];
            this.clearQuestionSession();
        }
    },

    prevQuestion() {
        if (this.state.currentIndex > 0) {
            this.state.currentIndex--;
            this.renderCurrentQuestion();
            this.updateNavButtons();
        }
    },

    nextQuestion() {
        if (this.state.currentIndex < this.state.questions.length - 1) {
            this.state.currentIndex++;
            this.renderCurrentQuestion();
            this.updateNavButtons();
        }
    },

    updateNavButtons() {
        const btnPrev = document.getElementById('btn-prev');
        const btnNext = document.getElementById('btn-next');
        const btnFinish = document.getElementById('btn-finish-train');
        
        if (btnPrev) {
            btnPrev.style.display = this.state.currentIndex > 0 ? 'block' : 'none';
        }
        
        if (btnNext && btnFinish) {
            if (this.state.currentIndex < this.state.questions.length - 1) {
                btnNext.style.display = 'block';
                btnFinish.style.display = 'none';
            } else {
                btnNext.style.display = 'none';
                btnFinish.style.display = 'block';
            }
        }
    },

    // --- SWIPE GESTURES ---
    setupSwipe() {
        const swipeContainer = document.getElementById('swipe-container');
        if (!swipeContainer) return;

        swipeContainer.addEventListener('touchstart', (e) => {
            this.touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });

        swipeContainer.addEventListener('touchend', (e) => {
            this.touchEndX = e.changedTouches[0].screenX;
            this.handleSwipe();
        }, { passive: true });
    },

    handleSwipe() {
        const swipeDistance = this.touchEndX - this.touchStartX;
        
        if (Math.abs(swipeDistance) < this.minSwipeDistance) return;
        
        if (swipeDistance > 0) {
            // Свайп вправо → предыдущий вопрос
            this.prevQuestion();
        } else {
            // Свайп влево → следующий вопрос
            this.nextQuestion();
        }
    },

    async getAllQuestions() {
        const keys = Object.keys(this.indexData).sort((a,b) => 
            parseInt(a.replace('b','')) - parseInt(b.replace('b',''))
        );
        let allQ = [];
        for (let key of keys) {
            const res = await fetch(this.indexData[key].json);
            const data = await res.json();
            allQ = allQ.concat(data);
        }
        return allQ;
    },

    renderMenu() {
        const menu = document.getElementById('tickets-menu');
        const sortedKeys = Object.keys(this.indexData).sort((a,b) => 
            parseInt(a.replace('b','')) - parseInt(b.replace('b',''))
        );
        menu.innerHTML = sortedKeys.map(key => `
            <button onclick="app.loadTicket('${key}')">Билет ${key.replace('b','')}</button>
        `).join('');
    },

    async loadTicket(key) {
        this.startSession('training');
        const res = await fetch(this.indexData[key].json);
        this.state.questions = await res.json();
        this.renderTrainingView();
    },

    async startMarathon() {
        const btn = document.querySelector('#view-marathon-intro button');
        const origText = btn.innerText;
        btn.innerText = "Загрузка...";
        setTimeout(async () => {
            const all = await this.getAllQuestions();
            this.startSession('marathon');
            this.state.questions = all;
            this.renderTrainingView();
            btn.innerText = origText;
        }, 50);
    },

    async startRangeCustom() {
        const startVal = parseInt(document.getElementById('range-start').value) || 1;
        const endVal = parseInt(document.getElementById('range-end').value) || 20;

        if (startVal < 1 || startVal > 20 || endVal < 1 || endVal > 20 || startVal > endVal) {
            alert("Пожалуйста, укажите корректный диапазон.");
            return;
        }

        const btn = document.querySelector('#view-ranges button');
        const origText = btn.innerText;
        btn.innerText = "Формирование...";

        const all = await this.getAllQuestions();
        let filtered = all.filter(q => q.questNumber >= startVal && q.questNumber <= endVal);
        
        for (let i = filtered.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
        }

        if (filtered.length === 0) {
            alert("Вопросы не найдены");
            btn.innerText = origText;
            return;
        }

        this.startSession('range');
        this.state.questions = filtered;
        this.renderTrainingView();
        btn.innerText = origText;
    },

    startSession(mode) {
        this.state.mode = mode;
        this.state.currentIndex = 0;
        this.state.answers = {};
        this.state.questions = [];
        this.state.wrongAnswersList = [];
        this.state.startTime = Date.now();
        this.stopTimer();
        this.clearQuestionSession();
    },

    renderTrainingView() {
        this.navigate('questions');
        const isMarathon = this.state.mode === 'marathon';
        
        document.getElementById('pagination').style.display = isMarathon ? 'none' : 'flex';
        document.getElementById('marathon-pagination').style.display = isMarathon ? 'grid' : 'none';
        document.getElementById('marathon-stats').style.display = isMarathon ? 'flex' : 'none';

        if (isMarathon) {
            this.renderMarathonGrid();
            this.updateMarathonStats();
        }
        
        this.renderCurrentQuestion();
        this.updateNavButtons();
        
        // Сохраняем сессию
        this.saveQuestionSession();
    },

    renderMarathonGrid() {
        const container = document.getElementById('marathon-pagination');
        const fragment = document.createDocumentFragment();
        this.state.questions.forEach((_, i) => {
            const btn = document.createElement('button');
            btn.className = 'marathon-btn';
            btn.innerText = i + 1;
            btn.onclick = () => app.jumpTo(i);
            btn.id = `m-btn-${i}`;
            
            if (this.userData.marathon[i] !== undefined) {
                btn.classList.add(this.userData.marathon[i] === 1 ? 'correct' : 'wrong');
            }

            fragment.appendChild(btn);
        });
        container.innerHTML = '';
        container.appendChild(fragment);
    },

    updateMarathonStats() {
        if (this.state.mode !== 'marathon') return;
        
        let correct = 0;
        let wrong = 0;
        const total = this.state.questions.length;

        const mData = this.userData.marathon;
        Object.values(mData).forEach(val => {
            if (val === 1) correct++; else wrong++;
        });

        document.getElementById('m-correct').innerText = correct;
        document.getElementById('m-wrong').innerText = wrong;
        document.getElementById('m-total').innerText = `${correct + wrong}/${total}`;
    },

    renderCurrentQuestion() {
        const { questions, currentIndex, answers, mode } = this.state;
        const q = questions[currentIndex];
        
        if (mode === 'marathon') {
            document.querySelectorAll('.marathon-btn.active').forEach(b => b.classList.remove('active'));
            const curBtn = document.getElementById(`m-btn-${currentIndex}`);
            if(curBtn) {
                curBtn.classList.add('active');
                curBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        } else {
            const pgContainer = document.getElementById('pagination');
            pgContainer.innerHTML = questions.map((_, i) => {
                let cls = '';
                const ans = answers[i];
                if (ans !== undefined) cls = (ans === questions[i].otvet) ? 'status-correct' : 'status-wrong';
                if (i === currentIndex) cls += ' current';
                return `<button class="page-btn ${cls}" onclick="app.jumpTo(${i})">${i+1}</button>`;
            }).join('');

            const currentBtn = pgContainer.children[currentIndex];
            if(currentBtn) {
                setTimeout(() => {
                    currentBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                }, 10);
            }
        }

        const container = document.getElementById('current-question-card');
        if (!q) return;

        const userAnswer = answers[currentIndex];
        const isAnswered = userAnswer !== undefined;

        let imgHTML = '';
        if (q.realUrl && q.realUrl !== 'no_image') {
            const fName = `${this.pad(q.biletNumber)}${this.pad(q.questNumber)}.jpg`;
            imgHTML = `<img src="image/${fName}" loading="lazy" class="q-image" onerror="this.style.display='none'">`;
        }

        const answersHTML = q.v.map((text, idx) => {
            if (!text) return '';
            const ansNum = idx + 1;
            let cls = '';
            if (isAnswered) {
                if (ansNum === q.otvet) cls = 'correct';
                else if (ansNum === userAnswer) cls = 'wrong';
            }
            const disabled = isAnswered ? 'disabled' : '';
            return `<li><button class="answer-btn ${cls}" ${disabled} onclick="app.handleTrainingAnswer(${idx})">
                <span style="font-weight:600; margin-right:10px; color:#0969da;">${ansNum}.</span> <span>${text}</span>
            </button></li>`;
        }).join('');

        container.innerHTML = `
            <div class="question-card">
                <div class="q-meta" style="font-size: 13px; color: #777; margin-bottom: 8px; font-weight:500;">
                    Билет ${q.biletNumber}, Вопрос ${q.questNumber}
                </div>
                <div class="q-text">${q.quest}</div>
                ${imgHTML}
                <ul class="answers-list">${answersHTML}</ul>
                ${isAnswered && userAnswer !== q.otvet ? `
                    <div class="hint-block visible">
                        <strong>Пояснение:</strong><br>${this.formatComment(q.comments)}
                    </div>
                ` : ''}
            </div>
        `;

        this.updateNavButtons();
        
        // Плавный скролл наверх
        setTimeout(() => {
            container.scrollTop = 0;
        }, 100);
    },

    handleTrainingAnswer(idx) {
        const { currentIndex, questions, mode } = this.state;
        if (this.state.answers[currentIndex] !== undefined) return;

        const ansNum = idx + 1;
        this.state.answers[currentIndex] = ansNum;
        const isCorrect = (ansNum === questions[currentIndex].otvet);
        
        if (!isCorrect) {
            this.state.wrongAnswersList.push(questions[currentIndex]);
            this.addToMistakes(questions[currentIndex]);
        }

        if (mode === 'training') {
             this.userData.ticketsSolved = (this.userData.ticketsSolved || 0) + 1;
             this.saveUserData();
        }
        
        if (mode === 'marathon') {
            this.userData.marathon[currentIndex] = isCorrect ? 1 : 0;
            this.saveUserData();
            this.updateMarathonStats();
            const gridBtn = document.getElementById(`m-btn-${currentIndex}`);
            if (gridBtn) gridBtn.classList.add(isCorrect ? 'correct' : 'wrong');
        }
        
        this.renderCurrentQuestion();
        this.saveQuestionSession();
    },

    jumpTo(idx) {
        this.state.currentIndex = idx;
        this.renderCurrentQuestion();
        this.updateNavButtons();
    },

    finishTraining() {
        this.clearQuestionSession();
        this.navigate('summary');
        const duration = Date.now() - this.state.startTime;
        this.renderSummary(duration, this.state.wrongAnswersList);
    },

    // --- REAL EXAM ---
    async startRealExam() {
        this.startSession('exam');
        this.state.isExtraRound = false;
        document.getElementById('exam-result-modal').classList.remove('open');
        document.getElementById('exam-result-modal').style.display = 'none';

        const keys = Object.keys(this.indexData);
        const randKey = keys[Math.floor(Math.random() * keys.length)];
        const res = await fetch(this.indexData[randKey].json);
        this.state.questions = await res.json();
        
        this.state.timeLeft = 20 * 60;
        this.updateExamTimer();
        this.state.timer = setInterval(() => {
            this.state.timeLeft--;
            this.updateExamTimer();
            if(this.state.timeLeft <= 0) this.finishExam(false, "Время вышло");
        }, 1000);

        this.navigate('exam-dashboard');
        this.renderExamDashboard();
    },

    renderExamDashboard() {
        const grid = document.getElementById('exam-grid');
        const { questions, answers } = this.state;
        grid.innerHTML = questions.map((q, idx) => {
            const isAnswered = answers[idx] !== undefined;
            const cls = isAnswered ? 'answered' : '';
            
            let imgTag = '';
            
            if (q.realUrl && q.realUrl !== 'no_image') {
                const fName = `${this.pad(q.biletNumber)}${this.pad(q.questNumber)}.jpg`;
                imgTag = `<img src="image/${fName}" loading="lazy" class="exam-card-img" onerror="this.style.display='none'">`;
            }

            let label = idx + 1;
            if (idx >= 20) label = `+${idx - 19}`;

            return `
                <div class="exam-card ${cls}" onclick="app.openExamQuestion(${idx})">
                    <span class="exam-card-num">${label}</span>
                    ${imgTag}
                    <div class="exam-card-body">
                        ${q.quest.substring(0, 60)}${q.quest.length > 60 ? '...' : ''}
                    </div>
                </div>
            `;
        }).join('');
    },

    openExamQuestion(idx) {
        if (this.state.answers[idx] !== undefined) return;
        
        this.state.currentIndex = idx;
        this.state.examSelection = null;
        
        const q = this.state.questions[idx];
        const modal = document.getElementById('exam-modal');
        const content = document.getElementById('exam-modal-question');
        const btnConf = document.getElementById('btn-confirm-exam');
        
        btnConf.disabled = true;

        let imgHTML = '';
        if (q.realUrl) {
            const fName = `${this.pad(q.biletNumber)}${this.pad(q.questNumber)}.jpg`;
            imgHTML = `<img src="image/${fName}" class="q-image" style="max-height:300px; object-fit:contain; margin:0 auto 15px auto;">`;
        }

        const answersHTML = q.v.map((text, i) => {
            if(!text) return '';
            return `<li>
                <button class="answer-btn secondary-btn-dark" id="exam-ans-${i+1}" onclick="app.selectExamAnswer(${i+1})">
                    <b>${i+1}.</b> &nbsp; ${text}
                </button>
            </li>`;
        }).join('');

        content.innerHTML = `
            <h3 style="margin-top:0">Вопрос ${idx >= 20 ? 'доп.' : idx + 1}</h3>
            <div style="font-size:16px; margin-bottom:15px; font-weight:600;">${q.quest}</div>
            ${imgHTML}
            <ul class="answers-list">${answersHTML}</ul>
        `;

        modal.classList.add('open');
    },

    selectExamAnswer(ansNum) {
        this.state.examSelection = ansNum;
        document.querySelectorAll('#exam-modal .answer-btn').forEach(btn => btn.style.borderColor = '#6e7681');
        const btn = document.getElementById(`exam-ans-${ansNum}`);
        if(btn) btn.style.borderColor = '#2da44e';
        
        document.getElementById('btn-confirm-exam').disabled = false;
    },

    confirmExamAnswer() {
        if (!this.state.examSelection) return;
        
        const idx = this.state.currentIndex;
        this.state.answers[idx] = this.state.examSelection;
        
        this.closeExamModal();
        this.renderExamDashboard();
        
        if (Object.keys(this.state.answers).length === this.state.questions.length) {
            this.checkExamResults();
        }
    },

    closeExamModal() {
        document.getElementById('exam-modal').classList.remove('open');
    },

    updateExamTimer() {
        const m = Math.floor(this.state.timeLeft / 60).toString().padStart(2,'0');
        const s = (this.state.timeLeft % 60).toString().padStart(2,'0');
        const el = document.getElementById('dash-timer');
        if(el) el.innerText = `${m}:${s}`;
    },

    finishExamEarly() {
        if(confirm("Вы уверены, что хотите завершить экзамен сейчас?")) {
            this.checkExamResults();
        }
    },

    async checkExamResults() {
        if (this.state.isExtraRound) {
            this.finishExamRound();
            return;
        }

        let errors = [];
        let blocks = { 1:0, 2:0, 3:0, 4:0 };

        for (let i = 0; i < 20; i++) {
            const q = this.state.questions[i];
            const ans = this.state.answers[i];
            if (!ans || ans !== q.otvet) {
                errors.push(q);
                const blk = Math.ceil(q.questNumber / 5);
                if (blocks[blk] !== undefined) blocks[blk]++;
            }
        }

        const errCount = errors.length;
        this.state.wrongAnswersList = errors;

        if (errCount >= 3) return this.finishExam(false, `Не сдано. ${errCount} ошибки.`);
        if (Object.values(blocks).some(c => c >= 2)) return this.finishExam(false, "Не сдано. 2 ошибки в одном тематическом блоке.");

        if (errCount > 0) {
            await this.addExtraQuestions(blocks);
        } else {
            this.finishExam(true, "Сдано без ошибок!");
        }
    },

    async addExtraQuestions(blocks) {
        this.state.isExtraRound = true;
        this.state.timeLeft += (Object.values(blocks).reduce((a,b)=>a+b,0) * 5) * 60; 
        
        alert("Добавлены дополнительные вопросы. В них ошибаться нельзя!");

        const allKeys = Object.keys(this.indexData);
        let extra = [];
        const blocksNeeded = Object.keys(blocks).filter(k => blocks[k] > 0);
        
        for (let b of blocksNeeded) {
            for(let i=0; i<5; i++) {
                 const rKey = allKeys[Math.floor(Math.random()*allKeys.length)];
                 const res = await fetch(this.indexData[rKey].json);
                 const d = await res.json();
                 const q = d[i]; 
                 q.quest = "[ДОП] " + q.quest;
                 extra.push(q);
            }
        }
        
        this.state.questions = this.state.questions.concat(extra);
        this.renderExamDashboard();
    },

    finishExamRound() {
        let fatal = false;
        let newErrors = [];
        
        this.state.questions.forEach((q, i) => {
            const ans = this.state.answers[i];
            if (!ans || ans !== q.otvet) {
                newErrors.push(q);
                if (i >= 20) fatal = true; 
            }
        });
        this.state.wrongAnswersList = newErrors;

        if (fatal) {
            this.finishExam(false, "Ошибка в дополнительном вопросе. Экзамен не сдан.");
        } else {
            const answeredTotal = Object.keys(this.state.answers).length;
            if (answeredTotal < this.state.questions.length) {
                this.finishExam(false, "Вы ответили не на все вопросы.");
            } else {
                this.finishExam(true, "Экзамен сдан (с доп. вопросами).");
            }
        }
    },

    finishExam(success, msg) {
        this.stopTimer();
        const modal = document.getElementById('exam-result-modal');
        const title = document.getElementById('modal-res-title');
        const text = document.getElementById('modal-res-text');
        
        title.innerText = success ? "ЭКЗАМЕН СДАН" : "ЭКЗАМЕН НЕ СДАН";
        title.style.color = success ? "var(--color-success-fg)" : "var(--color-danger-fg)";
        text.innerText = msg || "";
        
        modal.style.display = 'flex';
        modal.classList.add('open');

        if(!success) {
            this.state.wrongAnswersList.forEach(q => this.addToMistakes(q));
        }

        if (this.userData.examStats) {
            this.userData.examStats.total++;
            if (success) this.userData.examStats.passed++;
            else this.userData.examStats.failed++;
            this.saveUserData();
        }
    },
    
    finishExamReview() {
        document.getElementById('exam-result-modal').classList.remove('open');
        document.getElementById('exam-result-modal').style.display = 'none';
        this.navigate('summary');
        const duration = (20 * 60) - this.state.timeLeft;
        const realDuration = Date.now() - this.state.startTime;
        this.renderSummary(realDuration, this.state.wrongAnswersList);
    },

    renderMistakesMenu() {
        const controls = document.getElementById('mistakes-controls');
        const grid = document.getElementById('mistakes-grid');
        const list = this.userData.mistakes || [];
        
        if (list.length === 0) {
            controls.innerHTML = "<p>Список ошибок пуст</p>";
            grid.innerHTML = "";
            return;
        }

        controls.innerHTML = `
             <p style="margin-bottom: 20px;">Накоплено ошибок: <b>${list.length}</b></p>
             <button class="primary-btn large-btn" onclick="app.startMistakes()">Тренировать все</button>
             <div style="margin-top:15px;">
                <button class="nav-btn" style="color:red; border:1px solid #ccc; font-size:12px;" onclick="app.userData.mistakes=[]; app.saveUserData(); app.renderMistakesMenu()">Очистить список</button>
             </div>`;

        grid.innerHTML = list.map((item, idx) => {
            const q = item.data;
            let imgUrl = 'style="display:none"';
            if (q.realUrl && q.realUrl !== 'no_image') {
                const fName = `${this.pad(q.biletNumber)}${this.pad(q.questNumber)}.jpg`;
                imgUrl = `src="image/${fName}"`;
            }

            return `
                <div class="exam-card mistake-card" onclick="app.reviewMistake(${idx})">
                    <span class="exam-card-num">${idx + 1}</span>
                    <img ${imgUrl} class="exam-card-img" onerror="this.style.display='none'">
                    <div class="exam-card-body">
                        <b>Б.${q.biletNumber} В.${q.questNumber}</b><br>
                        ${q.quest}
                    </div>
                </div>
            `;
        }).join('');
    },

    startMistakes() {
        this.startSession('mistakes');
        this.state.questions = this.userData.mistakes.map(m => m.data);
        this.renderTrainingView();
    },

    reviewMistake(idx) {
        this.startMistakes(); 
        this.jumpTo(idx);     
    },
    
    addToMistakes(q) {
        if (!this.userData.mistakes) this.userData.mistakes = [];
        if(!this.userData.mistakes.some(m => m.bilet === q.biletNumber && m.quest === q.questNumber)) {
            this.userData.mistakes.push({ bilet: q.biletNumber, quest: q.questNumber, data: q });
            this.saveUserData();
        }
    },

    setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (this.state.mode === 'exam' && document.getElementById('exam-modal').classList.contains('open')) {
                const key = e.key;
                if (['1','2','3','4'].includes(key)) {
                    this.selectExamAnswer(parseInt(key));
                }
                if (key === 'Enter') {
                    this.confirmExamAnswer();
                }
                if (key === 'Escape') {
                    this.closeExamModal();
                }
            }
        });
    },

    confirmExit() {
        this.stopTimer();
        this.state.mode = 'idle'; 
        this.state.timeLeft = 0;
        
        document.getElementById('confirm-modal').classList.remove('open');
        
        if (this.pendingView) {
            this.navigate(this.pendingView);
            this.pendingView = null;
        } else {
            this.navigate('tickets');
        }
    },

    cancelExit() {
        document.getElementById('confirm-modal').classList.remove('open');
        this.pendingView = null;
    },
    
    renderSummary(durationMs, errors) {
        let m = Math.floor(durationMs / 60000);
        let s = Math.floor((durationMs % 60000) / 1000);
        if (m<0) m=0; if(s<0) s=0;
        
        document.getElementById('sum-time').innerText = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
        document.getElementById('sum-errors').innerText = errors.length;

        const list = document.getElementById('summary-errors-list');
        if (errors.length === 0) {
            list.innerHTML = "<p style='color:green; font-weight:bold; margin-top:20px;'>Нет ошибок</p>";
        } else {
            list.innerHTML = errors.map(q => `
                <div class="question-card" style="border-left:4px solid var(--color-danger-fg); text-align:left; margin-bottom:15px;">
                    <div class="q-meta">Билет ${q.biletNumber}, Вопрос ${q.questNumber}</div>
                    <div style="font-weight:600; margin-bottom:10px;">${q.quest}</div>
                    <div style="color:var(--color-success-fg); font-weight:bold;">Правильный ответ: ${q.otvet}</div>
                    <div style="margin-top:10px; font-size:13px; color:#555;">${this.formatComment(q.comments)}</div>
                </div>
            `).join('');
        }
    },

    stopTimer() { clearInterval(this.state.timer); },
    pad(n) { return n.toString().padStart(2,'0'); },
    
    formatComment(t) { 
        return t.replace(/\[image\].*?\[\/image\]/g, '') 
                .replace(/\[(.*?)\]\(.*?\)/g, '<b>$1</b>') 
                .replace(/\n/g, '<br>'); 
    }
    
};


app.init();
