const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('データベースの接続に失敗しました:', err.message);
    } else {
        console.log('データベースに接続しました。');
    }
});

// テーブルの初期化処理
db.serialize(() => {
    // usersテーブル (永続データ: 連携マスタ ＋ 最終活動日)
    // last_reply_date: 最後に投稿した日付 (yyyy-mm-dd")
    db.run(`CREATE TABLE IF NOT EXISTS users (
        discord_id TEXT PRIMARY KEY,
        twitter_access_token TEXT,
        twitter_refresh_token TEXT,
        last_reply_date TEXT
    )`);

    // daily_reportsテーブル (今日1日の状態・毎朝使い捨てデータ)
    // discord_id: DiscordのユーザーID (今日投稿した人だけがここに入る)
    // morning_tweet_id: 朝に投稿したツイートのID (夜に引用リツイートするために必須)
    // is_evening_sent: 夜22時に振り返り質問のDMを送信したか (0:未送信, 1:送信済)
    db.run(`CREATE TABLE IF NOT EXISTS daily_reports (
        discord_id TEXT PRIMARY KEY,
        morning_tweet_id TEXT,
        is_evening_sent INTEGER DEFAULT 0
    )`);
});

module.exports = db;