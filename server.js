const express = require('express');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const fs = require('fs');
const bcrypt = require('bcrypt');
const fsPromises = require('fs/promises'); // fs/promises をインポート

// ★ dotenvを読み込み、.envファイルの内容をprocess.envにロード
require('dotenv').config(); 

const app = express();
const port = 3000;

// S3とAWSの環境設定をprocess.envから取得
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME; 
const REGION = process.env.AWS_REGION; 

// 必須環境変数が設定されているか確認し、未設定の場合は起動を停止
if (!OPENAI_API_KEY || !S3_BUCKET_NAME || !REGION) {
    console.error("🚨 致命的なエラー: 以下の環境変数が設定されていません。アプリケーションを終了します。");
    if (!OPENAI_API_KEY) console.error(" - OPENAI_API_KEY");
    if (!S3_BUCKET_NAME) console.error(" - S3_BUCKET_NAME");
    if (!REGION) console.error(" - AWS_REGION");
    console.error("Docker環境または'.env'ファイルを確認してください。");
    process.exit(1);
}

// S3クライアントを初期化
const s3 = new AWS.S3({ region: REGION });

// CORS設定とミドルウェア
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true
}));
app.use(express.json());
app.use(session({
    secret: 'your-secret-key-that-is-long-and-random', 
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, 
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 
    }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ユーザー認証ロジック (変更なし)
let usersData = [];
const usersFilePath = path.join(__dirname, 'users.json');

async function hashPasswordsAndSave() {
    const rawUsers = [
        { username: 'user1', password: 'password1', userId: 'user_001' },
        { username: 'user2', password: 'password2', userId: 'user_002' }
    ];
    const hashedUsers = await Promise.all(rawUsers.map(async u => ({
        ...u,
        password: await bcrypt.hash(u.password, 10)
    })));
    try {
        fs.writeFileSync(usersFilePath, JSON.stringify(hashedUsers, null, 2));
    } catch (err) {
        console.error('users.jsonの書き込みに失敗しました:', err);
    }
    return hashedUsers;
}

try {
    const usersFileContent = fs.readFileSync(usersFilePath, 'utf8');
    usersData = JSON.parse(usersFileContent);
} catch (err) {
    if (err.code === 'ENOENT') {
        console.log('users.jsonが見つかりません。初期ユーザーを作成します。');
        hashPasswordsAndSave().then(data => { usersData = data; });
    } else {
        console.error('users.jsonの読み込みに失敗しました:', err);
    }
}

// 認証エンドポイント
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = usersData.find(u => u.username === username);
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = { userId: user.userId, username: user.username, taskNumber: 1 };
        return res.json({ message: 'ログイン成功', user: req.session.user });
    } else {
        return res.status(401).json({ message: 'ユーザー名またはパスワードが間違っています' });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) { return res.status(500).json({ message: 'ログアウトに失敗しました' }); }
        res.clearCookie('connect.sid');
        res.json({ message: 'ログアウト成功' });
    });
});

app.get('/session', (req, res) => {
    if (req.session.user) {
        return res.json({ user: req.session.user });
    } else {
        return res.status(401).json({ message: '未ログイン' });
    }
});

app.post('/set-task', (req, res) => {
    if (!req.session.user) { return res.status(401).json({ message: '認証されていません' }); }
    const { taskNumber } = req.body;
    if (taskNumber) {
        req.session.user.taskNumber = taskNumber;
        return res.json({ message: `課題番号を ${taskNumber} に設定しました` });
    }
    res.status(400).json({ message: '無効な課題番号です' });
});

// S3 ロギングとコードロード エンドポイント
app.post('/upload', (req, res) => {
    if (!req.session.user) { return res.status(401).json({ message: '認証されていません' }); }
    const { key, body } = req.body;
    const userId = req.session.user.userId;
    const s3Key = `log/${userId}/${key}`;
    const params = { Bucket: S3_BUCKET_NAME, Key: s3Key, Body: body, ContentType: 'application/json' };
    s3.upload(params, (err, data) => {
        if (err) { console.error('S3へのアップロードに失敗しました:', err); return res.status(500).send('サーバーエラー: アップロード失敗'); }
        console.log('S3に保存しました:', data.Location);
        res.status(200).json({ message: '保存に成功しました。', location: data.Location });
    });
});

app.get('/load_latest_code', (req, res) => {
    if (!req.session.user) { return res.status(401).json({ message: '認証されていません' }); }
    const userId = req.session.user.userId;
    const taskNumber = req.query.taskNumber;
    const prefix = `log/${userId}/task_${taskNumber}/`;
    const params = { Bucket: S3_BUCKET_NAME, Prefix: prefix };
    s3.listObjectsV2(params, (err, data) => {
        if (err || !data.Contents || data.Contents.length === 0) { return res.status(404).json({ message: '保存されたコードが見つかりません。' }); }
        data.Contents.sort((a, b) => b.LastModified - a.LastModified);
        const latestFile = data.Contents[0];
        const getParams = { Bucket: S3_BUCKET_NAME, Key: latestFile.Key };
        s3.getObject(getParams, (err, fileData) => {
            if (err) { console.error('S3からファイルの読み込みに失敗:', err); return res.status(500).json({ message: 'サーバーエラー: 最新ファイルの読み込みに失敗しました。' }); }
            try {
                const content = JSON.parse(fileData.Body.toString('utf-8'));
                res.json({ code: content.code });
            } catch (parseErr) {
                console.error('JSONパースに失敗:', parseErr);
                res.status(500).json({ message: 'サーバーエラー: ファイル内容の解析に失敗しました。' });
            }
        });
    });
});

