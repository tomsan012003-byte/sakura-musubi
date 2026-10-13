require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const fs = require('fs');
const multer = require('multer');

// ▼▼▼ Google Sheets API 用ライブラリの読み込み ▼▼▼
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// uploadsフォルダを絶対パスで公開
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Google スプレッドシートの設定 ---
const SPREADSHEET_ID = '1GV7cV1EdzqR2aAtY45BBnpocBFQNsPheDfk_yn4vxhM/';

let doc = null;

async function initGoogleSheets() {
    try {
        const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json'), 'utf8'));
        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        console.log('Googleスプレッドシート連携成功:', doc.title);
    } catch (e) {
        console.error('Googleスプレッドシートの連携に失敗しました:', e.message);
    }
}

// ユーザーをスプレッドシートに追加する関数
async function syncUserToSheet(user) {
    if (!doc) return;
    try {
        const sheet = doc.sheetsByIndex[0]; // 最初のシート
        const status = user.isAgeVerified ? '承認済み' : (user.pendingVerification ? '審査中' : '未提出');
        
        await sheet.addRow({
            '登録日時': user.createdAt || new Date().toLocaleDateString('ja-JP'),
            'メールアドレス': user.email,
            '氏名': user.name || '',
            'ニックネーム': user.nickname || '',
            '年齢': user.age || '',
            '性別': user.gender || '',
            '地域': user.region || '',
            '所属寺院': user.temple || '',
            '年齢確認ステータス': status,
            '身分証画像パス': user.idCardImage || ''
        });
    } catch (e) {
        console.error('スプレッドシート書き込みエラー:', e.message);
    }
}

// スプレッドシート上のユーザー情報を更新する関数
async function updateSheetUser(userEmail, updateData) {
    if (!doc) return;
    try {
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();
        const targetRow = rows.find(r => (r.get('メールアドレス') || '').toLowerCase() === userEmail.toLowerCase());
        
        if (targetRow) {
            Object.keys(updateData).forEach(key => {
                targetRow.set(key, updateData[key]);
            });
            await targetRow.save();
        }
    } catch (e) {
        console.error('スプレッドシート更新エラー:', e.message);
    }
}

initGoogleSheets();

// --- データ保存設定 ---
const DATA_FILE = path.join(__dirname, 'data.json');

let users = [];
let messages = [];
const adminEmail = 'admin@mail.com';
let adminPassword = 'admin123';

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            users = data.users || [];
            messages = data.messages || [];
            adminPassword = data.adminPassword || 'admin123';
            console.log('保存されたデータを読み込みました。');
        } catch (e) {
            console.error('データの読み込みに失敗しました:', e);
        }
    } else {
        console.log('データファイルが存在しないため、新規作成します。');
        saveData();
    }
}

function saveData() {
    const data = { users, messages, adminPassword };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

loadData();

// --- ファイルアップロード（multer）の設定 ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        const safeFilename = Date.now() + '-' + Math.round(Math.random() * 1000) + ext;
        cb(null, safeFilename);
    }
});
const upload = multer({ storage: storage });

const pendingRegistrations = {};

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'sakura.musubi01@gmail.com',
        pass: 'xqelimtqgavikxee'
    }
});

function validatePassword(password) {
    return /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{5,}$/.test(password);
}

app.post('/api/send-code', async (req, res) => {
    let { email, password, name, nickname, age, gender, region, temple, photo } = req.body;
    
    if (!email || !email.includes('@')) {
        return res.json({ success: false, message: '有効なメールアドレス（@を含む）を入力してください' });
    }
    
    email = email.toLowerCase();

    if (users.find(u => u.email.toLowerCase() === email) || email === adminEmail.toLowerCase()) {
        return res.json({ success: false, message: 'すでに登録されているメールアドレスです' });
    }
    if (!validatePassword(password)) {
        return res.json({ success: false, message: 'パスワードは英数字を含んだ5文字以上で入力してください' });
    }
    if (age < 20 || age >= 120) {
        return res.json({ success: false, message: '20歳以上の方のみご登録いただけます' });
    }

    const code = Math.floor(1000 + Math.random() * 9000).toString();

    pendingRegistrations[email] = {
        code,
        userData: {
            email, password, name, nickname, age, gender, 
            region: region || '未設定', temple, 
            photo: photo || '',
            income: '', hobbies: '', pr: '', job: '', siblings: '', bloodType: '', birthdate: '',
            photos: [], // サブ写真（最大2枚）
            likes: [], 
            privacy: { income: true, hobbies: true, pr: true, job: true, siblings: true, bloodType: true, birthdate: true },
            emailNotification: true,
            isAgeVerified: false,
            pendingVerification: false,
            idCardImage: '',
            createdAt: new Date().toLocaleDateString('ja-JP')
        }
    };

    const mailOptions = {
        from: 'tomsan012003@gmail.com',
        to: email,
        subject: '【さくら結び】会員登録用 認証コード',
        text: `さくら結びをご利用いただきありがとうございます。\n\n会員登録用の認証コードは以下の4桁です。\n\n${code}\n\nこのコードを登録画面に入力してください。`
    };

    try {
        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: '入力されたメールアドレスに認証コードを送信しました。メールをご確認ください。' });
    } catch (error) {
        console.error('メール送信エラー:', error);
        res.json({ success: false, message: 'メールの送信に失敗しました。メールアドレスが正しいかご確認ください。' });
    }
});

