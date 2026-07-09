require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Events } = require('discord.js');
const express = require('express');
const session = require('express-session');
const { TwitterApi } = require('twitter-api-v2');
const cron = require('node-cron');
const db = require('./db');

//サーバーとTwitterAPIの準備
const app = express();

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}));

const twitterClient = new TwitterApi({
    clientId: process.env.TWITTER_CLIENT_ID,
    clientSecret: process.env.TWITTER_CLIENT_SECRET,
});

const CALLBACK_URL = `${process.env.BASE_URL}/callback`;

app.get('/auth', (req, res) => {
    const discordId = req.query.discord_id;
    if (!discordId) return res.send('Discord IDが指定されていません。');

    const { url, codeVerifier, state } = twitterClient.generateOAuth2AuthLink(CALLBACK_URL, {
        scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access']
    });

    req.session.codeVerifier = codeVerifier;
    req.session.state = state;
    req.session.discordId = discordId;

    res.redirect(url);
});

app.get('/callback', async (req, res) => {
    const { state, code } = req.query;
    const { codeVerifier, state: sessionState, discordId } = req.session;

    if (!codeVerifier || !state || !sessionState || !code) return res.status(400).send('認証に失敗しました。');
    if (state !== sessionState) return res.status(400).send('セキュリティエラー');

    try {
        const { accessToken, refreshToken } = await twitterClient.loginWithOAuth2({
            code, codeVerifier, redirectUri: CALLBACK_URL
        });

        db.get('SELECT last_reply_date FROM users WHERE discord_id = ?', [discordId], (err, row) => {
            const lastReply = row ? row.last_reply_date : null;
            db.run(
                `INSERT OR REPLACE INTO users (discord_id, twitter_access_token, twitter_refresh_token, last_reply_date) VALUES (?, ?, ?, ?)`,
                [discordId, accessToken, refreshToken, lastReply],
                (err) => {
                    if (err) return res.status(500).send('データベース保存エラー');
                    res.send('<h1>連携完了！</h1><p>X(Twitter)との連携が成功しました。Discordに戻ってください。</p>');
                }
            );
        });
    } catch (error) {
        res.status(403).send('認証エラーが発生しました。');
    }
});

app.listen(process.env.PORT, () => {
    console.log(`サーバー起動: http://127.0.0.1:${process.env.PORT}`);
});

//DiscordBotの準備と自動化処理
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel]
});

client.once('ready', async () => {
    console.log(`Discordログイン完了: ${client.user.tag}`);

    const guildId = process.env.GUILD_ID;
    const roleId = process.env.TARGET_ROLE_ID;

    //朝の処理
    cron.schedule('45 08 * * *', async () => {
        console.log('データのクリーンアップとアナウンスを開始します。');

        db.run('DELETE FROM daily_reports', async (err) => {
            if (err) return console.error('日報リセットエラー:', err);

            try {
                const guild = await client.guilds.fetch(guildId);
                const role = await guild.roles.fetch(roleId);
                
                role.members.forEach(member => {
                    if (member.user.bot) return;

                    db.get(`SELECT last_reply_date FROM users WHERE discord_id = ?`, [member.id], async (err, row) => {
                        let greeting = 'おはようございます！今日の目標を教えてください。';

                        if (row && row.last_reply_date) {
                            const lastDate = new Date(row.last_reply_date);
                            const today = new Date();
                            const diffDays = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));
                            if (diffDays >= 2) greeting = `おはようございます！${diffDays}日ぶりの回答お待ちしてます！今日の目標を教えてください✨`;
                        }

                        const button = new ButtonBuilder()
                            .setCustomId('open_goal_modal')
                            .setLabel('今日の目標を入力する')
                            .setStyle(ButtonStyle.Primary);
                        const actionRow = new ActionRowBuilder().addComponents(button);

                        try {
                            await member.send({ content: greeting, components: [actionRow] });
                        } catch (error) {
                            console.error(`${member.user.tag} に朝のDMを送れませんでした。`);
                        }
                    });
                });
            } catch (error) {
                console.error(error);
            }
        });
    });

    //夜
    cron.schedule('00 22 * * *', async () => {
        console.log('振り返りのアナウンスを開始します。');

        db.all(`SELECT discord_id FROM daily_reports WHERE is_evening_sent = 0`, [], async (err, rows) => {
            if (err) return console.error('夜の対象者検索エラー:', err);

            for (const row of rows) {
                try {
                    const user = await client.users.fetch(row.discord_id);
                    const button = new ButtonBuilder()
                        .setCustomId('open_reflection_modal')
                        .setLabel('今日の振り返りを入力する')
                        .setStyle(ButtonStyle.Success);
                    const actionRow = new ActionRowBuilder().addComponents(button);

                    await user.send({ content: '1日お疲れ様でした！今日の目標の振り返りを教えてください。', components: [actionRow] });
                } catch (error) {
                    console.error(`${row.discord_id} にDMを送れませんでした。`);
                }
            }
        });
    });
});

