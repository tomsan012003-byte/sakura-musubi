require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const fs = require('fs');
const multer = require('multer');

// ▼▼▼ Supabase ライブラリの読み込みと初期化 ▼▼▼
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ▼▼▼ Google Sheets API 用ライブラリの読み込み ▼▼▼
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// uploadsフォルダを絶対パスで公開（ローカル後方互換用）
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

// 管理者初期設定
const adminEmail = 'admin@mail.com';
let adminPassword = 'admin123';

// --- ファイルアップロード（multer + Supabase Storage用メモリ保持）の設定 ---
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB制限
});

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

// ▼ 認証コード送信
app.post('/api/send-code', async (req, res) => {
    let { email, password, name, nickname, age, gender, region, temple, photo } = req.body;
    
    if (!email || !email.includes('@')) {
        return res.json({ success: false, message: '有効なメールアドレス（@を含む）を入力してください' });
    }
    
    email = email.toLowerCase();

    // Supabaseから既存ユーザーチェック
    const { data: existingUser } = await supabase.from('users').select('email').eq('email', email).single();

    if (existingUser || email === adminEmail.toLowerCase()) {
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
            photos: [], 
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

// ▼ 新規会員登録完了（Supabaseへ挿入）
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

        // Supabase の users テーブルに保存
        const { error } = await supabase.from('users').insert([{
            email: newUser.email,
            password: newUser.password,
            name: newUser.name,
            nickname: newUser.nickname,
            age: newUser.age,
            gender: newUser.gender,
            region: newUser.region,
            temple: newUser.temple,
            photo: newUser.photo,
            income: newUser.income,
            hobbies: newUser.hobbies,
            pr: newUser.pr,
            job: newUser.job,
            siblings: newUser.siblings,
            blood_type: newUser.bloodType,
            birthdate: newUser.birthdate,
            photos: newUser.photos,
            likes: newUser.likes,
            privacy: newUser.privacy,
            email_notification: newUser.emailNotification,
            is_age_verified: newUser.isAgeVerified,
            pending_verification: newUser.pendingVerification,
            id_card_image: newUser.idCardImage,
            created_at: newUser.createdAt
        }]);

        if (error) {
            console.error('Supabase登録エラー:', error);
            return res.json({ success: false, message: 'データベースへの保存に失敗しました' });
        }

        delete pendingRegistrations[email];
        await syncUserToSheet(newUser);

        res.json({ success: true, message: '認証成功！会員登録が完了しました。' });
    } else {
        res.json({ success: false, message: '認証コードが違います。' });
    }
});

// ▼ ログイン API
app.post('/api/login', async (req, res) => {
    let { email, password } = req.body;
    if (email) email = email.toLowerCase();

    if (email === adminEmail.toLowerCase() && password === adminPassword) {
        return res.json({ success: true, user: { email: adminEmail, nickname: '管理者', role: 'admin' } });
    }

    const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', email)
        .eq('password', password)
        .single();

    if (error || !user) {
        return res.json({ success: false, message: 'メールかパスワードが違います' });
    }

    // フロントエンド用表記に整形
    user.bloodType = user.blood_type || '';
    user.emailNotification = user.email_notification ?? true;
    user.isAgeVerified = user.is_age_verified || false;
    user.pendingVerification = user.pending_verification || false;
    user.idCardImage = user.id_card_image || '';

    res.json({ success: true, user: user });
});

// ▼ 管理者パスワード変更 API
app.post('/api/admin/password', (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (currentPassword !== adminPassword) {
        return res.json({ success: false, message: '現在のパスワードが間違っています' });
    }
    if (!validatePassword(newPassword)) {
        return res.json({ success: false, message: '新しいパスワードは英数字を含んだ5文字以上で入力してください' });
    }
    adminPassword = newPassword;
    res.json({ success: true, message: '管理者パスワードを変更しました' });
});

