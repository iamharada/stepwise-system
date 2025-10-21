const express = require('express');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const fs = require('fs');
const bcrypt = require('bcrypt');

// ★ dotenvを読み込み、.envファイルの内容をprocess.envにロード
require('dotenv').config(); 

const app = express();
const port = 3000;

// ★ 機密情報の読み込みとチェック
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME; 
const REGION = process.env.AWS_REGION; 

// 必須環境変数が設定されているか確認
if (!OPENAI_API_KEY || !S3_BUCKET_NAME || !REGION) {
    console.error("🚨 致命的なエラー: 以下の環境変数が設定されていません:");
    if (!OPENAI_API_KEY) console.error(" - OPENAI_API_KEY");
    if (!S3_BUCKET_NAME) console.error(" - S3_BUCKET_NAME");
    if (!REGION) console.error(" - AWS_REGION (または REGION)");
    console.error("アプリケーションを終了します。'.env'ファイルを確認してください。");
    process.exit(1); // サーバー起動を停止
}

// S3クライアントを初期化
const s3 = new AWS.S3({ region: REGION });

// CORS設定
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true
}));

// JSON形式のリクエストボディを解析
app.use(express.json());

// セッションミドルウェアの設定
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

// 静的ファイル（index.html, tasks/xxx.mdなど）の提供
app.use(express.static(path.join(__dirname, 'public')));

// ユーザー認証ロジック
let usersData = [];
const usersFilePath = path.join(__dirname, 'users.json');

// パスワードをハッシュ化してユーザー情報を作成・保存する関数
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

// サーバー起動時にユーザー情報を準備
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

//----------------------------------------------------
// 認証エンドポイント
//----------------------------------------------------

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
        if (err) {
            return res.status(500).json({ message: 'ログアウトに失敗しました' });
        }
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
    if (!req.session.user) {
        return res.status(401).json({ message: '認証されていません' });
    }
    const { taskNumber } = req.body;
    if (taskNumber) {
        req.session.user.taskNumber = taskNumber;
        return res.json({ message: `課題番号を ${taskNumber} に設定しました` });
    }
    res.status(400).json({ message: '無効な課題番号です' });
});

//----------------------------------------------------
// S3 ロギングとコードロード エンドポイント
//----------------------------------------------------

// S3へのログ保存エンドポイント (自動保存と実行結果)
app.post('/upload', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ message: '認証されていません' });
    }
    const { key, body } = req.body;
    const userId = req.session.user.userId;
    const s3Key = `log/${userId}/${key}`;

    if (!body || !key) {
        return res.status(400).send('keyまたはbodyがありません。');
    }

    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: s3Key,
        Body: body,
        ContentType: 'application/json'
    };

    s3.upload(params, (err, data) => {
        if (err) {
            console.error('S3へのアップロードに失敗しました:', err);
            return res.status(500).send('サーバーエラー: アップロード失敗');
        }
        console.log('S3に保存しました:', data.Location);
        res.status(200).json({ message: '保存に成功しました。', location: data.Location });
    });
});

// 最新のコードをロードするエンドポイント
app.get('/load_latest_code', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ message: '認証されていません' });
    }
    const userId = req.session.user.userId;
    const taskNumber = req.query.taskNumber;
    
    const prefix = `log/${userId}/task_${taskNumber}/`;

    const params = {
        Bucket: S3_BUCKET_NAME,
        Prefix: prefix
    };

    s3.listObjectsV2(params, (err, data) => {
        if (err) {
            console.error('S3オブジェクトのリスト取得に失敗:', err);
            return res.status(404).json({ message: '保存されたコードが見つかりません。' }); 
        }

        if (!data.Contents || data.Contents.length === 0) {
            return res.status(404).json({ message: '保存されたコードが見つかりません。' });
        }
        
        // 最新のファイルを特定するために、最終更新日で降順ソート
        data.Contents.sort((a, b) => b.LastModified - a.LastModified);
        const latestFile = data.Contents[0];
        
        const getParams = {
            Bucket: S3_BUCKET_NAME,
            Key: latestFile.Key
        };

        s3.getObject(getParams, (err, fileData) => {
            if (err) {
                console.error('S3からファイルの読み込みに失敗:', err);
                return res.status(500).json({ message: 'サーバーエラー: 最新ファイルの読み込みに失敗しました。' });
            }

            try {
                // ファイル内容をJSONとして解析し、コードを返す
                const content = JSON.parse(fileData.Body.toString('utf-8'));
                res.json({ code: content.code });
            } catch (parseErr) {
                console.error('JSONパースに失敗:', parseErr);
                res.status(500).json({ message: 'サーバーエラー: ファイル内容の解析に失敗しました。' });
            }
        });
    });
});