// 新規会員登録完了
app.post('/api/verify-and-register', async (req, res) => {
    let { email, code } = req.body;
    if (email) email = email.toLowerCase();
    
    const pending = pendingRegistrations[email];
    if (!pending) {
        return res.json({ success: false, message: 'セッションが切れているか、メールアドレスが無効です。もう一度はじめから入力してください。' });
    }

    if (pending.code === code) {
        const newUser = pending.userData;
        if (!newUser.likes) newUser.likes = [];
        if (!newUser.photos) newUser.photos = [];
        users.push(newUser);
        delete pendingRegistrations[email];
        saveData();

        await syncUserToSheet(newUser);

        res.json({ success: true, message: '認証成功！会員登録が完了しました。' });
    } else {
        res.json({ success: false, message: '認証コードが違います。' });
    }
});

app.post('/api/login', (req, res) => {
    let { email, password } = req.body;
    if (email) email = email.toLowerCase();

    if (email === adminEmail.toLowerCase() && password === adminPassword) {
        return res.json({ success: true, user: { email: adminEmail, nickname: '管理者', role: 'admin' } });
    }

    const user = users.find(u => u.email.toLowerCase() === email && u.password === password);
    if (!user) {
        return res.json({ success: false, message: 'メールかパスワードが違います' });
    }
    if (!user.likes) user.likes = [];
    if (!user.photos) user.photos = [];
    res.json({ success: true, user: user });
});

app.post('/api/admin/password', (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (currentPassword !== adminPassword) {
        return res.json({ success: false, message: '現在のパスワードが間違っています' });
    }
    if (!validatePassword(newPassword)) {
        return res.json({ success: false, message: '新しいパスワードは英数字を含んだ5文字以上で入力してください' });
    }
    adminPassword = newPassword;
    saveData();
    res.json({ success: true, message: '管理者パスワードを変更しました' });
});

app.get('/api/users', (req, res) => {
    users.forEach(u => { 
        if (!u.likes) u.likes = []; 
        if (!u.photos) u.photos = [];
    });
    res.json(users);
});

// 「気になる人」追加・解除 API
app.post('/api/like', (req, res) => {
    let { myEmail, targetEmail } = req.body;
    if (!myEmail || !targetEmail) {
        return res.json({ success: false, message: '情報が不足しています' });
    }

    myEmail = myEmail.toLowerCase();
    targetEmail = targetEmail.toLowerCase();

    const user = users.find(u => u.email.toLowerCase() === myEmail);
    if (!user) {
        return res.json({ success: false, message: 'ユーザーが見つかりません' });
    }

    if (!user.likes) {
        user.likes = [];
    }

    const index = user.likes.indexOf(targetEmail);
    let isLiked = false;
    if (index === -1) {
        user.likes.push(targetEmail);
        isLiked = true;
    } else {
        user.likes.splice(index, 1);
        isLiked = false;
    }

    saveData();
    res.json({ success: true, isLiked, likes: user.likes, message: isLiked ? '気になる人に追加しました' : '気になる人から外しました' });
});

