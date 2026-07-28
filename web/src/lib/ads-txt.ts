const ADSENSE_CLIENT_ID_PATTERN = /^ca-(pub-\d{16})$/;
const GOOGLE_ADSENSE_AUTHORITY_ID = "f08c47fec0942fa0";

export function buildAdsTxt(clientId: string): string {
  const match = ADSENSE_CLIENT_ID_PATTERN.exec(clientId);
  if (!match) {
    throw new Error("ADSENSE_CLIENT_ID must match ca-pub- followed by exactly 16 digits");
  }

  return `google.com, ${match[1]}, DIRECT, ${GOOGLE_ADSENSE_AUTHORITY_ID}\n`;
}
