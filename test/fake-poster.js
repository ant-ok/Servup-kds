// In-memory stand-in for a Poster account, returning Poster-shaped payloads.
// Used by the tests directly and by mock-poster.js over HTTP for demos.
export class FakePoster {
  constructor() {
    this.workshops = [{ workshop_id: '1', workshop_name: 'Бар' }, { workshop_id: '2', workshop_name: 'Кухня' }];
    this.products = [
      { product_id: '10', product_name: 'Мохито', category_name: 'Коктейли', workshop: '1', modifications: [],
        ingredients: [
          { ingredient_name: 'Ром белый', structure_unit: 'ml', structure_netto: '50' },
          { ingredient_name: 'Лайм', structure_unit: 'p', structure_netto: '0.5' },
          { ingredient_name: 'Мята', structure_unit: 'g', structure_netto: '5' },
        ] },
      { product_id: '11', product_name: 'Негрони', category_name: 'Коктейли', workshop: '1', modifications: [],
        ingredients: [
          { ingredient_name: 'Джин', structure_unit: 'ml', structure_netto: '30' },
          { ingredient_name: 'Кампари', structure_unit: 'ml', structure_netto: '30' },
          { ingredient_name: 'Вермут красный', structure_unit: 'ml', structure_netto: '30' },
        ] },
      { product_id: '12', product_name: 'Латте', category_name: 'Кофе', workshop: '1',
        modifications: [{ modificator_id: '1', modificator_name: 'Овсяное молоко' }, { modificator_id: '2', modificator_name: 'Без сахара' }] },
      { product_id: '13', product_name: 'Пиво разливное', category_name: 'Пиво', workshop: '1', modifications: [] },
      { product_id: '20', product_name: 'Бургер', category_name: 'Кухня', workshop: '2', modifications: [] },
    ];
    this.employees = [
      { user_id: '1', name: 'Анна (официант)', role_name: 'Официант' },
      { user_id: '2', name: 'Олег (кассир)', role_name: 'Кассир' },
    ];
    this.transactions = new Map();
    this.nextId = 1000;
  }

  // --- control (what a waiter does at the register) ---
  open({ table = '5', waiter = 1, tablet = 1, comment = '', openedAt = Date.now() } = {}) {
    const id = String(this.nextId++);
    const emp = this.employees.find((e) => Number(e.user_id) === waiter);
    this.transactions.set(id, {
      transaction_id: id, status: '1', table_name: table, user_id: String(waiter), name: emp?.name ?? '',
      spot_id: '1', spot_tablet_id: String(tablet), guests_count: '2', transaction_comment: comment,
      date_start: String(openedAt), date_close: '0', sum: '0', payed_sum: '0', products: [],
    });
    return Number(id);
  }
  add(id, productId, num = 1, modificationId = '0') {
    const t = this.transactions.get(String(id));
    const line = t.products.find((p) => p.product_id === String(productId) && p.modification_id === String(modificationId));
    if (line) line.num = String(Number(line.num) + num);
    else t.products.push({ product_id: String(productId), modification_id: String(modificationId), num: String(num) });
    this.recalc(t);
  }
  remove(id, productId, num = 1, modificationId = '0') {
    const t = this.transactions.get(String(id));
    const line = t.products.find((p) => p.product_id === String(productId) && p.modification_id === String(modificationId));
    if (!line) return;
    line.num = String(Number(line.num) - num);
    t.products = t.products.filter((p) => Number(p.num) > 0);
    this.recalc(t);
  }
  close(id) {
    const t = this.transactions.get(String(id));
    t.status = '2';
    t.date_close = String(Date.now());
    t.payed_sum = t.sum;
  }
  delete(id) {
    const t = this.transactions.get(String(id));
    t.status = '3';
    t.date_close = String(Date.now());
  }
  recalc(t) {
    t.sum = String(t.products.reduce((s, p) => s + Number(p.num) * 50000, 0)); // 500 ₽ each, in kopecks
  }

  // --- adapter interface used by SyncEngine ---
  clone = (v) => JSON.parse(JSON.stringify(v));
  async getTransactions({ status = 0 }) {
    return this.clone([...this.transactions.values()].filter((t) => !status || Number(t.status) === status));
  }
  async getTransaction(id) { return this.clone(this.transactions.get(String(id)) ?? null); }
  async getProducts() { return this.clone(this.products.map(({ ingredients, ...p }) => p)); }
  async getProduct(id) {
    this.productCalls = (this.productCalls ?? 0) + 1;
    return this.clone(this.products.find((p) => p.product_id === String(id)) ?? null);
  }
  async getWorkshops() { return this.clone(this.workshops); }
  async getEmployees() { return this.clone(this.employees); }
}
