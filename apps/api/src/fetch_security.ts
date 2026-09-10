import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_REDIRECTS = Number(process.env.CRAWL_MAX_REDIRECTS || 5);
const MAX_BYTES = Number(process.env.CRAWL_MAX_BYTES || 3 * 1024 * 1024);
const TIMEOUT_MS = Number(process.env.CRAWL_TIMEOUT_MS || 15000);

function isPrivateIpv4(ip: string) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a,b] = parts;
  return a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    a >= 224;
}

function isPrivateIpv6(ip: string) {
  const value = ip.toLowerCase();
  return value === '::' || value === '::1' || value.startsWith('fe80:') ||
    value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff');
}

export function isBlockedIp(ip: string) {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true;
}

export async function assertPublicHttpUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!['http:','https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('blocked_host');
  }
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') throw new Error('blocked_metadata_host');
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error('blocked_private_ip');
  } else {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length) throw new Error('dns_resolution_failed');
    if (addresses.some((entry) => isBlockedIp(entry.address))) throw new Error('blocked_private_dns_result');
  }
  return url;
}

async function readBodyLimited(response: Response, maxBytes = MAX_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error('response_too_large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('response_too_large');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

export async function safeFetchText(rawUrl: string, init: RequestInit = {}, maxBytes = MAX_BYTES) {
  let current = rawUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    await assertPublicHttpUrl(current);
    const response = await fetch(current, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect_without_location');
      if (redirectCount === MAX_REDIRECTS) throw new Error('too_many_redirects');
      current = new URL(location, current).toString();
      continue;
    }
    const body = await readBodyLimited(response, maxBytes);
    return { response, body, finalUrl: current };
  }
  throw new Error('too_many_redirects');
}
