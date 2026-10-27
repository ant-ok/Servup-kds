// Places random orders on the mock Poster so the KDS can be tried out.
const base = process.env.MOCK_URL ?? 'http://localhost:4100';
const post = (path, body = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const open = [];
setInterval(async () => {
  const roll = Math.random();
  if (roll < 0.45 || !open.length) {
    const { id } = await post('/_mock/open', { table: String(1 + Math.floor(Math.random() * 12)), waiter: pick([1, 2]), tablet: pick([1, 2]) });
    await post(`/_mock/${id}/add`, { product_id: pick([10, 11, 13]), num: pick([1, 1, 2, 3]) });
    if (Math.random() < 0.5) await post(`/_mock/${id}/add`, { product_id: 12, modification_id: pick(['1', '2']) });
    if (Math.random() < 0.3) await post(`/_mock/${id}/add`, { product_id: 20 });
    open.push(id);
    console.log('новый чек', id);
  } else if (roll < 0.7) {
    const id = pick(open);
    await post(`/_mock/${id}/add`, { product_id: pick([10, 11, 13]) });
    console.log('дозаказ', id);
  } else {
    const id = open.shift();
    await post(`/_mock/${id}/close`);
    console.log('закрыт', id);
  }
}, Number(process.env.EVERY_MS ?? 8000));
