// api/_ghvars.js — sniper-bot 저장소 Actions Variables 읽기/쓰기
// GH_TOKEN 에 sniper-bot 의 "Variables: Read and write" 권한이 있어야 한다.
const OWNER = 'versuskorea', REPO = 'sniper-bot';
const H = () => ({
  Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hunter-v10-manual', 'Content-Type': 'application/json',
});
const U = p => `https://api.github.com/repos/${OWNER}/${REPO}/actions/variables${p}`;

export async function readAll() {
  const out = {};
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(U(`?per_page=30&page=${page}`), { headers: H() });
    if (r.status !== 200) throw new Error(`Variables 읽기 실패 ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    for (const v of j.variables || []) out[v.name] = v.value;
    if ((j.variables || []).length < 30) break;
  }
  return out;
}

export async function write(name, value, exists) {
  const v = String(value);
  let r = await fetch(U(exists ? `/${name}` : ''), {
    method: exists ? 'PATCH' : 'POST', headers: H(), body: JSON.stringify({ name, value: v }),
  });
  if (r.status === 404 && exists) r = await fetch(U(''), { method: 'POST', headers: H(), body: JSON.stringify({ name, value: v }) });
  if (r.status === 409 && !exists) r = await fetch(U(`/${name}`), { method: 'PATCH', headers: H(), body: JSON.stringify({ name, value: v }) });
  if (![201, 204].includes(r.status)) throw new Error(`Variables 쓰기 실패 ${name} ${r.status} ${(await r.text()).slice(0, 200)}`);
}