// ▼ 全ユーザー一覧取得 API
app.get('/api/users', async (req, res) => {
    const { data: users, error } = await supabase.from('users').select('*');
    if (error) {
        return res.status(500).json({ success: false, message: 'ユーザー一覧取得エラー' });
    }
    
    // データ形式の整形
    const formatted = (users || []).map(u => ({
        ...u,
        bloodType: u.blood_type || '',
        emailNotification: u.email_notification ?? true,
        isAgeVerified: u.is_age_verified || false,
        pendingVerification: u.pending_verification || false,
        idCardImage: u.id_card_image || '',
        likes: u.likes || [],
        photos: u.photos || []
    }));

    res.json(formatted);
});

// ▼ 「気になる人」追加・解除 API
app.post('/api/like', async (req, res) => {
    let { myEmail, targetEmail } = req.body;
    if (!myEmail || !targetEmail) {
        return res.json({ success: false, message: '情報が不足しています' });
    }

    myEmail = myEmail.toLowerCase();
    targetEmail = targetEmail.toLowerCase();

    const { data: user } = await supabase.from('users').select('*').eq('email', myEmail).single();
    if (!user) {
        return res.json({ success: false, message: 'ユーザーが見つかりません' });
    }

    let likes = user.likes || [];
    const index = likes.indexOf(targetEmail);
    let isLiked = false;

    if (index === -1) {
        likes.push(targetEmail);
        isLiked = true;
    } else {
        likes.splice(index, 1);
        isLiked = false;
    }

    await supabase.from('users').update({ likes: likes }).eq('email', myEmail);

    res.json({ success: true, isLiked, likes: likes, message: isLiked ? '気になる人に追加しました' : '気になる人から外しました' });
});

// ▼ プロフィール更新 API
app.post('/api/users/update', async (req, res) => {
    let { 
        email, nickname, gender, region, birthdate, age, 
        bloodType, job, income, siblings, hobbies, pr, 
        photo, photos, privacy, emailNotification 
    } = req.body;

    if (email) email = email.toLowerCase();

    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) {
        return res.status(404).json({ success: false, message: 'ユーザーが見つかりません' });
    }

    const updates = {};
    if (nickname !== undefined) updates.nickname = nickname;
    if (gender !== undefined) updates.gender = gender;
    if (region !== undefined) updates.region = region;
    if (birthdate !== undefined) updates.birthdate = birthdate;
    if (age !== undefined) updates.age = age;
    if (bloodType !== undefined) updates.blood_type = bloodType;
    if (job !== undefined) updates.job = job;
    if (income !== undefined) updates.income = income;
    if (siblings !== undefined) updates.siblings = siblings;
    if (hobbies !== undefined) updates.hobbies = hobbies;
    if (pr !== undefined) updates.pr = pr;
    if (photo !== undefined) updates.photo = photo;
    if (photos !== undefined) updates.photos = Array.isArray(photos) ? photos.slice(0, 2) : [];
    if (privacy !== undefined) updates.privacy = privacy;
    if (emailNotification !== undefined) updates.email_notification = emailNotification;

    await supabase.from('users').update(updates).eq('email', email);

    await updateSheetUser(email, {
        'ニックネーム': updates.nickname || user.nickname,
        '性別': updates.gender || user.gender,
        '地域': updates.region || user.region,
        '年齢': updates.age || user.age
    });

    res.json({ success: true, message: 'プロフィールを更新しました', user: { ...user, ...updates } });
});

// ▼ パスワード変更 API
app.post('/api/users/change-password', async (req, res) => {
    let { email, currentPassword, newPassword } = req.body;
    if (!email) return res.json({ success: false, message: '情報が不足しています' });
    email = email.toLowerCase();

    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) {
        return res.json({ success: false, message: 'ユーザーが見つかりません' });
    }

    if (user.password !== currentPassword) {
        return res.json({ success: false, message: '現在のパスワードが間違っています' });
    }

    if (!validatePassword(newPassword)) {
        return res.json({ success: false, message: '新しいパスワードは英数字を含んだ5文字以上で入力してください' });
    }

    await supabase.from('users').update({ password: newPassword }).eq('email', email);
    res.json({ success: true, message: 'パスワードを変更しました' });
});

