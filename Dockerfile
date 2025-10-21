# ベースイメージの指定
FROM node:20

# ワークディレクトリを設定
WORKDIR /usr/src/app

# package.json と package-lock.json をコンテナにコピー
# これが npm install のために必須です。
COPY package*.json ./

# ★ 修正点: 依存関係のインストールをコンテナ内で実行 ★
RUN npm install

# アプリケーションのコードをコピー
COPY . .

# アプリケーションの起動コマンド
CMD [ "npm", "start" ]