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
        currentTicketKey: null, // Для восстановления
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

            // Загрузка индекса
            const res = await fetch('index.json');
            this.indexData = await res.json();
            
            this.initGoogleAuth();
            this.setupKeyboard();

            // Проверка сохраненной сессии
            const savedUser = localStorage.getItem('pdd_current_user');
            
            if (savedUser) {
                // Восстанавливаем данные пользователя
                this.currentUser = savedUser;
                this.userAvatar = localStorage.getItem('pdd_current_avatar');
                this.authSource = localStorage.getItem('pdd_auth_source') || 'local';
                this.remoteId = localStorage.getItem('pdd_remote_id');
                
                await this.loadUserData();
                
                // Рендер шапки
                this.renderHeaderUser();
                document.getElementById('main-header').style.display = 'flex';
                this.renderMenu();
                
                // --- ЛОГИКА ВОССТАНОВЛЕНИЯ (ИСПРАВЛЕНИЕ МИГАНИЯ) ---
                document.body.classList.add('app-loaded'); // Показываем контент

                const lastView = localStorage.getItem('pdd_last_view');
                if (lastView && lastView !== 'auth') {
                    // Если были в вопросах, пробуем восстановить контекст
                    if (lastView === 'questions') {
                         const lastMode = localStorage.getItem('pdd_last_mode');
                         const lastTicket = localStorage.getItem('pdd_last_ticket_key');
                         const lastIdx = parseInt(localStorage.getItem('pdd_last_q_index') || '0');
                         
                         if (lastMode === 'training' && lastTicket) {
                             await this.loadTicket(lastTicket);
                             this.jumpTo(lastIdx);
                             return;
                         } 
                         // Если марафон или что-то сложное, лучше вернуть в меню, но в нужное
                         if (lastMode === 'marathon') {
                             // Можно добавить автостарт марафона, но пока вернем в интро
                             this.navigate('marathon-intro');
                             return;
                         }
                    }
                    this.navigate(lastView);
                } else {
                    this.navigate('tickets');
                }

            } else {
                // Нет сессии -> на вход
                document.body.classList.add('app-loaded');
                this.navigate('auth'); 
            }
            
        } catch (e) { console.error("Init Error:", e); }
    },

    // --- DB SYNC LOGIC ---
    async loadUserData() {
        let localData = null;
        if (this.currentUser) {
            const data = localStorage.getItem(`pdd_data_${this.currentUser}`);
            if (data) localData = JSON.parse(data);
        }

        if (this.remoteId && this.db) {
            try {
                const snapshot = await this.db.ref('users/' + this.remoteId).get();
                if (snapshot.exists()) {
                    this.userData = snapshot.val();
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
                this.userData = localData || this.resetUserData();
            }
        } else {
            this.userData = localData || this.resetUserData();
        }
        
        if (!this.userData.mistakes) this.userData.mistakes = [];
        if (!this.userData.marathon) this.userData.marathon = {};
        if (!this.userData.examStats) this.userData.examStats = { passed: 0, failed: 0, total: 0 };
    },

    resetUserData() {
        return { mistakes: [], marathon: {}, examStats: { passed: 0, failed: 0, total: 0 }, ticketsSolved: 0 };
    },

    saveUserData() {
        if (!this.currentUser) return;
        this.saveLocal();
        if (this.remoteId && this.db) {
            this.db.ref('users/' + this.remoteId).set(this.userData).catch(err => console.error(err));
        }
    },

    saveLocal() {
        localStorage.setItem(`pdd_data_${this.currentUser}`, JSON.stringify(this.userData));
    },

    // --- AUTH SYSTEM ---
    loginVK() {
        if (!window.VK) return alert('VK API не загрузился.');
        VK.Auth.login((response) => {
            if (response.session) {
                const user = response.session.user;
                this.authSuccess((user.first_name + " " + user.last_name).trim(), `https://vk.com/images/camera_200.png`, 'vk', 'vk_' + user.id);
            }
        }, 4);
    },

    initGoogleAuth() {
        if (!window.google) return;
        window.google.accounts.id.initialize({ client_id: this.GOOGLE_CLIENT_ID, callback: this.handleGoogleCredential.bind(this) });
        window.google.accounts.id.renderButton(document.getElementById("google_btn_container"), { theme: "outline", size: "large", width: "100%", text: "continue_with" });
    },

    handleGoogleCredential(response) {
        const payload = this.decodeJwt(response.credential);
        const emailId = 'google_' + (payload.email.replace(/\./g, ',').replace(/@/g, '_at_'));
        this.authSuccess(payload.name || payload.email, payload.picture, 'google', emailId);
    },

    decodeJwt(token) {
        try {
            return JSON.parse(decodeURIComponent(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
        } catch (e) { return {}; }
    },

    performAuth() {
        const login = document.getElementById('auth-login').value.trim();
        const pass = document.getElementById('auth-pass').value.trim();
        if (!login || !pass) return alert("Введите логин и пароль");
        let users = JSON.parse(localStorage.getItem('pdd_users_db') || '{}');
        
        if (this.authMode === 'register') {
            if (users[login]) return alert("Пользователь уже существует");
            users[login] = pass; 
            localStorage.setItem('pdd_users_db', JSON.stringify(users));
            this.authSuccess(login, null, 'local', null);
        } else {
            if (users[login] === pass) this.authSuccess(login, null, 'local', null);
            else alert("Неверный логин или пароль");
        }
    },

    authSuccess(user, avatar, source, remoteId) {
        this.currentUser = user;
        this.userAvatar = avatar;
        this.authSource = source;
        this.remoteId = remoteId;
        
        this.saveSession();
        this.loadUserData().then(() => {
            this.renderHeaderUser();
            this.renderMenu();
            document.getElementById('main-header').style.display = 'flex';
            document.body.classList.add('app-loaded');
            this.navigate('tickets');
        });
    },

    saveSession() {
        localStorage.setItem('pdd_current_user', this.currentUser);
        localStorage.setItem('pdd_auth_source', this.authSource);
        if (this.userAvatar) localStorage.setItem('pdd_current_avatar', this.userAvatar);
        if (this.remoteId) localStorage.setItem('pdd_remote_id', this.remoteId);
    },

    toggleAuthMode() {
        this.authMode = this.authMode === 'login' ? 'register' : 'login';
        document.getElementById('auth-title').innerText = this.authMode === 'login' ? 'Вход в профиль' : 'Регистрация';
        document.getElementById('auth-toggle-text').innerText = this.authMode === 'login' ? 'Нет аккаунта?' : 'Есть аккаунт?';
        document.querySelector('.auth-footer button').innerText = this.authMode === 'login' ? 'Зарегистрироваться' : 'Войти';
        document.querySelector('.auth-form button').innerText = this.authMode === 'login' ? 'Войти' : 'Создать аккаунт';
    },

    logout() {
        localStorage.clear(); // Полная очистка для выхода
        location.reload();
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
        this.currentUser ? this.navigate('profile') : this.navigate('auth');
        if(this.currentUser) this.renderProfileStats();
    },

    renderProfileStats() {
        document.getElementById('profile-name').innerText = this.currentUser;
        const syncText = document.getElementById('profile-sync-status');
        syncText.innerText = this.authSource === 'local' ? "Локальный профиль (нет синхронизации) ⚠️" : "Синхронизация активна ✅";
        document.getElementById('profile-avatar-large').innerHTML = this.userAvatar ? `<img src="${this.userAvatar}">` : '👤';
        document.getElementById('stat-tickets').innerText = this.userData.ticketsSolved || 0;
        document.getElementById('stat-mistakes').innerText = (this.userData.mistakes || []).length;
        const exams = this.userData.examStats || {passed:0, failed:0};
        document.getElementById('stat-exam').innerText = `${exams.passed + exams.failed > 0 ? Math.round((exams.passed / (exams.passed + exams.failed)) * 100) : 0}%`;
        document.getElementById('stat-marathon').innerText = `${Object.keys(this.userData.marathon || {}).length}/800`;
    },

    navigate(view) {
        if (!this.currentUser && view !== 'auth') return this.navigate('auth');

        const isExamActive = this.state.mode === 'exam' && this.state.timeLeft > 0;
        const isExamViews = view === 'exam-dashboard' || view === 'exam-start' || view === 'result';
        
        if (isExamActive && !isExamViews) {
            this.pendingView = view;
            document.getElementById('confirm-modal').classList.add('open');
            return;
        }

        // Сохраняем состояние (где мы сейчас)
        localStorage.setItem('pdd_last_view', view);

        document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
        
        // Подсветка кнопок
        let btnView = view;
        if (view === 'questions') {
             if (this.state.mode === 'training') btnView = 'tickets';
             if (this.state.mode === 'range') btnView = 'ranges';
             if (this.state.mode === 'mistakes') btnView = 'mistakes';
        }
        
        const btn = document.querySelector(`.nav-btn[onclick="app.navigate('${btnView}')"]`);
        if (btn) btn.classList.add('active');

        const el = document.getElementById(`view-${view}`);
        if (el) el.classList.add('active');
        
        if (view === 'mistakes') this.renderMistakesMenu();
        
        window.scrollTo(0,0);
    },

    goBack() {
        if (this.state.mode === 'exam' && this.state.timeLeft > 0) this.navigate('exam-start');
        else if (this.state.mode === 'range') this.navigate('ranges');
        else if (this.state.mode === 'mistakes') this.navigate('mistakes');
        else this.navigate('tickets');
        
        if (this.state.mode !== 'exam') this.state.questions = [];
    },

    async getAllQuestions() {
        const keys = Object.keys(this.indexData).sort((a,b) => parseInt(a.replace('b','')) - parseInt(b.replace('b','')));
        let allQ = [];
        for (let key of keys) {
            const res = await fetch(this.indexData[key].json);
            allQ = allQ.concat(await res.json());
        }
        return allQ;
    },

    renderMenu() {
        if(!this.indexData) return;
        const menu = document.getElementById('tickets-menu');
        const sortedKeys = Object.keys(this.indexData).sort((a,b) => parseInt(a.replace('b','')) - parseInt(b.replace('b','')));
        menu.innerHTML = sortedKeys.map(key => `
            <button onclick="app.loadTicket('${key}')">Билет ${key.replace('b','')}</button>
        `).join('');
    },

    async loadTicket(key) {
        this.startSession('training');
        this.state.currentTicketKey = key;
        // Сохраняем, какой билет открыли
        localStorage.setItem('pdd_last_ticket_key', key);
        
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
        if (startVal < 1 || startVal > 20 || endVal < 1 || endVal > 20 || startVal > endVal) return alert("Неверный диапазон");

        this.startSession('range');
        const all = await this.getAllQuestions();
        let filtered = all.filter(q => q.questNumber >= startVal && q.questNumber <= endVal);
        // Shuffle
        for (let i = filtered.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
        }
        this.state.questions = filtered;
        this.renderTrainingView();
    },

    startSession(mode) {
        this.state.mode = mode;
        this.state.currentIndex = 0;
        this.state.answers = {};
        this.state.questions = [];
        this.state.wrongAnswersList = [];
        this.state.startTime = Date.now();
        this.state.currentTicketKey = null;
        
        localStorage.setItem('pdd_last_mode', mode);
        
        this.stopTimer();
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
        
        // Инициализация свайпов
        this.initSwipe();
        this.renderCurrentQuestion();
    },

    renderMarathonGrid() {
        const container = document.getElementById('marathon-pagination');
        container.innerHTML = this.state.questions.map((_, i) => {
            let cls = 'marathon-btn';
            if (this.userData.marathon[i] !== undefined) cls += this.userData.marathon[i] === 1 ? ' correct' : ' wrong';
            return `<button class="${cls}" onclick="app.jumpTo(${i})" id="m-btn-${i}">${i+1}</button>`;
        }).join('');
    },

    updateMarathonStats() {
        if (this.state.mode !== 'marathon') return;
        let correct = 0, wrong = 0;
        Object.values(this.userData.marathon).forEach(val => val === 1 ? correct++ : wrong++);
        document.getElementById('m-correct').innerText = correct;
        document.getElementById('m-wrong').innerText = wrong;
        document.getElementById('m-total').innerText = `${correct + wrong}/${this.state.questions.length}`;
    },

    renderCurrentQuestion() {
        const { questions, currentIndex, answers, mode } = this.state;
        const q = questions[currentIndex];
        
        // Сохраняем индекс
        localStorage.setItem('pdd_last_q_index', currentIndex);

        // Пагинация
        if (mode === 'marathon') {
            document.querySelectorAll('.marathon-btn.active').forEach(b => b.classList.remove('active'));
            const curBtn = document.getElementById(`m-btn-${currentIndex}`);
            if(curBtn) { curBtn.classList.add('active'); curBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        } else {
            const pgContainer = document.getElementById('pagination');
            pgContainer.innerHTML = questions.map((_, i) => {
                let cls = 'page-btn';
                if (answers[i] !== undefined) cls += (answers[i] === questions[i].otvet) ? ' status-correct' : ' status-wrong';
                if (i === currentIndex) cls += ' current';
                return `<button class="${cls}" onclick="app.jumpTo(${i})">${i+1}</button>`;
            }).join('');
            if(pgContainer.children[currentIndex]) pgContainer.children[currentIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }

        const container = document.getElementById('current-question-container');
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
            return `<li><button class="answer-btn ${cls}" ${isAnswered ? 'disabled' : ''} onclick="app.handleTrainingAnswer(${idx})">
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
                <div style="text-align: center; margin-top: 15px;">
                    <button style="border:none; background:none; text-decoration:underline; color:#0969da; cursor:pointer; font-size:14px;" onclick="app.toggleHint()">💡 Показать подсказку</button>
                </div>
                <div id="hint-box" class="hint-block ${isAnswered && userAnswer !== q.otvet ? 'visible' : ''}">
                    <strong>Пояснение:</strong><br>${this.formatComment(q.comments)}
                </div>
            </div>
        `;

        // Кнопки навигации
        document.getElementById('btn-prev').style.display = currentIndex > 0 ? 'inline-block' : 'none';
        document.getElementById('btn-next').style.display = currentIndex < questions.length - 1 ? 'inline-block' : 'none';
        document.getElementById('btn-finish-train').style.display = currentIndex >= questions.length - 1 ? 'inline-block' : 'none';
        
        // Скролл наверх
        if(!isAnswered) document.querySelector('main').scrollTo({ top: 0, behavior: 'smooth' });
    },
    
    // === ЛОГИКА СВАЙПОВ ===
    initSwipe: function() {
        const container = document.getElementById('current-question-container');
        // Удаляем старые, чтобы не дублировать
        if(this._swipeStart) container.removeEventListener('touchstart', this._swipeStart);
        if(this._swipeEnd) container.removeEventListener('touchend', this._swipeEnd);
        
        let touchStartX = 0;
        
        this._swipeStart = (e) => { touchStartX = e.changedTouches[0].screenX; };
        this._swipeEnd = (e) => {
            const touchEndX = e.changedTouches[0].screenX;
            const diff = touchEndX - touchStartX;
            if (Math.abs(diff) > 50) { // Мин. длина свайпа
                if (diff < 0) this.nextQuestion(); // Свайп влево (след)
                else this.prevQuestion(); // Свайп вправо (пред)
            }
        };

        container.addEventListener('touchstart', this._swipeStart, {passive: true});
        container.addEventListener('touchend', this._swipeEnd, {passive: true});
    },

    toggleHint() { document.getElementById('hint-box').classList.toggle('visible'); },

    handleTrainingAnswer(idx) {
        const { currentIndex, questions, mode } = this.state;
        if (this.state.answers[currentIndex] !== undefined) return;

        const ansNum = idx + 1;
        this.state.answers[currentIndex] = ansNum;
        const isCorrect = (ansNum === questions[currentIndex].otvet);
        
        if (!isCorrect) {
            this.state.wrongAnswersList.push(questions[currentIndex]);
            this.addToMistakes(questions[currentIndex]);
            const box = document.getElementById('hint-box');
            if(box) box.classList.add('visible');
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
            if (gridBtn) gridBtn.className += isCorrect ? ' correct' : ' wrong';
        }
        this.renderCurrentQuestion();
    },

    nextQuestion() {
        if (this.state.currentIndex < this.state.questions.length - 1) {
            this.state.currentIndex++;
            this.renderCurrentQuestion();
        }
    },
    
    prevQuestion() {
        if (this.state.currentIndex > 0) {
            this.state.currentIndex--;
            this.renderCurrentQuestion();
        }
    },
    
    jumpTo(idx) {
        this.state.currentIndex = idx;
        this.renderCurrentQuestion();
    },

    finishTraining() {
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

    closeExamModal() { document.getElementById('exam-modal').classList.remove('open'); },

    updateExamTimer() {
        const m = Math.floor(this.state.timeLeft / 60).toString().padStart(2,'0');
        const s = (this.state.timeLeft % 60).toString().padStart(2,'0');
        const el = document.getElementById('dash-timer');
        if(el) el.innerText = `${m}:${s}`;
    },

    finishExamEarly() { if(confirm("Завершить экзамен?")) this.checkExamResults(); },

    async checkExamResults() {
        if (this.state.isExtraRound) return this.finishExamRound();
        
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
        if (Object.values(blocks).some(c => c >= 2)) return this.finishExam(false, "Не сдано. 2 ошибки в блоке.");

        if (errCount > 0) await this.addExtraQuestions(blocks);
        else this.finishExam(true, "Сдано без ошибок! 🎉");
    },

    async addExtraQuestions(blocks) {
        this.state.isExtraRound = true;
        this.state.timeLeft += (Object.values(blocks).reduce((a,b)=>a+b,0) * 5) * 60; 
        alert("Добавлены доп. вопросы. Ошибаться нельзя!");
        const allKeys = Object.keys(this.indexData);
        let extra = [];
        const blocksNeeded = Object.keys(blocks).filter(k => blocks[k] > 0);
        for (let b of blocksNeeded) {
            for(let i=0; i<5; i++) {
                 const rKey = allKeys[Math.floor(Math.random()*allKeys.length)];
                 const res = await fetch(this.indexData[rKey].json);
                 const d = await res.json();
                 const q = d[i]; q.quest = "[ДОП] " + q.quest;
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
        if (fatal) this.finishExam(false, "Ошибка в доп. вопросе.");
        else if (Object.keys(this.state.answers).length < this.state.questions.length) this.finishExam(false, "Не все ответы даны.");
        else this.finishExam(true, "Экзамен сдан (с доп. вопросами).");
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

        if(!success) this.state.wrongAnswersList.forEach(q => this.addToMistakes(q));
        if (this.userData.examStats) {
            this.userData.examStats.total++;
            if (success) this.userData.examStats.passed++; else this.userData.examStats.failed++;
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
            let imgUrl = q.realUrl ? `src="image/${this.pad(q.biletNumber)}${this.pad(q.questNumber)}.jpg"` : '';
            return `
                <div class="exam-card mistake-card" onclick="app.reviewMistake(${idx})">
                    <span class="exam-card-num">${idx + 1}</span>
                    <img ${imgUrl} class="exam-card-img" onerror="this.style.display='none'">
                    <div class="exam-card-body">
                        <b>Б.${q.biletNumber} В.${q.questNumber}</b><br>${q.quest}
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

    reviewMistake(idx) { this.startMistakes(); this.jumpTo(idx); },
    
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
                if (['1','2','3','4'].includes(key)) this.selectExamAnswer(parseInt(key));
                if (key === 'Enter') this.confirmExamAnswer();
                if (key === 'Escape') this.closeExamModal();
            }
        });
    },

    confirmExit() {
        this.stopTimer(); this.state.mode = 'idle'; this.state.timeLeft = 0;
        document.getElementById('confirm-modal').classList.remove('open');
        this.navigate(this.pendingView || 'tickets');
        this.pendingView = null;
    },

    cancelExit() { document.getElementById('confirm-modal').classList.remove('open'); this.pendingView = null; },

    renderSummary(durationMs, errors) {
        let m = Math.floor(durationMs / 60000);
        let s = Math.floor((durationMs % 60000) / 1000);
        document.getElementById('sum-time').innerText = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
        document.getElementById('sum-errors').innerText = errors.length;

        const list = document.getElementById('summary-errors-list');
        list.innerHTML = errors.length === 0 
            ? "<p style='color:green; font-weight:bold; margin-top:20px;'>Нет ошибок</p>" 
            : errors.map(q => `
                <div class="question-card" style="border-left:4px solid var(--color-danger-fg); text-align:left; margin-bottom:15px;">
                    <div class="q-meta">Билет ${q.biletNumber}, Вопрос ${q.questNumber}</div>
                    <div style="font-weight:600; margin-bottom:10px;">${q.quest}</div>
                    <div style="color:var(--color-success-fg); font-weight:bold;">Правильный ответ: ${q.otvet}</div>
                    <div style="margin-top:10px; font-size:13px; color:#555;">${this.formatComment(q.comments)}</div>
                </div>
            `).join('');
    },

    stopTimer() { clearInterval(this.state.timer); },
    pad(n) { return n.toString().padStart(2,'0'); },
    formatComment(t) { return t.replace(/\[image\].*?\[\/image\]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '<b>$1</b>').replace(/\n/g, '<br>'); }
};

app.init();