// ▼ 退会（アカウント削除）API
app.post('/api/users/delete-account', async (req, res) => {
    let { email, password } = req.body;
    if (!email) return res.json({ success: false, message: '情報が不足しています' });
    email = email.toLowerCase();

    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) {
        return res.json({ success: false, message: 'ユーザーが見つかりません' });
    }

    if (user.password !== password) {
        return res.json({ success: false, message: 'パスワードが間違っています' });
    }

    await supabase.from('users').delete().eq('email', email);
    res.json({ success: true, message: '退会処理が完了しました。ご利用ありがとうございました。' });
});

// ▼ ユーザー更新（PUT）
app.put('/api/users/:email', async (req, res) => {
    const targetEmail = req.params.email.toLowerCase();
    const { nickname, age, region, temple, photo, photos, password, emailNotification } = req.body;
    
    const { data: user } = await supabase.from('users').select('*').eq('email', targetEmail).single();
    if (!user) return res.json({ success: false, message: 'ユーザーが見つかりません' });

    const updates = {};
    if (password) {
        if (!validatePassword(password)) {
            return res.json({ success: false, message: 'パスワードは英数字を含んだ5文字以上で入力してください' });
        }
        updates.password = password;
    }

    if (nickname !== undefined) updates.nickname = nickname;
    if (age !== undefined) updates.age = age;
    if (region !== undefined) updates.region = region;
    if (temple !== undefined) updates.temple = temple;
    if (photo !== undefined) updates.photo = photo;
    if (photos !== undefined) updates.photos = Array.isArray(photos) ? photos.slice(0, 2) : [];
    if (emailNotification !== undefined) updates.email_notification = emailNotification;

    await supabase.from('users').update(updates).eq('email', targetEmail);
    res.json({ success: true, message: 'プロフィールを更新しました', user: { ...user, ...updates } });
});

// ▼ ユーザー削除（DELETE）
app.delete('/api/users/:email', async (req, res) => {
    const targetEmail = req.params.email.toLowerCase();
    await supabase.from('users').delete().eq('email', targetEmail);
    res.json({ success: true, message: 'ユーザーを削除しました' });
});

// ▼ 年齢確認画像提出（Supabase Storageにアップロード）
app.post('/api/verify', upload.single('idImage'), async (req, res) => {
    let userEmail = req.body.email; 
    if (userEmail) userEmail = userEmail.toLowerCase();
    
    const uploadedFile = req.file;    

    if (!uploadedFile) {
        return res.status(400).json({ success: false, message: '画像がありません' });
    }

    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) {
        return res.status(404).json({ success: false, message: '該当するユーザーが見つかりません' });
    }

    try {
        const fileExt = path.extname(uploadedFile.originalname) || '.jpg';
        const fileName = `${Date.now()}_${Math.round(Math.random() * 1000)}${fileExt}`;
        const filePath = `id_cards/${fileName}`;

        // 1. Supabase Storage (uploads バケット) へ保存
        const { error: uploadError } = await supabase.storage
            .from('uploads')
            .upload(filePath, uploadedFile.buffer, {
                contentType: uploadedFile.mimetype,
                upsert: true
            });

        if (uploadError) {
            console.error('Storage Upload Error:', uploadError);
            return res.status(500).json({ success: false, message: '画像のアップロードに失敗しました' });
        }

        // 2. 公開URLを取得
        const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(filePath);
        const idCardImage = urlData.publicUrl;

        // 3. DBおよびスプレッドシートを更新
        await supabase.from('users').update({
            pending_verification: true,
            is_age_verified: false,
            id_card_image: idCardImage
        }).eq('email', userEmail);

        await updateSheetUser(userEmail, {
            '年齢確認ステータス': '審査中',
            '身分証画像パス': idCardImage
        });

        return res.json({ success: true, message: '身分証の提出を受け付けました。審査をお待ちください。' });
    } catch (err) {
        console.error('年齢確認提出エラー:', err);
        return res.status(500).json({ success: false, message: 'サーバーエラーが発生しました' });
    }
});