app.post('/api/users/update', async (req, res) => {
    let { 
        email, nickname, gender, region, birthdate, age, 
        bloodType, job, income, siblings, hobbies, pr, 
        photo, photos, privacy, emailNotification 
    } = req.body;

    if (email) email = email.toLowerCase();

    const user = users.find(u => u.email.toLowerCase() === email);
    if (!user) {
        return res.status(404).json({ success: false, message: 'ユーザーが見つかりません' });
    }

    if (nickname !== undefined) user.nickname = nickname;
    if (gender !== undefined) user.gender = gender;
    if (region !== undefined) user.region = region;
    if (birthdate !== undefined) user.birthdate = birthdate;
    if (age !== undefined) user.age = age;
    if (bloodType !== undefined) user.bloodType = bloodType;
    if (job !== undefined) user.job = job;
    if (income !== undefined) user.income = income;
    if (siblings !== undefined) user.siblings = siblings;
    if (hobbies !== undefined) user.hobbies = hobbies;
    if (pr !== undefined) user.pr = pr;
    if (photo !== undefined) user.photo = photo;
    if (photos !== undefined) user.photos = Array.isArray(photos) ? photos.slice(0, 2) : [];
    if (privacy !== undefined) user.privacy = privacy;
    if (emailNotification !== undefined) user.emailNotification = emailNotification;

    saveData();

    await updateSheetUser(user.email, {
        'ニックネーム': user.nickname,
        '性別': user.gender,
        '地域': user.region,
        '年齢': user.age
    });

    res.json({ success: true, message: 'プロフィールを更新しました', user: user });
});

// ▼▼▼ パスワード変更 API ▼▼▼
app.post('/api/users/change-password', (req, res) => {
    let { email, currentPassword, newPassword } = req.body;
    if (!email) return res.json({ success: false, message: '情報が不足しています' });
    email = email.toLowerCase();

    const user = users.find(u => u.email.toLowerCase() === email);
    if (!user) {
        return res.json({ success: false, message: 'ユーザーが見つかりません' });
    }

    if (user.password !== currentPassword) {
        return res.json({ success: false, message: '現在のパスワードが間違っています' });
    }

    if (!validatePassword(newPassword)) {
        return res.json({ success: false, message: '新しいパスワードは英数字を含んだ5文字以上で入力してください' });
    }

    user.password = newPassword;
    saveData();
    res.json({ success: true, message: 'パスワードを変更しました' });
});

// ▼▼▼ 退会（アカウント削除）API ▼▼▼
app.post('/api/users/delete-account', (req, res) => {
    let { email, password } = req.body;
    if (!email) return res.json({ success: false, message: '情報が不足しています' });
    email = email.toLowerCase();

    const userIndex = users.findIndex(u => u.email.toLowerCase() === email);
    if (userIndex === -1) {
        return res.json({ success: false, message: 'ユーザーが見つかりません' });
    }

    if (users[userIndex].password !== password) {
        return res.json({ success: false, message: 'パスワードが間違っています' });
    }

    users.splice(userIndex, 1);
    saveData();

    res.json({ success: true, message: '退会処理が完了しました。ご利用ありがとうございました。' });
});

app.put('/api/users/:email', (req, res) => {
    const targetEmail = req.params.email.toLowerCase();
    const { nickname, age, region, temple, photo, photos, password, emailNotification } = req.body;
    
    const user = users.find(u => u.email.toLowerCase() === targetEmail);
    if (!user) return res.json({ success: false, message: 'ユーザーが見つかりません' });

    if (password) {
        if (!validatePassword(password)) {
            return res.json({ success: false, message: 'パスワードは英数字を含んだ5文字以上で入力してください' });
        }
        user.password = password;
    }

    if (nickname !== undefined) user.nickname = nickname;
    if (age !== undefined) user.age = age;
    if (region !== undefined) user.region = region;
    if (temple !== undefined) user.temple = temple;
    if (photo !== undefined) user.photo = photo;
    if (photos !== undefined) user.photos = Array.isArray(photos) ? photos.slice(0, 2) : [];
    if (emailNotification !== undefined) user.emailNotification = emailNotification;

    saveData();
    res.json({ success: true, message: 'プロフィールを更新しました', user: user });
});

app.delete('/api/users/:email', (req, res) => {
    const targetEmail = req.params.email.toLowerCase();
    users = users.filter(u => u.email.toLowerCase() !== targetEmail);
    saveData();
    res.json({ success: true, message: 'ユーザーを削除しました' });
});