// コード実行エンドポイント
app.post('/run-code', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ message: '認証されていません' });
    }

    const { code, language, stdin, taskNumber } = req.body;
    const userId = req.session.user.userId;
    const PISTON_API_URL = "https://emkc.org/api/v2/piston/execute";
    if (taskNumber) {
        req.session.user.taskNumber = taskNumber;
    }

    try {
        const response = await fetch(PISTON_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                language: language,
                version: "10.2.0",
                files: [{ content: code }],
                stdin: stdin
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API Error: ${response.status} - ${JSON.stringify(errorData)}`);
        }

        const data = await response.json();
        res.json(data);
        
        // 実行ログをS3に保存
        const logData = {
            timestamp: new Date().toISOString(),
            username: req.session.user.username,
            userId: userId,
            taskNumber: req.session.user.taskNumber,
            event: 'run',
            code: code,
            stdout: data.run?.stdout,
            stderr: data.run?.stderr,
        };
        const logKey = `task_${req.session.user.taskNumber}/${logData.timestamp}_${logData.event}.json`;
        s3.upload({
            Bucket: S3_BUCKET_NAME,
            Key: `log/${userId}/${logKey}`,
            Body: JSON.stringify(logData, null, 2),
            ContentType: 'application/json'
        }, (err) => {
            if (err) console.error('実行ログのS3保存に失敗:', err);
        });
    } catch (error) {
        console.error('コード実行に失敗しました:', error);
        res.status(500).json({
            error: 'コードの実行に失敗しました。',
            details: error.message
        });
    }
});

// AI HELP エンドポイント (プロンプトファイルを呼び出し時に読み込む)
app.post('/ai-advice', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ message: '認証されていません' });
    }

    const { task, studentCode, taskNumber, hintsUsed } = req.body;
    
    // リクエストが来るたびにファイルを非同期で読み込む
    let PROMPT_TEMPLATE;
    try {
        const PROMPT_TEMPLATE_PATH = path.join(__dirname, 'prompt_template.txt');
        // Docker環境では非同期I/Oが原因でエラーが出ることが少ないため、fsPromisesを使用
        PROMPT_TEMPLATE = (await fsPromises.readFile(PROMPT_TEMPLATE_PATH, 'utf8')).trim();
    } catch (error) {
        console.error(`🚨 プロンプトファイルのロードエラー: ${error.message}`);
        return res.status(500).json({ error: 'AIサービスのプロンプト設定ファイル（prompt_template.txt）を読み込めません。' });
    }
    
    // テンプレートの動的な値を置換して最終プロンプトを構築
    const finalPrompt = PROMPT_TEMPLATE
        .replace('${task}', task)
        .replace('${studentCode}', studentCode);

    const MODEL = 'gpt-5-mini'; 
    if (taskNumber) { req.session.user.taskNumber = taskNumber; }

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [{ role: "user", content: finalPrompt }], 
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API Error: ${response.status} - ${JSON.stringify(errorData)}`);
        }

        const data = await response.json();
        const messageContent = data.choices[0].message.content; 
        
        let adviceResponse;
        try {
            adviceResponse = JSON.parse(messageContent); 
        } catch (e) {
            console.error('AI応答のJSONパースに失敗:', e);
            throw new Error('AIから不正なJSON応答を受信しました');
        }

        // AI HELPログをS3に保存
        // AI HELPログをS3に保存
        const logData = {
            timestamp: new Date().toISOString(),
            username: req.session.user.username,
            userId: req.session.user.userId,
            taskNumber: req.session.user.taskNumber,
            event: 'ai-help',
            code: studentCode,
            estimated_stage: adviceResponse.estimated_stage,
            next_stage: adviceResponse.next_stage, 
            processing_structure: adviceResponse.processing_structure,
            advice: adviceResponse.advice,
            hintsUsed: hintsUsed,
        };
        const logKey = `task_${req.session.user.taskNumber}/${logData.timestamp}_${logData.event}.json`;
        s3.upload({
            Bucket: S3_BUCKET_NAME,
            Key: `log/${req.session.user.userId}/${logKey}`,
            Body: JSON.stringify(logData, null, 2),
            ContentType: 'application/json'
        }, (err) => {
            if (err) console.error('AI HELPログのS3保存に失敗:', err);
        });

        res.json(adviceResponse);
    } catch (error) {
        res.status(500).json({ error: 'AIアドバイスの取得に失敗しました', details: error.message });
    }
});

app.listen(port, () => {
    console.log(`サーバーが http://localhost:${port} で起動しました。`);
});