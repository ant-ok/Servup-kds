// Fake Poster API over HTTP for local demos without a real account:
//   npm run mock-poster   (port 4100)
//   POSTER_API_URL=http://localhost:4100/api POSTER_TOKEN=demo npm start
//   npm run simulate      (places random orders)
import express from 'express';
import { FakePoster } from './fake-poster.js';

const fake = new FakePoster();
const app = express();
app.use(express.json());

const methods = {
  'dash.getTransactions': (q) => fake.getTransactions({ status: Number(q.status ?? 0) }),
  'dash.getTransaction': (q) => fake.getTransaction(q.transaction_id),
  'menu.getProducts': () => fake.getProducts(),
  'menu.getWorkshops': () => fake.getWorkshops(),
  'access.getEmployees': () => fake.getEmployees(),
};

app.get('/api/:method', async (req, res) => {
  const fn = methods[req.params.method];
  if (!fn) return res.json({ error: { code: 10, message: `Unknown method ${req.params.method}` } });
  res.json({ response: await fn(req.query) });
});

// Control endpoints that imitate actions at the register.
app.post('/_mock/open', (req, res) => res.json({ id: fake.open(req.body) }));
app.post('/_mock/:id/add', (req, res) => res.json(fake.add(req.params.id, req.body.product_id, req.body.num ?? 1, req.body.modification_id ?? '0') ?? { ok: true }));
app.post('/_mock/:id/remove', (req, res) => res.json(fake.remove(req.params.id, req.body.product_id, req.body.num ?? 1, req.body.modification_id ?? '0') ?? { ok: true }));
app.post('/_mock/:id/close', (req, res) => res.json(fake.close(req.params.id) ?? { ok: true }));
app.post('/_mock/:id/delete', (req, res) => res.json(fake.delete(req.params.id) ?? { ok: true }));

const port = Number(process.env.MOCK_PORT ?? 4100);
app.listen(port, () => console.log(`[mock-poster] http://localhost:${port}/api`));
