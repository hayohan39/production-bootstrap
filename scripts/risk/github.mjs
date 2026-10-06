// GitHub REST 최소 헬퍼 (Actions 의 GITHUB_TOKEN 으로 동작). gh CLI 에 의존하지 않는다.
import process from 'node:process';

const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';

export function repo() {
  const r = process.env.GITHUB_REPOSITORY;
  if (!r) throw new Error('GITHUB_REPOSITORY 가 없습니다.');
  return r;
}

export async function gh(path, { method = 'GET', body, allow404 = false } = {}) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN 이 없습니다.');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (allow404 && res.status === 404) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → HTTP ${res.status}: ${data?.message ?? text.slice(0, 200)}`);
  return data;
}

export async function paginate(path) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const items = await gh(`${path}${sep}per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}
