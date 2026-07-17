# Upstream

このディレクトリは Hallmark の project-scoped GitHub Copilot skill を
固定版で vendoring したものです。

| 項目 | 値 |
|---|---|
| Repository | `https://github.com/nutlope/hallmark` |
| Version | `1.1.0` |
| Commit | `aeb42fb354ff4efa36ab475773a082315a3af2ce` |
| Source path | `skills/hallmark/` |
| License | MIT, Copyright (c) 2026 Hallmark contributors |

`SKILL.md` と `references/**` は upstream canonical content を変更せずに
保持します。プロジェクト固有の補足はこのファイルへ記録し、canonical
files へ追記しません。

## Update procedure

公開 repository の更新先 commit を確認し、次の手順で置き換えます。

```sh
tmp="$(mktemp -d)"
git clone https://github.com/nutlope/hallmark.git "$tmp"
git -C "$tmp" checkout <full-commit-sha>
rsync -a --delete \
  --exclude LICENSE \
  --exclude UPSTREAM.md \
  "$tmp/skills/hallmark/" \
  .github/skills/hallmark/
cp "$tmp/LICENSE" .github/skills/hallmark/LICENSE
```

`SKILL.md` frontmatter の version と root `LICENSE` を確認し、この表の
version と commit を更新します。demo site や `site/`、repository docs、
dependency manifests はコピーしません。

次の parity check を実行し、差分がないことを確認します。

```sh
diff -qr \
  --exclude LICENSE \
  --exclude UPSTREAM.md \
  "$tmp/skills/hallmark" \
  .github/skills/hallmark
rm -r "$tmp"
```

固定 commit では canonical content が 106 files
(`SKILL.md` 1 file + `references/**` 105 files) です。

## Reference scope

固定 commit の Markdown local links 274 件のうち、canonical folder 内の
261 件は解決します。残る 13 件は upstream repository の `site/` または
`docs/` を参照する例示リンクです。demo site と unrelated docs を
vendoring しない方針により、これらは upstream context の参照として
canonical text のまま保持します。

固定 commit の `references/component-cookbook.md` は末尾に空行を持つため、
新規追加時の `git diff --check` が `new blank line at EOF` を1件報告します。
これは upstream byte parity の一部として保持し、project-authored files の
diff check は canonical `SKILL.md` / `references/**` を除外して実行します。
