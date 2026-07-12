export function sourceHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function sourceFaviconUrl(url: string): string {
  const host = sourceHost(url);
  return host ? `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico` : "";
}
