/**
 * Off-topic titles stay in the Timeline but not in decision slots or the
 * major-update feed, even if their stored importance is high.
 */
const OFF_TOPIC_HERO_RE =
  /\b(?:gta|grand theft auto|playstation|ps5|ps6|xbox|nintendo|switch\s*2|fortnite|call of duty|bungie|destiny\s*2|steam\s*(?:machine|deck)|cloud gaming|geforce now|gaming\s*(?:monitor|laptop|handheld|pc|rig|chair|mouse|keyboard|headset)|qd-?oled|handheld console|game console)\b/i;

export function isOffTopicForHero(
  entry: { title: string; titleEn?: string | null; titleJa?: string | null },
): boolean {
  return [entry.title, entry.titleEn, entry.titleJa].some(
    (title) => !!title && OFF_TOPIC_HERO_RE.test(title),
  );
}
