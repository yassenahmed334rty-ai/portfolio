/* Checkout: server-priced summary, promo codes, order submission. */
(() => {
  const {$, esc, fmt, toast, getCart, setCart} = Store;
  let promo = '';
  const show = (id, on) => { $(id).hidden = !on; };

  async function quote() {
    const items = getCart();
    if (!items.length) { show('#emptyMsg', true); show('#coWrap', false); return null; }
    show('#emptyMsg', false); show('#coWrap', true);
    let r, q;
    try {
      r = await fetch('/api/quote', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({items, promo})});
      q = await r.json();
    } catch (_) {
      $('#sumLines').innerHTML = '<div class="alert alert-bad">We could not connect to the store. Check your connection and refresh.</div>';
      $('#sumTotals').innerHTML = ''; $('#placeBtn').disabled = true; return null;
    }
    if (!r.ok) { $('#sumLines').innerHTML = `<div class="alert alert-bad">${esc(q.error)}</div><a class="btn btn-ghost btn-block" href="/">Back to the store</a>`; $('#sumTotals').innerHTML = ''; $('#placeBtn').disabled = true; return null; }
    $('#placeBtn').disabled = false;
    $('#sumLines').innerHTML = q.lines.map(l => `<div class="line"><img src="${esc(l.image_url)}" alt="" onerror="this.onerror=null;this.src='/static/uploads/images.jpg'"><div><b>${esc(l.name)}</b><div class="meta">${fmt(l.unit_price)} × ${l.quantity}</div></div></div>`).join('');
    $('#sumTotals').innerHTML = `<div class="sum-row"><span>Subtotal</span><span>${fmt(q.subtotal)}</span></div>` +
      (q.discount ? `<div class="sum-row"><span>Discount (${esc(q.promo_code)} −${q.promo_percent}%)</span><span class="ok">−${fmt(q.discount)}</span></div>` : '') +
      `<div class="sum-row"><span>Shipping</span><span>${q.shipping ? fmt(q.shipping) : 'Free'}</span></div><div class="sum-row total"><span>Total</span><span>${fmt(q.total)}</span></div>`;
    return q;
  }

  $('#promoForm').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('#promo').value.trim().toUpperCase(); if (!code) return;
    try {
      const r = await fetch('/api/validate-promo', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code})});
      const d = await r.json();
      if (!r.ok || !d.valid) return toast('That promo code is not valid');
      promo = code; toast(`Promo applied: ${d.discount}% off`); await quote();
    } catch (_) { toast('Network error. Please try again.'); }
  });

  $('#coForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, err = $('#formError'), btn = $('#placeBtn');
    err.hidden = true;
    if (!f.reportValidity()) return;
    const body = {
      items: getCart(), promo, payment_method: f.payment_method.value,
      customer: {name: f.name.value, phone: f.phone.value, email: f.email.value, city: f.city.value, address: f.address.value, notes: f.notes.value}
    };
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Placing order…';
    try {
      const r = await fetch('/api/orders', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not place the order.');
      setCart([]); location.href = d.redirect;
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false; err.scrollIntoView({behavior: 'smooth', block: 'center'});
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-lock"></i> Place order';
    }
  });
  document.addEventListener('DOMContentLoaded', quote);
})();
