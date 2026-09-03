// Shared with the site build (knowledge eligibility runs there too), so the
// single implementation lives in web/src/lib and the harness re-exports it.
export { isSourceTextUnverifiable, sourceOwnedSnippet, type FeedSnippetEntry } from "../../web/src/lib/feed-snippet.ts";
