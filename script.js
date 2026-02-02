const app = {
    indexData: null,
    currentUser: null,
    userData: { mistakes: [], marathon: {}, examStats: { passed: 0, failed: 0, total: 0 }, ticketsSolved: 0 },
    
    // Config
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
        mode: 'idle', // training, range, marathon, exam, mistakes
        questions: [],
        currentIndex: 0,
        answers: {},
        startTime: 0,
        wrongAnswersList: [],
        timer: null,
        timeLeft: 0,
        currentTicketId: null
    },

    touchStartX: 0,
    touchEndX: 0,

    async init() {
        // Запускаем Firebase
        if(window.firebase && !firebase.apps.length) {
            firebase.initializeApp(this.FIREBASE_CONFIG);
            this.db = firebase.database();
        }
        // Запускаем VK
        if (window.VK) VK.init({ apiId: this.VK_APP_ID });
        // Запускаем Google
        this.initGoogleAuth();

        try {
            const res = await fetch('index.json');
            this.indexData = await res.json();
            
            // Проверка сессии
            const savedUser = localStorage.getItem('pdd_current_user');
            if (savedUser) {
                this.currentUser = savedUser;
                this.userAvatar = localStorage.getItem('pdd_current_avatar');
                this.authSource = localStorage.getItem('pdd_auth_source') || 'local';
                this.remoteId = localStorage.getItem('pdd_remote_id');
                
                await this.loadUserData(); // Загрузка статистики
                
                // ВОССТАНОВЛЕНИЕ СОСТОЯНИЯ (КЛЮЧЕВОЙ МОМЕНТ)
                const savedState = localStorage.getItem('pdd_last_state');
                if (savedState) {
                    const parsed = JSON.parse(savedState);
                    // Если были в процессе обучения (не экзамен), восстанавливаем
                    if (parsed.view === 'questions' && parsed.mode !== 'exam') {
                        this.restoreSession(parsed);
                    } else {
                        this.onLoginSuccess(parsed.view === 'exam-start' ? 'exam-start' : 'tickets');
                    }
                } else {
                    this.onLoginSuccess('tickets');
                }
            } else {
                this.hideLoader();
                this.navigate('auth');
            }
            
            this.setupSwipe();

        } catch (e) { 
            console.error("Init Error:", e);
            this.hideLoader();
        }
    },

    hideLoader() {
        document.body.classList.remove('loading-state');
    },

    // --- STATE MANAGEMENT ---
    saveState() {
        // Не сохраняем состояние во время экзамена (там своя логика защиты)
        if (this.state.mode === 'exam') return;

        const data = {
            view: document.querySelector('.view-section.active')?.id.replace('view-', '') || 'tickets',
            mode: this.state.mode,
            currentIndex: this.state.currentIndex,
            answers: this.state.answers,
            ticketId: this.state.currentTicketId,
            questions: this.state.questions, // Можно оптимизировать, сохраняя только ID
            startTime: this.state.startTime,
            wrongList: this.state.wrongAnswersList
        };
        localStorage.setItem('pdd_last_state', JSON.stringify(data));
    },

    async restoreSession(data) {
        this.state.mode = data.mode;
        this.state.questions = data.questions;
        this.state.currentIndex = data.currentIndex || 0;
        this.state.answers = data.answers || {};
        this.state.currentTicketId = data.ticketId;
        this.state.startTime = data.startTime;
        this.state.wrongAnswersList = data.wrongList || [];

        this.renderHeaderUser();
        document.getElementById('main-header').style.display = 'block';
        this.renderTrainingView();
        this.hideLoader();
    },

    clearState() {
        localStorage.removeItem('pdd_last_state');
    },

    // --- NAVIGATION ---
    navigate(view) {
        if (!this.currentUser && view !== 'auth') return;

        // Защита выхода из экзамена
        const isExamActive = this.state.mode === 'exam' && this.state.timeLeft > 0;
        if (isExamActive && !['exam-dashboard', 'exam-start', 'result'].includes(view)) {
            this.pendingView = view;
            document.getElementById('confirm-modal').classList.add('open');
            return;
        }

        // UI Updates
        document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

        const navBtn = document.querySelector(`.nav-btn[data-target="${view}"]`);
        if (navBtn) navBtn.classList.add('active');

        // Mappings
        let targetId = `view-${view}`;
        if (view === 'questions') targetId = 'view-questions'; // Fixed ID
        
        const el = document.getElementById(targetId);
        if (el) el.classList.add('active');

        // Special handlers
        if (view === 'mistakes') this.renderMistakesMenu();
        if (view === 'tickets') this.renderMenu();
        if (view !== 'questions') this.clearState(); // Clear state if leaving training

        window.scrollTo(0, 0);
    },

    goBack() {
        if (this.state.mode === 'exam') return;
        this.navigate(this.state.mode === 'range' ? 'ranges' : 'tickets');
    },

    // --- CORE LOGIC (Simplified for brevity) ---
    async loadTicket(key) {
        this.startSession('training');
        this.state.currentTicketId = key;
        const res = await fetch(this.indexData[key].json);
        this.state.questions = await res.json();
        this.renderTrainingView();
        this.saveState();
    },

    startSession(mode) {
        this.state.mode = mode;
        this.state.currentIndex = 0;
        this.state.answers = {};
        this.state.questions = [];
        this.state.wrongAnswersList = [];
        this.state.startTime = Date.now();
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
    },

    // --- RENDER QUESTION (With Animation Support) ---
    renderCurrentQuestion(animClass = '') {
        const { questions, currentIndex, answers } = this.state;
        const q = questions[currentIndex];
        const wrapper = document.getElementById('current-question-container');

        // 1. Pagination Update
        this.updatePaginationUI();

        if (!q) return;

        // 2. Build Content
        const userAnswer = answers[currentIndex];
        const isAnswered = userAnswer !== undefined;
        
        let imgHTML = '';
        if (q.realUrl && q.realUrl !== 'no_image') {
            const fName = `${this.pad(q.biletNumber)}${this.pad(q.questNumber)}.jpg`;
            imgHTML = `<img src="image/${fName}" class="q-image" loading="lazy">`;
        }

        const answersHTML = q.v.map((text, idx) => {
            if (!text) return '';
            const ansNum = idx + 1;
            let cls = '';
            if (isAnswered) {
                if (ansNum === q.otvet) cls = 'correct';
                else if (ansNum === userAnswer) cls = 'wrong';
            }
            // Убираем onclick если уже отвечено
            const clickHandler = isAnswered ? '' : `onclick="app.handleTrainingAnswer(${idx})"`;
            return `<li><button class="answer-btn ${cls}" ${clickHandler}>
                <span>${ansNum}</span> <span>${text}</span>
            </button></li>`;
        }).join('');

        const hintContent = `
            <div class="hint-block ${isAnswered && userAnswer !== q.otvet ? 'visible' : ''}">
                <strong>Пояснение:</strong><br>${this.formatComment(q.comments)}
            </div>`;

        const newHTML = `
            <div class="question-card ${animClass}">
                <div class="q-meta">Билет ${q.biletNumber} • Вопрос ${q.questNumber}</div>
                <div class="q-text">${q.quest}</div>
                ${imgHTML}
                <ul class="answers-list">${answersHTML}</ul>
                ${hintContent}
            </div>
        `;

        wrapper.innerHTML = newHTML;
        
        // Save state after render
        this.saveState();
    },

    updatePaginationUI() {
        if(this.state.mode === 'marathon') {
             // Logic for marathon grid scroll
             const btn = document.getElementById(`m-btn-${this.state.currentIndex}`);
             if(btn) btn.scrollIntoView({ block: 'nearest', inline: 'center' });
             return;
        }

        const pgContainer = document.getElementById('pagination');
        pgContainer.innerHTML = this.state.questions.map((q, i) => {
            let cls = '';
            const ans = this.state.answers[i];
            if (ans !== undefined) cls = (ans === q.otvet) ? 'status-correct' : 'status-wrong';
            if (i === this.state.currentIndex) cls += ' current';
            return `<button class="page-btn ${cls}" onclick="app.jumpTo(${i})">${i+1}</button>`;
        }).join('');
        
        const cur = pgContainer.children[this.state.currentIndex];
        if(cur) cur.scrollIntoView({ behavior: 'smooth', inline: 'center' });
    },

    handleTrainingAnswer(idx) {
        const { currentIndex, questions } = this.state;
        const ansNum = idx + 1;
        this.state.answers[currentIndex] = ansNum;
        
        const isCorrect = (ansNum === questions[currentIndex].otvet);
        if (!isCorrect) {
            this.state.wrongAnswersList.push(questions[currentIndex]);
            this.addToMistakes(questions[currentIndex]);
        }

        // Сохраняем статистику
        if (this.state.mode === 'training') {
             this.userData.ticketsSolved++;
             this.saveUserData();
        }
        if (this.state.mode === 'marathon') {
            this.userData.marathon[currentIndex] = isCorrect ? 1 : 0;
            this.saveUserData();
            this.updateMarathonStats();
        }

        this.renderCurrentQuestion();
        
        // Auto-next delay if correct
        if (isCorrect && this.state.mode !== 'exam') {
             setTimeout(() => this.nextQuestion(), 500);
        }
    },

    // --- SWIPE & NAVIGATION ACTIONS ---
    setupSwipe() {
        const zone = document.getElementById('view-questions');
        zone.addEventListener('touchstart', e => {
            this.touchStartX = e.changedTouches[0].screenX;
        }, {passive: true});

        zone.addEventListener('touchend', e => {
            this.touchEndX = e.changedTouches[0].screenX;
            this.handleSwipe();
        }, {passive: true});
    },

    handleSwipe() {
        // Disable swipe in exam
        if (this.state.mode === 'exam') return;
        
        const threshold = 50;
        if (this.touchEndX < this.touchStartX - threshold) {
            this.nextQuestion(); // Swipe Left -> Next
        }
        if (this.touchEndX > this.touchStartX + threshold) {
            this.prevQuestion(); // Swipe Right -> Prev
        }
    },

    nextQuestion() {
        if (this.state.currentIndex < this.state.questions.length - 1) {
            this.state.currentIndex++;
            this.renderCurrentQuestion('slide-in-right');
        } else if (this.state.mode !== 'marathon') {
            this.finishTraining();
        }
    },

    prevQuestion() {
        if (this.state.currentIndex > 0) {
            this.state.currentIndex--;
            this.renderCurrentQuestion('slide-in-left');
        }
    },

    jumpTo(idx) {
        const dir = idx > this.state.currentIndex ? 'slide-in-right' : 'slide-in-left';
        this.state.currentIndex = idx;
        this.renderCurrentQuestion(dir);
    },

    // --- OTHER HELPERS (Auth, Exam, etc from original) ---
    // [Здесь оставьте методы startRealExam, renderMenu, loginVK и прочие из оригинального кода]
    // [Обязательно добавьте методы loadUserData и saveUserData как в оригинале]
    
    // Stub for brevity in this response (Use original logic here):
    renderMenu() {
        if(!this.indexData) return;
        const menu = document.getElementById('tickets-menu');
        const sortedKeys = Object.keys(this.indexData).sort((a,b) => parseInt(a.replace('b','')) - parseInt(b.replace('b','')));
        menu.innerHTML = sortedKeys.map(key => `
            <button onclick="app.loadTicket('${key}')">Билет ${key.replace('b','')}</button>
        `).join('');
    },
    
    onLoginSuccess(targetView = 'tickets') {
        this.renderHeaderUser();
        document.getElementById('main-header').style.display = 'block'; 
        this.navigate(targetView);
        this.hideLoader();
    },

    renderHeaderUser() {
        const av = document.getElementById('header-avatar');
        if (this.userAvatar) av.style.backgroundImage = `url('${this.userAvatar}')`;
        else av.style.backgroundImage = 'none';
        
        document.getElementById('profile-name').innerText = this.currentUser || 'Гость';
        document.getElementById('profile-avatar-large').style.backgroundImage = this.userAvatar ? `url('${this.userAvatar}')` : 'none';
    },

    pad(n) { return n.toString().padStart(2,'0'); },
    formatComment(t) { return t.replace(/\[image\].*?\[\/image\]/g, '').replace(/\n/g, '<br>'); },
    
    // Auth stubs (copy full logic from original)
    initGoogleAuth() { /* Original Code */ },
    loginVK() { /* Original Code */ },
    performAuth() { /* Original Code */ },
    toggleAuthMode() { /* Original Code */ },
    loadUserData() { return Promise.resolve(); /* Add actual DB logic */ },
    saveUserData() { /* Add actual DB logic */ },
    logout() { 
        this.clearState(); 
        localStorage.removeItem('pdd_current_user'); 
        location.reload(); 
    },
    
    // Mistake logic (copy original)
    addToMistakes(q) { 
        if (!this.userData.mistakes) this.userData.mistakes = [];
        if(!this.userData.mistakes.some(m => m.bilet === q.biletNumber && m.quest === q.questNumber)) {
            this.userData.mistakes.push({ bilet: q.biletNumber, quest: q.questNumber, data: q });
            this.saveUserData();
        }
    },
    renderMistakesMenu() { /* Original logic */ },
    startMistakes() { 
        this.startSession('mistakes');
        this.state.questions = this.userData.mistakes.map(m => m.data);
        this.renderTrainingView();
    }
};

// Запуск
app.init();
