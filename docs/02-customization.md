# User Customization

tech-dashboard はデフォルトで Tier 1〜3 の 31 ソースを自動収集しますが、ユーザ個別の購読リストを追加できます。

## OPML インポート (推奨)

任意の RSS リーダ (Feedly / Inoreader / NetNewsWire 等) からエクスポートした OPML ファイルを `data/user-opml.xml` として配置するだけで、harness が次回実行時に自動的に取り込みます。

```bash
# Feedly からエクスポートした OPML を配置
cp ~/Downloads/feedly.opml tech-dashboard/data/user-opml.xml

# 次回 `npm run collect` で自動取り込み
npm run collect
```

### 制約

- 最大 20 フィードまで (過剰な外部 IO を避けるため)
- 各フィードから最大 10 エントリ
- 取得に失敗したフィードは静かにスキップ
- `data/user-opml.xml` は `.gitignore` 済み (個人リストが公開リポに入らない)

## YouTube チャンネル追加

`harness/registry.ts` の末尾に追記:

```ts
"youtube-<id>": {
  ...youtubeChannel(
    "youtube-<id>",
    "YouTube — <Channel Name>",
    "<CHANNEL_ID>",   // UCxxxx (24 chars, starts with UC)
    ["<tag>"],
  ),
  category: "<category>",  // 13 カテゴリのいずれか
},
```

チャンネル ID の確認方法: YouTube チャンネルページの HTML ソースで `"channelId":"UC..."` を検索。

## Hacker News クエリ調整

`hn-ai` ソースの `feedUrl` を編集すれば任意の Algolia クエリが使えます:

```
https://hn.algolia.com/api/v1/search?query=<keywords>&tags=story&hitsPerPage=30
```

## カスタム RSS 追加

通常の RSS/Atom フィードは registry.ts に直接追加:

```ts
"my-feed": {
  id: "my-feed",
  displayName: "My Feed",
  category: "research",
  sourceType: "blog",
  defaultLang: "ja",
  autoTags: ["custom"],
  feedUrl: "https://example.com/rss",
  tier: 3,
  collect: collectRss,
},
```