//ロール付与時の挙動
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    const targetRoleId = process.env.TARGET_ROLE_ID;
    if (!targetRoleId) return;

    const hadRole = oldMember.roles.cache.has(targetRoleId);
    const hasRole = newMember.roles.cache.has(targetRoleId);

    //新しく付与された場合
    if (!hadRole && hasRole) {
        db.get(`SELECT * FROM users WHERE discord_id = ?`, [newMember.id], async (err, row) => {
            if (err) return console.error('DB確認エラー:', err);
            if (!row || !row.twitter_access_token) {
                try {
                    const authUrl = `http://127.0.0.1:${process.env.PORT}/auth?discord_id=${newMember.id}`;
                    await newMember.send(
                        `🎉 ソフ研の進捗報告ロールが付与されました！\n` +
                        `日々の目標や振り返りをXに自動投稿するために、以下のURLをブラウザで開いて連携を許可してください。\n${authUrl}`
                    );
                    console.log(`${newMember.user.tag} に連携URLを送信しました。`);
                } catch (error) {
                    console.error(`送信エラー: ${newMember.user.tag} にDMを送れませんでした。`);
                }
            }
        });
    }
    //外れた場合
    else if (hadRole && !hasRole) {
        db.run(`DELETE FROM users WHERE discord_id = ?`, [newMember.id]);
        db.run(`DELETE FROM daily_reports WHERE discord_id = ?`, [newMember.id]);
        try {
            await newMember.send('👋 進捗報告ロールが外れたため、Bot内のX連携データを削除しました。お疲れ様でした！');
            console.log(`${newMember.user.tag} の連携データを削除しました。`);
        } catch (error) {
            console.error(`送信エラー: ${newMember.user.tag} に削除通知DMを送れませんでした。`);
        }
    }
});

//メッセージ受信処理
client.on('messageCreate', (message) => {
    if (message.author.bot) return;

    if (message.channel.isDMBased()) {
        if (message.content === '連携') {
            const authUrl = `http://127.0.0.1:${process.env.PORT}/auth?discord_id=${message.author.id}`;
            message.reply(`Xと連携するには、以下のURLをブラウザで開いて許可してください！\n${authUrl}`);
            return;
        }

        if (message.content === 'ツイートテスト') {
            const button = new ButtonBuilder()
                .setCustomId('open_goal_modal')
                .setLabel('今日の目標を入力する')
                .setStyle(ButtonStyle.Primary);
            const row = new ActionRowBuilder().addComponents(button);
            message.reply({ content: 'おはようございます！今日の目標を教えてください。', components: [row] });
            return;
        }

        if (message.content === '引用ツイートテスト') {
            db.get(`SELECT * FROM daily_reports WHERE discord_id = ?`, [message.author.id], (err, row) => {
                if (err || !row) return message.reply('被引用ツイートがありません。');
                
                const button = new ButtonBuilder()
                    .setCustomId('open_reflection_modal')
                    .setLabel('今日の振り返りを入力する')
                    .setStyle(ButtonStyle.Success);
                const actionRow = new ActionRowBuilder().addComponents(button);
                message.reply({ content: '1日お疲れ様でした！今日の目標の振り返りを教えてください。', components: [actionRow] });
            });
            return;
        }
    }
});