//----------------------------------------------------
// コード実行エンドポイント
//----------------------------------------------------

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

//----------------------------------------------------
// AI HELP エンドポイント
//----------------------------------------------------

app.post('/ai-advice', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ message: '認証されていません' });
    }

    const { task, studentCode, taskNumber, hintsUsed } = req.body;
    
    // process.envからOpenAIキーを読み込み済み
    if (!OPENAI_API_KEY) {
        // このエラーは起動時にチェックされているはずだが、念のため
        console.error('OPENAI_API_KEYが設定されていません。');
        return res.status(500).json({ error: 'AIサービスの認証情報が不足しています。' });
    }
    
    const MODEL = 'gpt-5-mini'; 
    if (taskNumber) {
        req.session.user.taskNumber = taskNumber;
    }

    const buildPrompt = (task, studentCode) => `
あなたはプログラミング初学者を支援する専門のAIチューターです。
できるだけわかりやすく簡潔に、初心者が理解しやすい言葉でアドバイスを提供してください。
直接的なコードの解答は避け、学習者が自分で考えられるように導いてください。
学習者は、課題の理解から処理の大枠決定、詳細化、コード化、コードの整合性確認までの段階的詳細化プロセスを経てプログラムを完成させようとしています。
学習者の現在の理解度に基づき、以下の2点をJSON形式で提供してください。
1. estimated_stageは「課題の理解」「処理の大枠決定」「処理の詳細化」「コード化」「コードの整合性確認」のいずれかで、学習者が現在どの段階にいるかを推定してください。「課題の理解」はinput,outputを書いている段階、「処理の大枠決定」は大まかな処理の流れをコメントアウトで考えている段階、「処理の詳細化」は具体的な処理内容を考えている（コメントアウトをさらにサブコメントに分解している）段階、「コード化」はコメントアウトを実際にコーディングする段階、「コードの整合性確認」はコード全体を見直している段階です。
2. processing_structureは学習者のコードから推測される処理の構造を、入れ子構造で表現してください。各要素にはlevel（入れ子の深さ、1以上の整数）、text（その部分の処理内容を簡潔に説明した文字列）、status（done: 完了, in_progress: 進行中, todo: 未着手）を含めてください。

次のJSONスキーマで**必ず**回答してください（日本語）:
{
  "estimated_stage": "課題の理解|処理の大枠決定|処理の詳細化|コード化|コードの整合性確認",
  "processing_structure": [
    { "level": 1, "text": "…" },
    { "level": 1, "text": "…" },
    { "level": 1, "text": "…" }
  ],
  "advice": [
    { "level": 1, "text": "…" },
    { "level": 2, "text": "…" },
    { "level": 3, "text": "…" }
  ]
}

制約:
- "level" は1以上の整数。入れ子の深さを表す。並列は同じlevel。
- "processing_structure" は学習者コードの**コメント/構造**から抽出。想像で増やさない。
- "advice" はレベル1→3で順に具体化。いきなり完成コードは提示しない。

【課題】
${task}

【学生コード（C）】
\`\`\`c
${studentCode}
\`\`\`
    `.trim();
    
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [{ role: "user", content: buildPrompt(task, studentCode) }],
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
        const logData = {
            timestamp: new Date().toISOString(),
            username: req.session.user.username,
            userId: req.session.user.userId,
            taskNumber: req.session.user.taskNumber,
            event: 'ai-help',
            code: studentCode,
            estimated_stage: adviceResponse.estimated_stage,
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