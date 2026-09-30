# Agentic lifecycle 観測記録

この記録は [`agentic-engineering-rules.md` §6](../agentic-engineering-rules.md) の背景であり、新しい実行手順や承認の根拠ではない。判断時は Skill の手順と Git / PR / session の現在の事実を優先する。

## 起床、報告、停止

- 複数 project の継続運転では、次の turn を起こす経路が無いと作業が止まった。5 分以下の頻繁な automation は turn を消費する一方、15～20 分後の予約と future readback は空転を抑えた。
- 報告が届くまで最長 9 時間以上かかった例がある。message と durable artifact の世代が食い違うこともあったため、受信時刻・送信者の活動表示ではなく実物で確認する必要がある。
- `updated_at` が 41 分変わらなくても authoritative artifact が更新され、その後に message が届いた例がある。逆に open PR や dirty file の存在は作業が進行中という証拠ではなかった。
- 検証済み成果物が承認待ちで約 2 日止まったことがある。通常の判断と main merge 等の本人承認を混同すると liveness を損なう。

## 退役と回復

- archive 後に自動起床を残した session が message を送り続けた。常駐 process / cwd / log に ID が無い状況でも起きたため、退役前の自己 automation clear / absent readback が必要となった。
- 同じ terminal blocker について短時間に複数回 wake した例では新しい根拠が増えなかった。一方、完成済み dirty work は successor allowance を理由に保留され、durable publication の機会を失った。
- 上記は過去の診断の説明であり、固定の経過時間だけで session を交換する閾値ではない。保全された work と creator 権限、現在の owner、最新の evidence を別々に検証する。