// 年齢確認画像提出
app.post('/api/verify', upload.single('idImage'), async (req, res) => {
    let userEmail = req.body.email; 
    if (userEmail) userEmail = userEmail.toLowerCase();
    
    const uploadedFile = req.file;    

    if (!uploadedFile) {
        return res.status(400).json({ success: false, message: '画像がありません' });
    }

    const user = users.find(u => u.email.toLowerCase() === userEmail);
    if (user) {
        user.pendingVerification = true;
        user.isAgeVerified = false; 
        user.idCardImage = '/uploads/' + uploadedFile.filename; 
        saveData();

        await updateSheetUser(userEmail, {
            '年齢確認ステータス': '審査中',
            '身分証画像パス': user.idCardImage
        });

        return res.json({ success: true, message: '身分証の提出を受け付けました。審査をお待ちください。' });
    }

    res.status(404).json({ success: false, message: '該当するユーザーが見つかりません' });
});

// 年齢確認審査完了
app.post('/api/admin/verify-user', async (req, res) => {
    let { email, approved } = req.body;
    if (email) email = email.toLowerCase();

    const user = users.find(u => u.email.toLowerCase() === email);

    if (!user) {
        return res.json({ success: false, message: 'ユーザーが見つかりません' });
    }

    if (approved) {
        user.isAgeVerified = true;
        user.pendingVerification = false;
    } else {
        user.isAgeVerified = false;
        user.pendingVerification = false;
    }

    saveData();

    await updateSheetUser(email, {
        '年齢確認ステータス': approved ? '承認済み' : '未提出（却下）'
    });

    res.json({ 
        success: true, 
        message: approved ? '年齢確認を承認しました' : '年齢確認を却下しました' 
    });
});

// メッセージAPI
app.post('/api/messages', upload.single('image'), (req, res) => {
    let { senderEmail, receiverEmail, text } = req.body;
    const uploadedFile = req.file;

    senderEmail = senderEmail ? senderEmail.toLowerCase() : '';
    receiverEmail = receiverEmail ? receiverEmail.toLowerCase() : '';

    if ((!text || !text.trim()) && !uploadedFile) {
        return res.json({ success: false, message: 'メッセージを入力するか、画像を選択してください' });
    }

    let imageUrl = '';
    if (uploadedFile) {
        imageUrl = '/uploads/' + uploadedFile.filename;
    }

    const newMessage = {
        id: Date.now(),
        senderEmail,
        receiverEmail,
        text: text || '',
        imageUrl: imageUrl,
        read: false,
        time: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    };
    
    messages.push(newMessage);
    saveData();

    const receiver = users.find(u => u.email.toLowerCase() === receiverEmail);
    const sender = users.find(u => u.email.toLowerCase() === senderEmail);

    if (receiver && receiver.emailNotification !== false) {
        const senderName = sender ? (sender.nickname || 'お相手') : 'お相手';
        
        const mailOptions = {
            from: 'sakura.musubi01@gmail.com',
            to: receiver.email,
            subject: '【さくら結び】新着メッセージが届きました',
            text: `${receiver.nickname || '会員'} 様\n\n` +
                  `${senderName} さんから新しいメッセージが届きました。\n\n` +
                  `▼メッセージを確認する\n` +
                  `http://localhost:3000/chat.html?to=${encodeURIComponent(senderEmail)}\n\n` +
                  `※このメールは送信専用です。\n` +
                  `※メール通知の受け取り設定はプロフィール編集画面から変更できます。`
        };

        transporter.sendMail(mailOptions).catch(err => {
            console.error('通知メール送信エラー:', err);
        });
    }

    res.json({ success: true, message: newMessage });
});

app.get('/api/messages-all', (req, res) => {
    res.json(messages);
});

app.get('/api/messages/:user1/:user2', (req, res) => {
    const user1 = req.params.user1.toLowerCase();
    const user2 = req.params.user2.toLowerCase();
    let isUpdated = false;

    messages.forEach(m => {
        const s = (m.senderEmail || '').toLowerCase();
        const r = (m.receiverEmail || '').toLowerCase();
        if (s === user2 && r === user1 && !m.read) {
            m.read = true;
            isUpdated = true;
        }
    });

    if (isUpdated) saveData();

    const history = messages.filter(m => {
        const s = (m.senderEmail || '').toLowerCase();
        const r = (m.receiverEmail || '').toLowerCase();
        return (s === user1 && r === user2) || (s === user2 && r === user1);
    });
    
    res.json(history);
});

// ▼▼▼ Renderなどの環境変数PORTに対応 ▼▼▼
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`サーバー起動: http://localhost:${PORT}`);
});