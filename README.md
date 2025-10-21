# Stepwise Learning System
## 1. システム概要
### 1-1. 概要
Stepwise Learning System は、プログラミング学習者が課題の「要件理解→設計→実装→検証」に至る一連の思考プロセス全体を，段階的詳細化を軸として習得するwebアプリケーションです。

### 1-2. 開発環境
|実行環境|言語|クラウド|外部API|
|-|-|-|-|
|Docker|Node.js|AWS SDK(S3)|OpenAI API|

### 1-3. ディレクトリ構成

## 2. 開発環境セットアップ
1. ファイルの作成
`.env`ファイルを作成

2. コンテナ起動
`docker-compose up --build -d`

3. ログ確認
`docker-compose logs -f`
http://localhost:3000 で起動しました。と表示されればOK。

4. コンテナ操作
- コンテナ停止：`docker-compose down`
- 強制削除：`docker-compose down --volumes --rmi all`

## エンドポイント
| エンドポイント        | メソッド | 説明                |
|----------------------|----------|---------------------|
| `/login`         | POST      | ユーザー認証を行い、セッションを開始  |
| `/logout`     | POST      | セッションを破棄し、ログアウト   |
| `/session`         | GET     | 現在のセッション情報を確認  |
| `/run-code`     | POST      | 外部サービス (emkc.org/api/v2/piston) を利用してコードを実行し、結果をS3にログ保存  |
| `/ai-advice`     | POST   | OpenAI APIを利用して、コードに基づいた段階的なアドバイスを提供し、S3にログ保存  |
|`/upload`|POST|コードや実行結果などのデータをS3にアップロード（ログ保存）|
|`/load_latest_code`|GET|S3に保存されたユーザーの最新のコードをロード|