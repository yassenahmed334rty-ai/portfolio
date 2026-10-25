/* Nexus storefront - shared client logic (cart, wishlist, toast, cards).
   Prices shown here are for display only; the server re-prices every order. */
(() => {
  const CFG = JSON.parse(document.getElementById('nexus-config').textContent);
  const CART = 'nexus.cart.v2', WISH = 'nexus.wish.v2';
  const $ = (s, r = document) => r.querySelector(s);
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = n => CFG.currency + Number(n || 0).toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2});

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ---- cart ---- */
  const getCart = () => read(CART, []).filter(i => i && i.id && i.quantity > 0);
  function setCart(c) { write(CART, c); badges(); renderCart(); }
  function addToCart(p, qty = 1) {
    const cart = getCart();
    const hasStock = p.stock !== undefined && p.stock !== null && p.stock !== '';
    const stock = hasStock ? Math.max(0, Number(p.stock) || 0) : 10;
    const limit = Math.min(10, hasStock ? stock : (p.in_stock === false ? 0 : 10));
    if (limit < 1 || p.in_stock === false) { toast('This product is currently out of stock.'); return; }
    const hit = cart.find(i => i.id === p.id);
    if (hit) {
      hit.stock = limit;
      if (hit.quantity >= limit) { toast(`Only ${limit} available for this product.`); return; }
      hit.quantity = Math.min(limit, hit.quantity + qty);
    } else {
      cart.push({id: p.id, name: p.name, price: p.price, image_url: p.image_url, stock: limit, quantity: Math.min(limit, qty)});
    }
    setCart(cart); toast(`Added to cart: ${p.name}`);
  }
  function badges() {
    const n = getCart().reduce((s, i) => s + i.quantity, 0);
    const cb = $('#cartBadge'); if (cb) { cb.textContent = n || ''; cb.dataset.n = n; }
    const w = read(WISH, []).length, wb = $('#wishBadge'); if (wb) { wb.textContent = w || ''; wb.dataset.n = w; }
  }
  function renderCart() {
    const body = $('#cartBody'), foot = $('#cartFoot'); if (!body) return;
    const cart = getCart();
    if (!cart.length) {
      body.innerHTML = '<div class="empty" style="padding:60px 0"><i class="fas fa-shopping-bag" style="font-size:38px;margin-bottom:12px"></i><p>Your cart is empty.</p></div>';
      foot.innerHTML = ''; return;
    }
    const sub = cart.reduce((s, i) => s + i.price * i.quantity, 0);
    body.innerHTML = cart.map(i => `<div class="line"><img src="${esc(i.image_url)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/static/uploads/images.jpg'">
      <div><b>${esc(i.name)}</b><div class="meta">${fmt(i.price)}</div>
      <div class="mini"><button data-q="${i.id}" data-d="-1" aria-label="Decrease">−</button><span>${i.quantity}</span><button data-q="${i.id}" data-d="1" aria-label="Increase">+</button></div>
      <button class="link" data-rm="${i.id}">Remove</button></div></div>`).join('');
    const left = Math.max(0, CFG.freeShip - sub), pct = Math.min(100, sub / CFG.freeShip * 100);
    foot.innerHTML = `<div class="ship-note">${left > 0 ? `Add ${fmt(left)} more for free shipping` : 'You qualify for free shipping 🎉'}</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="sum-row total"><span>Subtotal</span><span>${fmt(sub)}</span></div>
      <p class="ship-note">Shipping and discounts are calculated at checkout.</p>
      <a class="btn btn-block" href="/checkout">Checkout <i class="fas fa-lock"></i></a>`;
  }
  async function syncPrices() { // refresh cached prices from the server
    const cart = getCart(); if (!cart.length) return;
    try {
      const r = await fetch('/api/quote', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({items: cart})});
      if (!r.ok) return;
      const q = await r.json();
      setCart(cart.map(i => { const l = q.lines.find(x => x.id === i.id); return l ? {...i, price: l.unit_price, name: l.name} : i; }));
    } catch (_) {}
  }
  function openCart() { $('#drawer').classList.add('open'); $('#shade').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); renderCart(); syncPrices(); }
  function closeCart() { $('#drawer').classList.remove('open'); $('#shade').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); }

  /* ---- wishlist ---- */
  const wished = id => read(WISH, []).includes(id);
  function toggleWish(id) {
    let w = read(WISH, []); w = w.includes(id) ? w.filter(x => x !== id) : [...w, id];
    write(WISH, w); badges(); return w.includes(id);
  }

  /* ---- shared product card ---- */
  function cardHTML(p) {
    const out = !p.in_stock;
    const tag = out ? '<span class="tag out">Sold out</span>' : p.is_new ? '<span class="tag">Just arrived</span>' : p.is_bestseller ? '<span class="tag bestseller"><i class="fas fa-fire"></i> Popular pick</span>' : '';
    const rating = Number(p.rating || 0);
    const starCount = Math.max(0, Math.min(5, Math.round(rating)));
    const starsMarkup = '★'.repeat(starCount) + '☆'.repeat(5 - starCount);
    const stars = rating ? `<div class="card-rating" aria-label="Rated ${rating.toFixed(1)} out of 5"><span class="stars-mini">${starsMarkup}</span><b>${rating.toFixed(1)}</b><span>rating</span></div>` : '<div class="card-rating muted-rating"><i class="fas fa-circle-check"></i><span>Carefully selected tech</span></div>';
    return `<article class="card">${tag}
      <button class="wish" data-wish="${p.id}" type="button" aria-label="Toggle wishlist"><i class="${wished(p.id) ? 'fas' : 'far'} fa-heart"></i></button>
      <a href="/product/${p.id}" class="card-main"><div class="img"><img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" onerror="this.onerror=null;this.src='/static/uploads/images.jpg'"></div>
      <div class="brand">${esc(p.brand || '')}</div><div class="name">${esc(p.name)}</div><div class="specs">${esc(p.short_specs || '')}</div>${stars}</a>
      <div class="foot"><span class="price">${fmt(p.price)}</span><button class="add" data-add="${p.id}" type="button" ${out ? 'disabled' : ''}>${out ? 'Sold out' : '<i class="fas fa-bag-shopping"></i> Add to cart'}</button></div></article>`;
  }
  function bindCards(root, products) {
    root.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
      const p = products.find(x => x.id === +b.dataset.add); if (p) addToCart(p, 1);
    }));
    root.querySelectorAll('[data-wish]').forEach(b => b.addEventListener('click', () => {
      const on = toggleWish(+b.dataset.wish);
      b.querySelector('i').className = (on ? 'fas' : 'far') + ' fa-heart'; toast(on ? 'Saved to wishlist' : 'Removed from wishlist');
    }));
  }

  /* ---- boot ---- */
  document.addEventListener('DOMContentLoaded', () => {
    badges();
    $('#openCart')?.addEventListener('click', openCart);
    $('#closeCart')?.addEventListener('click', closeCart);
    $('#shade')?.addEventListener('click', closeCart);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCart(); });
    $('#cartBody')?.addEventListener('click', e => {
      const q = e.target.closest('[data-q]'), rm = e.target.closest('[data-rm]');
      if (q) setCart(getCart().map(i => { if (i.id !== +q.dataset.q) return i; const max = Math.min(10, Number(i.stock) > 0 ? Number(i.stock) : 10); const next = Math.min(max, i.quantity + Number(q.dataset.d)); if (next === i.quantity && Number(q.dataset.d) > 0) toast(`Maximum available: ${max}`); return {...i, quantity: next}; }).filter(i => i.quantity > 0));
      if (rm) setCart(getCart().filter(i => i.id !== +rm.dataset.rm));
    });
    // highlight current nav item
    const here = location.pathname + location.search;
    document.querySelectorAll('#mainNav a').forEach(a => { if (a.getAttribute('href') === here) a.classList.add('active'); });

    // Scroll reveal and back-to-top: gracefully falls back when motion APIs are unavailable.
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const revealTargets = '.hero, .trust > div, .cat-card, .sidebar, .toolbar, .card, .pdp, .specs, .related, .panel, .site-footer .foot-grid > div';
    if (!reducedMotion && 'IntersectionObserver' in window) {
      const revealObserver = new IntersectionObserver(entries => entries.forEach(entry => {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); revealObserver.unobserve(entry.target); }
      }), {threshold: 0.08, rootMargin: '0px 0px -24px 0px'});
      const scan = root => (root || document).querySelectorAll(revealTargets).forEach(el => {
        if (!el.classList.contains('motion-ready')) { el.classList.add('motion-ready'); revealObserver.observe(el); }
      });
      scan();
      const mutations = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
        if (node.nodeType === 1) { if (node.matches?.(revealTargets)) scan(node.parentElement || document); else scan(node); }
      })));
      mutations.observe(document.body, {childList: true, subtree: true});
    } else {
      document.querySelectorAll(revealTargets).forEach(el => el.classList.add('is-visible'));
    }
    const topButton = $('#backToTop');
    const updateTopButton = () => topButton?.classList.toggle('visible', window.scrollY > 520);
    window.addEventListener('scroll', updateTopButton, {passive: true}); updateTopButton();
    topButton?.addEventListener('click', () => window.scrollTo({top: 0, behavior: reducedMotion ? 'auto' : 'smooth'}));
  });

  window.Store = {CFG, $, esc, fmt, toast, getCart, setCart, addToCart, openCart, closeCart, cardHTML, bindCards, wished, toggleWish, read, write, syncPrices};
})();
