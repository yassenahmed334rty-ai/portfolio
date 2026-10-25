/* Homepage: catalogue, filters, sorting, hero. */
(() => {
  const {$, esc, fmt, toast, cardHTML, bindCards, wished} = Store;
  const state = {products: [], q: '', cat: '', brand: '', max: Infinity, stock: false, sort: 'featured', wishlist: false};
  const params = new URLSearchParams(location.search);

  const SLIDES = [
    ['New season', 'Performance that keeps up with you', "Hand-picked laptops from the world's best brands.", '#shop'],
    ['Gaming & creators', 'Power without compromise', 'High-refresh displays and flagship graphics for play and production.', '?cat=Gaming%20Laptops'],
    ['Work & study', 'Reliable all-day laptops', 'Light, fast and built to last through every deadline.', '?sort=best']
  ];

  async function init() {
    try {
      const r = await fetch('/api/products'); if (!r.ok) throw 0;
      state.products = await r.json();
    } catch (_) {
      $('#productsGrid').innerHTML = '<div class="empty"><h3>We couldn\'t load the products</h3><p>Please refresh the page.</p></div>'; return;
    }
    setupHeroProduct();
    const maxP = Math.ceil(Math.max(...state.products.map(p => p.price), 100) / 50) * 50;
    const range = $('#priceRange'); range.max = maxP; range.value = maxP; state.max = maxP;
    state.q = params.get('q') || ''; state.cat = params.get('cat') || ''; state.sort = params.get('sort') || 'featured';
    state.wishlist = params.get('wishlist') === '1';
    $('#searchInput').value = state.q; $('#sortSelect').value = ['featured','new','best','price-asc','price-desc','rating'].includes(state.sort) ? state.sort : 'featured';
    buildCategories(); buildBrands(); buildCards(); bind(); render();
  }

  function setupHeroProduct() {
    const featured = state.products.find(p => p.is_bestseller && p.in_stock) || state.products.find(p => p.in_stock) || state.products[0];
    if (!featured) return;
    const img = $('#heroProductImage');
    img.onerror = () => { img.onerror = null; img.src = '/static/uploads/images.jpg'; };
    img.src = featured.image_url || ''; 
    img.alt = featured.name || 'Featured product';
    $('#heroProductName').textContent = featured.name || 'Featured device';
    $('#heroProductPrice').textContent = fmt(featured.price);
    $('#heroProductLink').href = `/product/${featured.id}`;
  }

  function buildCategories() {
    const cats = [...new Set(state.products.map(p => p.category))].sort();
    $('#catSelect').innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option ${c === state.cat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  }
  function buildBrands() {
    const brands = [...new Set(state.products.map(p => p.brand).filter(Boolean))].sort();
    $('#brandChips').innerHTML = brands.map(b => `<button type="button" class="chip" data-brand="${esc(b)}">${esc(b)}</button>`).join('');
  }
  function buildCards() {
    const by = {};
    state.products.forEach(p => (by[p.category] ||= []).push(p));
    $('#catCards').innerHTML = Object.entries(by).sort().slice(0, 6).map(([c, list]) =>
      `<button type="button" class="cat-card" data-cat="${esc(c)}"><div><b>${esc(c)}</b><span>${list.length} products</span></div><img src="${esc(list[0].image_url)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/static/uploads/images.jpg'"></button>`).join('');
  }

  function filtered() {
    const t = state.q.trim().toLowerCase();
    let list = state.products.filter(p => {
      if (state.wishlist && !wished(p.id)) return false;
      if (state.cat && p.category !== state.cat) return false;
      if (state.brand && p.brand !== state.brand) return false;
      if (p.price > state.max) return false;
      if (state.stock && !p.in_stock) return false;
      if (!t) return true;
      const hay = [p.name, p.category, p.brand, p.short_specs, Object.values(p.full_specs || {}).join(' ')].join(' ').toLowerCase();
      return t.split(/\s+/).every(w => hay.includes(w));
    });
    const s = state.sort;
    if (s === 'price-asc') list.sort((a, b) => a.price - b.price);
    else if (s === 'price-desc') list.sort((a, b) => b.price - a.price);
    else if (s === 'rating') list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (s === 'new') list.sort((a, b) => b.is_new - a.is_new);
    else if (s === 'best') list.sort((a, b) => b.is_bestseller - a.is_bestseller);
    return list;
  }

  function render() {
    const list = filtered(), grid = $('#productsGrid');
    $('#resultCount').textContent = `${list.length} product${list.length === 1 ? '' : 's'}`;
    $('#listTitle').textContent = state.wishlist ? 'Your wishlist' : state.cat || (state.q ? `Results for “${state.q}”` : 'All laptops');
    $('#priceLabel').textContent = fmt(state.max);
    document.querySelectorAll('[data-brand]').forEach(c => c.classList.toggle('on', c.dataset.brand === state.brand));
    if (!list.length) {
      grid.innerHTML = `<div class="empty"><i class="fas fa-magnifying-glass" style="font-size:34px;margin-bottom:10px"></i><h3>${state.wishlist ? 'Your wishlist is empty' : 'No products match your filters'}</h3><p style="margin:6px 0 16px">${state.wishlist ? 'Tap the heart on any product to save it.' : 'Try a different search or clear the filters.'}</p><button class="btn" id="clearAll" type="button">Show all products</button></div>`;
      $('#clearAll').onclick = reset; return;
    }
    grid.innerHTML = list.map(cardHTML).join(''); bindCards(grid, state.products);
  }
  function reset() {
    Object.assign(state, {q: '', cat: '', brand: '', stock: false, sort: 'featured', wishlist: false, max: +$('#priceRange').max});
    $('#searchInput').value = ''; $('#catSelect').value = ''; $('#priceRange').value = state.max; $('#inStockOnly').checked = false; $('#sortSelect').value = 'featured';
    history.replaceState(null, '', '/'); render();
  }
  const scrollToShop = () => $('#shop').scrollIntoView({behavior: 'smooth'});

  function bind() {
    $('#searchForm').addEventListener('submit', e => { e.preventDefault(); state.q = $('#searchInput').value; state.wishlist = false; render(); scrollToShop(); });
    $('#searchInput').addEventListener('input', e => { state.q = e.target.value; render(); });
    $('#catSelect').addEventListener('change', e => { state.cat = e.target.value; render(); });
    $('#sortSelect').addEventListener('change', e => { state.sort = e.target.value; render(); });
    $('#priceRange').addEventListener('input', e => { state.max = +e.target.value; render(); });
    $('#inStockOnly').addEventListener('change', e => { state.stock = e.target.checked; render(); });
    $('#brandChips').addEventListener('click', e => { const b = e.target.closest('[data-brand]'); if (!b) return; state.brand = state.brand === b.dataset.brand ? '' : b.dataset.brand; render(); });
    $('#catCards').addEventListener('click', e => { const c = e.target.closest('[data-cat]'); if (!c) return; state.cat = c.dataset.cat; $('#catSelect').value = state.cat; render(); scrollToShop(); });
    $('#newsForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const r = await fetch('/api/subscribe', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: $('#newsEmail').value})});
        const d = await r.json(); toast(d.message || d.error);
        if (r.ok) $('#newsEmail').value = '';
      } catch (_) { toast('Network error. Please try again.'); }
    });
    document.querySelectorAll('#mainNav a').forEach(a => a.classList.remove('active'));
    const key = state.sort === 'new' ? 'new' : state.sort === 'best' ? 'best' : 'home';
    document.querySelector(`#mainNav [data-nav="${key}"]`)?.classList.add('active');
    // hero
    let i = 0, timer; const dots = $('#heroDots');
    dots.innerHTML = SLIDES.map((_, n) => `<button type="button" aria-label="Slide ${n + 1}"></button>`).join('');
    const show = n => { i = n; const s = SLIDES[n];
      const text = $('.hero-text'); text?.classList.remove('slide-in'); void text?.offsetWidth; text?.classList.add('slide-in');
      $('#heroKicker').textContent = s[0]; $('#heroTitle').textContent = s[1]; $('#heroCopy').textContent = s[2];
      dots.querySelectorAll('button').forEach((d, k) => d.classList.toggle('on', k === n)); };
    dots.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; show([...dots.children].indexOf(b)); clearInterval(timer); });
    $('#heroCta').addEventListener('click', e => { e.preventDefault(); const t = SLIDES[i][3];
      if (t.startsWith('?')) { const p = new URLSearchParams(t); state.cat = p.get('cat') || ''; state.sort = p.get('sort') || 'featured'; $('#catSelect').value = state.cat; $('#sortSelect').value = state.sort; render(); }
      scrollToShop(); });
    show(0);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) timer = setInterval(() => show((i + 1) % SLIDES.length), 6500);
  }
  init();
})();