// ▼ 年齢確認審査完了
app.post('/api/admin/verify-user', async (req, res) => {
    let { email, approved } = req.body;
    if (email) email = email.toLowerCase();

    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) {
        return res.json({ success: false, message: 'ユーザーが見つかりません' });
    }

    await supabase.from('users').update({
        is_age_verified: approved,
        pending_verification: false
    }).eq('email', email);

    await updateSheetUser(email, {
        '年齢確認ステータス': approved ? '承認済み' : '未提出（却下）'
    });

    res.json({ 
        success: true, 
        message: approved ? '年齢確認を承認しました' : '年齢確認を却下しました' 
    });
});

// ▼ メッセージ（チャット）送信 API（Supabase Storageに保存）
app.post('/api/messages', upload.single('image'), async (req, res) => {
    let { senderEmail, receiverEmail, text } = req.body;
    const uploadedFile = req.file;

    senderEmail = senderEmail ? senderEmail.toLowerCase() : '';
    receiverEmail = receiverEmail ? receiverEmail.toLowerCase() : '';

    if ((!text || !text.trim()) && !uploadedFile) {
        return res.json({ success: false, message: 'メッセージを入力するか、画像を選択してください' });
    }

    let imageUrl = '';
    if (uploadedFile) {
        try {
            const fileExt = path.extname(uploadedFile.originalname) || '.jpg';
            const fileName = `${Date.now()}_${Math.round(Math.random() * 1000)}${fileExt}`;
            const filePath = `chat_images/${fileName}`;

            const { error: uploadError } = await supabase.storage
                .from('uploads')
                .upload(filePath, uploadedFile.buffer, {
                    contentType: uploadedFile.mimetype,
                    upsert: true
                });

            if (uploadError) {
                console.error('Storage Upload Error (Chat):', uploadError);
                return res.json({ success: false, message: 'チャット画像のアップロードに失敗しました' });
            }

            const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(filePath);
            imageUrl = urlData.publicUrl;
        } catch (err) {
            console.error('チャット画像処理エラー:', err);
            return res.json({ success: false, message: '画像処理に失敗しました' });
        }
    }

    const newMessage = {
        sender_email: senderEmail,
        receiver_email: receiverEmail,
        text: text || '',
        image_url: imageUrl,
        read: false,
        time: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    };

    // Supabaseの messages テーブルに保存
    const { data: insertedMsg, error } = await supabase.from('messages').insert([newMessage]).select().single();

    const { data: receiver } = await supabase.from('users').select('*').eq('email', receiverEmail).single();
    const { data: sender } = await supabase.from('users').select('*').eq('email', senderEmail).single();

    if (receiver && receiver.email_notification !== false) {
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

    res.json({ success: true, message: insertedMsg || newMessage });
});

// ▼ 全メッセージ取得
app.get('/api/messages-all', async (req, res) => {
    const { data: msgs } = await supabase.from('messages').select('*');
    res.json(msgs || []);
});

// ▼ チャット履歴取得
app.get('/api/messages/:user1/:user2', async (req, res) => {
    const user1 = req.params.user1.toLowerCase();
    const user2 = req.params.user2.toLowerCase();

    // 未読メッセージを既読に更新
    await supabase.from('messages')
        .update({ read: true })
        .eq('sender_email', user2)
        .eq('receiver_email', user1)
        .eq('read', false);

    const { data: msgs } = await supabase.from('messages').select('*');
    
    const history = (msgs || []).filter(m => {
        const s = (m.sender_email || m.senderEmail || '').toLowerCase();
        const r = (m.receiver_email || m.receiverEmail || '').toLowerCase();
        return (s === user1 && r === user2) || (s === user2 && r === user1);
    }).map(m => ({
        ...m,
        senderEmail: m.sender_email || m.senderEmail,
        receiverEmail: m.receiver_email || m.receiverEmail,
        imageUrl: m.image_url || m.imageUrl
    }));

    res.json(history);
});

// ▼ ポート起動設定
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`サーバー起動: http://localhost:${PORT}`);
});