//ボタンとポップアップの処理＆ツイート実行
client.on(Events.InteractionCreate, async interaction => {
    //朝、ボタン処理
    if (interaction.isButton() && interaction.customId === 'open_goal_modal') {
        const modal = new ModalBuilder()
            .setCustomId('goal_submit_modal')
            .setTitle('今日の目標設定');
        const goalInput = new TextInputBuilder()
            .setCustomId('goal_input')
            .setLabel('今日の目標を宣言しましょう！')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);
        const actionRow = new ActionRowBuilder().addComponents(goalInput);
        modal.addComponents(actionRow);
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'goal_submit_modal') {
        const goalText = interaction.fields.getTextInputValue('goal_input');
        await interaction.reply({ content: 'Xへ投稿しています...', ephemeral: true });

        db.get(`SELECT * FROM users WHERE discord_id = ?`, [interaction.user.id], async (err, row) => {
            if (err || !row || !row.twitter_access_token) return interaction.editReply('まずはXと連携してください。「連携」とメッセージを送るとURLを発行します。');
            try {
                const userTwitterClient = new TwitterApi(row.twitter_access_token);
                const tweetText = `${goalText}`;
                const tweetResult = await userTwitterClient.v2.tweet(tweetText);
                
                const today = new Date().toLocaleDateString('sv-SE');
                db.run(`UPDATE users SET last_reply_date = ? WHERE discord_id = ?`, [today, interaction.user.id]);
                db.run(`INSERT OR REPLACE INTO daily_reports (discord_id, morning_tweet_id, is_evening_sent) VALUES (?, ?, 0)`, [interaction.user.id, tweetResult.data.id]);
                
                await interaction.editReply({ content: 'Xへの投稿が完了しました。良い一日を！' });
                console.log(`【朝のツイート完了】${interaction.user.tag}`);
            } catch (error) {
                console.error('朝のツイート投稿エラー:', error);
                await interaction.editReply({ content: '投稿に失敗しました。' });
            }
        });
    }

    //夜、ボタン処理
    if (interaction.isButton() && interaction.customId === 'open_reflection_modal') {
        const modal = new ModalBuilder()
            .setCustomId('reflection_submit_modal')
            .setTitle('今日の振り返り');
        const reflectionInput = new TextInputBuilder()
            .setCustomId('reflection_input')
            .setLabel('今日達成できたこと・反省点は？')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);
        const actionRow = new ActionRowBuilder().addComponents(reflectionInput);
        modal.addComponents(actionRow);
        await interaction.showModal(modal);
    }

    //引用
    if (interaction.isModalSubmit() && interaction.customId === 'reflection_submit_modal') {
        const reflectionText = interaction.fields.getTextInputValue('reflection_input');
        await interaction.reply({ content: 'Xへ引用リツイートで投稿しています...', ephemeral: true });

        db.get(`SELECT morning_tweet_id FROM daily_reports WHERE discord_id = ?`, [interaction.user.id], (err, reportRow) => {
            if (err || !reportRow) return interaction.editReply('今日の目標データが見つかりません。');
            db.get(`SELECT twitter_access_token FROM users WHERE discord_id = ?`, [interaction.user.id], async (err, userRow) => {
                if (err || !userRow || !userRow.twitter_access_token) return interaction.editReply('Xの連携データが見つかりません。');
                try {
                    const userTwitterClient = new TwitterApi(userRow.twitter_access_token);
                    const tweetText = `${reflectionText}`;
                    await userTwitterClient.v2.tweet({
                        text: tweetText,
                        quote_tweet_id: reportRow.morning_tweet_id
                    });
                    db.run(`UPDATE daily_reports SET is_evening_sent = 1 WHERE discord_id = ?`, [interaction.user.id]);
                    await interaction.editReply({ content: '夜の振り返りを引用リツイートで投稿しました！お疲れ様でした！' });
                    console.log(`【夜の引用ツイート完了】${interaction.user.tag}`);
                } catch (error) {
                    console.error('夜のツイート投稿エラー:', error);
                    await interaction.editReply({ content: '投稿に失敗しました。' });
                }
            });
        });
    }
});

client.login(process.env.DISCORD_TOKEN);