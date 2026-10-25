/* Admin dashboard: overview, orders, products, subscribers. */
const CSRF = document.querySelector('meta[name="csrf-token"]').content;
const CUR = JSON.parse(document.getElementById('nexus-config').textContent).currency;
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => CUR + Number(n || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
let products = [];

async function api(url, opts = {}) {
  opts.headers = {...(opts.headers || {}), 'X-CSRF-Token': CSRF};
  const r = await fetch(url, opts);
  let d = {}; try { d = await r.json(); } catch (_) {}
  if (r.status === 401) location.href = '/admin/login';
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
const json = (method, body) => ({method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

/* tabs */
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + name));
  document.querySelectorAll('#tabNav li').forEach(li => li.classList.toggle('active', li.querySelector('a')?.dataset.tab === name));
  if (name === 'overview') loadOverview(); if (name === 'orders') loadOrders(); if (name === 'products') fetchProducts(); if (name === 'subscribers') loadSubs();
}
document.querySelectorAll('#tabNav a[data-tab]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); history.replaceState(null, '', '#' + a.dataset.tab); showTab(a.dataset.tab); }));

/* overview */
async function loadOverview() {
  const s = await api('/admin/api/stats');
  const cards = [['Revenue', money(s.revenue)], ['Orders', s.orders], ['Pending', s.pending], ['Products', s.products], ['Low stock (≤3)', s.low_stock], ['Subscribers', s.subscribers]];
  $('#stats').innerHTML = cards.map(([l, v]) => `<div class="stat"><b>${esc(v)}</b><span>${l}</span></div>`).join('');
  const o = (await api('/admin/api/orders')).slice(0, 6);
  $('#recentBody').innerHTML = o.length ? o.map(x => `<tr><td><strong>${esc(x.order_number)}</strong></td><td>${esc(x.customer_name)}</td><td>${money(x.total)}</td><td><span class="pill ${x.status}">${x.status}</span></td></tr>`).join('') : '<tr><td colspan="4" style="text-align:center;padding:24px;color:#888">No orders yet</td></tr>';
}

/* orders */
async function loadOrders() {
  const list = await api('/admin/api/orders?status=' + encodeURIComponent($('#orderFilter').value));
  $('#orderBody').innerHTML = list.length ? list.map(o => `<tr>
    <td><strong>${esc(o.order_number)}</strong><br><small>${esc(o.payment_method.replace('_', ' '))}</small></td>
    <td>${esc(o.customer_name)}<br><small>${esc(o.phone)} · ${esc(o.city)}</small><br><small>${esc(o.address)}</small>${o.notes ? `<br><small><i>“${esc(o.notes)}”</i></small>` : ''}</td>
    <td class="items-cell">${o.items.map(i => `${i.quantity}× ${esc(i.name)}`).join('<br>')}</td>
    <td><strong>${money(o.total)}</strong>${o.promo_code ? `<br><small>${esc(o.promo_code)}</small>` : ''}</td>
    <td><small>${esc(o.created_at.replace('T', ' ').slice(0, 16))}</small></td>
    <td><select class="st-select" data-oid="${o.id}">${STATUSES.map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td></tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center;padding:30px;color:#888">No orders found</td></tr>';
}
$('#orderFilter').addEventListener('change', loadOrders);
$('#orderBody').addEventListener('change', async e => {
  const sel = e.target.closest('[data-oid]'); if (!sel) return;
  try { await api('/admin/api/orders/' + sel.dataset.oid, json('PATCH', {status: sel.value})); } catch (ex) { alert(ex.message); }
  loadOrders();
});

/* subscribers */
async function loadSubs() {
  const s = await api('/admin/api/subscribers');
  $('#subBody').innerHTML = s.length ? s.map(x => `<tr><td>${esc(x.email)}</td><td>${esc(x.created_at.slice(0, 10))}</td></tr>`).join('') : '<tr><td colspan="2" style="text-align:center;padding:24px;color:#888">No subscribers yet</td></tr>';
}

/* products */
async function fetchProducts() {
  products = await (await fetch('/api/products')).json();
  $('#productTableBody').innerHTML = products.map(p => {
    const badges = (p.is_new ? '<span class="status-badge new">New</span> ' : '') + (p.is_bestseller ? '<span class="status-badge bestseller">Bestseller</span>' : '');
    return `<tr><td><img src="${esc(p.image_url)}" alt="" class="product-img"></td><td><strong>${esc(p.name)}</strong><br><small>${esc(p.brand || '')}</small></td>
      <td>${esc(p.category)}</td><td>${money(p.price)}</td><td class="${p.stock <= 3 ? 'low' : ''}">${p.stock}</td><td>${badges}</td>
      <td><div class="action-btns"><button class="action-btn edit" onclick="editProduct(${p.id})" title="Edit"><i class="fas fa-edit"></i></button>
      <button class="action-btn delete" onclick="deleteProduct(${p.id})" title="Delete"><i class="fas fa-trash-alt"></i></button></div></td></tr>`;
  }).join('');
}
function openProductModal() {
  $('#modalTitle').innerText = 'Add product'; $('#productForm').reset();
  $('#productId').value = ''; $('#currentImageUrl').value = ''; $('#productModal').classList.add('active');
}
function closeProductModal() { $('#productModal').classList.remove('active'); }
function editProduct(id) {
  const p = products.find(x => x.id === id); if (!p) return;
  $('#modalTitle').innerText = 'Edit product'; $('#productId').value = p.id;
  const set = (k, v) => { $('#product' + k).value = v ?? ''; };
  set('Name', p.name); set('Price', p.price); set('Stock', p.stock); set('Category', p.category); set('Brand', p.brand);
  set('Rating', p.rating); set('ShortSpecs', p.short_specs); set('Description', p.description);
  set('FullSpecs', p.full_specs && Object.keys(p.full_specs).length ? JSON.stringify(p.full_specs) : '{}');
  $('#productIsNew').checked = p.is_new; $('#productIsBestseller').checked = p.is_bestseller;
  $('#currentImageUrl').value = p.image_url || ''; $('#productModal').classList.add('active');
}
async function deleteProduct(id) {
  if (!confirm('Delete this product? Past orders keep their own record.')) return;
  try { await api('/admin/api/products/' + id, {method: 'DELETE'}); fetchProducts(); } catch (ex) { alert(ex.message); }
}
async function handleProductSubmit(e) {
  e.preventDefault();
  const fd = new FormData($('#productForm')), id = $('#productId').value;
  fd.set('image_url', $('#currentImageUrl').value);
  fd.set('is_new', $('#productIsNew').checked); fd.set('is_bestseller', $('#productIsBestseller').checked);
  const btn = $('#saveProductBtn'); btn.disabled = true;
  try { await api(id ? '/admin/api/products/' + id : '/admin/api/products', {method: id ? 'PUT' : 'POST', body: fd}); closeProductModal(); fetchProducts(); }
  catch (ex) { alert(ex.message); } finally { btn.disabled = false; }
}
Object.assign(window, {openProductModal, closeProductModal, editProduct, deleteProduct, handleProductSubmit});
showTab(['overview', 'orders', 'products', 'subscribers'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview');
