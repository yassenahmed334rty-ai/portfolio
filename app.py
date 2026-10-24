"""Nexus Store - e-commerce storefront with order management and admin panel.

Configuration is read from environment variables (or a .env file). See .env.example.
"""
import csv
import io
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from functools import wraps

from flask import (Flask, Response, abort, g, jsonify, redirect, render_template,
                   request, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

try:  # optional dependency
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # pragma: no cover
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
log = logging.getLogger("nexus")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def env(name, default=""):
    return os.environ.get(name, default)


def parse_promos(raw):
    codes = {}
    for part in raw.split(","):
        if ":" in part:
            code, pct = part.split(":", 1)
            try:
                codes[code.strip().upper()] = max(0, min(90, int(pct)))
            except ValueError:
                continue
    return codes


class Config:
    STORE_NAME = env("STORE_NAME", "Nexus")
    STORE_TAGLINE = env("STORE_TAGLINE", "Premium laptops, delivered with confidence")
    CURRENCY = env("CURRENCY_SYMBOL", "$")
    CURRENCY_CODE = env("CURRENCY_CODE", "USD")
    SUPPORT_PHONE = env("SUPPORT_PHONE", "")
    SUPPORT_EMAIL = env("SUPPORT_EMAIL", "")
    WHATSAPP_NUMBER = re.sub(r"\D", "", env("WHATSAPP_NUMBER", ""))
    ANNOUNCEMENT = env("ANNOUNCEMENT", "Free shipping on qualifying orders")
    FREE_SHIPPING_THRESHOLD = float(env("FREE_SHIPPING_THRESHOLD", "500"))
    SHIPPING_FEE = float(env("SHIPPING_FEE", "15"))
    PROMO_CODES = parse_promos(env("PROMO_CODES", "NEXUS10:10"))
    ORDER_PREFIX = env("ORDER_PREFIX", "NX")
    SITE_URL = env("SITE_URL", "").rstrip("/")
    MAX_CONTENT_LENGTH = 6 * 1024 * 1024
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = env("COOKIE_SECURE", "0") == "1"
    DATABASE = env("DATABASE_PATH", os.path.join(BASE_DIR, "store.db"))
    UPLOAD_FOLDER = os.path.join(BASE_DIR, "static", "uploads")


app = Flask(__name__)
app.config.from_object(Config)

# --- Secrets & admin credentials --------------------------------------------
# Development can start without a .env file; production must be explicitly configured.
IS_PRODUCTION = env("APP_ENV", "development").strip().lower() == "production"
_secret = env("SECRET_KEY").strip()
if IS_PRODUCTION and len(_secret) < 32:
    raise RuntimeError("Production requires SECRET_KEY with at least 32 characters. Configure it in .env.")
app.secret_key = _secret or secrets.token_hex(32)
if not _secret:
    log.warning("Development SECRET_KEY generated for this run. Set SECRET_KEY in .env for persistent sessions.")

ADMIN_EMAIL = env("ADMIN_EMAIL", "admin@example.com").strip().lower()
if env("ADMIN_PASSWORD_HASH"):
    ADMIN_HASH = env("ADMIN_PASSWORD_HASH")
elif env("ADMIN_PASSWORD"):
    ADMIN_HASH = generate_password_hash(env("ADMIN_PASSWORD"))
elif IS_PRODUCTION:
    raise RuntimeError("Production requires ADMIN_PASSWORD or ADMIN_PASSWORD_HASH in .env.")
else:
    _temp = secrets.token_urlsafe(12)
    ADMIN_HASH = generate_password_hash(_temp)
    log.warning("Development admin credentials -> %s / %s", ADMIN_EMAIL, _temp)

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

ORDER_STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"]
PAYMENT_METHODS = {"cod": "Cash on delivery", "bank_transfer": "Bank transfer"}
ALLOWED_IMAGES = {"png": b"\x89PNG", "jpg": b"\xff\xd8\xff", "jpeg": b"\xff\xd8\xff",
                  "gif": b"GIF8", "webp": b"RIFF"}


# --- Database ---------------------------------------------------------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(app.config["DATABASE"])
    db.executescript("""
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, price REAL NOT NULL, category TEXT NOT NULL,
            image_url TEXT NOT NULL, rating REAL, is_new BOOLEAN, is_bestseller BOOLEAN,
            short_specs TEXT, full_specs TEXT
        );
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_number TEXT UNIQUE NOT NULL, access_token TEXT NOT NULL,
            customer_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
            address TEXT NOT NULL, city TEXT NOT NULL, notes TEXT,
            payment_method TEXT NOT NULL, promo_code TEXT,
            subtotal REAL NOT NULL, discount REAL NOT NULL, shipping REAL NOT NULL,
            total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            product_id INTEGER, name TEXT NOT NULL, image_url TEXT,
            unit_price REAL NOT NULL, quantity INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscribers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
    """)
    # Lightweight migrations for databases created by older versions.
    cols = {r[1] for r in db.execute("PRAGMA table_info(products)")}
    for col, ddl in [("brand", "TEXT"), ("stock", "INTEGER NOT NULL DEFAULT 10"),
                     ("description", "TEXT"), ("created_at", "TEXT")]:
        if col not in cols:
            db.execute(f"ALTER TABLE products ADD COLUMN {col} {ddl}")
    db.execute("UPDATE products SET brand = TRIM(SUBSTR(category, 1, INSTR(category || ' ', ' ') - 1)) "
               "WHERE brand IS NULL OR brand = ''")
    db.execute("UPDATE products SET created_at = ? WHERE created_at IS NULL", (now_iso(),))
    db.commit()
    db.close()


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def product_dict(row):
    d = dict(row)
    try:
        d["full_specs"] = json.loads(d["full_specs"]) if d.get("full_specs") else {}
    except (TypeError, ValueError):
        d["full_specs"] = {}
    d["is_new"] = bool(d.get("is_new"))
    d["is_bestseller"] = bool(d.get("is_bestseller"))
    d["in_stock"] = (d.get("stock") or 0) > 0
    return d


# --- Helpers: rate limiting, CSRF, auth, validation -------------------------
_hits = defaultdict(deque)


def rate_limited(key, limit, window):
    now = time.time()
    q = _hits[key]
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(now)
    return False


def client_ip():
    return request.remote_addr or "?"


def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_hex(16)
    return session["csrf"]


def admin_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if not session.get("admin_logged_in"):
            if request.path.startswith("/admin/api"):
                return jsonify({"error": "Unauthorized"}), 401
            return redirect(url_for("admin_login"))
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.path.startswith("/admin/api"):
            if not secrets.compare_digest(request.headers.get("X-CSRF-Token", ""), session.get("csrf", "x")):
                return jsonify({"error": "Invalid CSRF token. Reload the page."}), 403
        return fn(*a, **kw)
    return wrapper


def clean(value, maxlen):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:maxlen]


EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
PHONE_RE = re.compile(r"^\+?[0-9]{7,15}$")


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify({"error": err.message}), err.status


# --- Template context & security headers ------------------------------------
@app.context_processor
def inject_globals():
    return {"cfg": Config, "csrf_token": csrf_token, "year": datetime.now().year}


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if request.path.startswith("/admin") or request.path.startswith("/order/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# --- Pricing -----------------------------------------------------------------
def price_cart(db, raw_items, promo_code=""):
    """Authoritative server-side pricing. Never trusts client prices."""
    if not isinstance(raw_items, list) or not raw_items:
        raise ApiError("Your cart is empty.")
    merged = {}
    for it in raw_items[:50]:
        try:
            pid, qty = int(it["id"]), int(it["quantity"])
        except (KeyError, TypeError, ValueError):
            raise ApiError("Invalid cart data.")
        merged[pid] = merged.get(pid, 0) + qty
    lines, subtotal = [], 0.0
    for pid, qty in merged.items():
        if qty < 1 or qty > 10:
            raise ApiError("Quantity must be between 1 and 10 per product.")
        row = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
        if not row:
            raise ApiError("A product in your cart is no longer available.")
        if row["stock"] < qty:
            left = max(row["stock"], 0)
            raise ApiError(f"{row['name']}: only {left} in stock." if left else f"{row['name']} is out of stock.")
        line_total = round(row["price"] * qty, 2)
        subtotal += line_total
        lines.append({"id": pid, "name": row["name"], "image_url": row["image_url"],
                      "unit_price": row["price"], "quantity": qty, "line_total": line_total})
    subtotal = round(subtotal, 2)
    code = clean(promo_code, 40).upper()
    pct = Config.PROMO_CODES.get(code, 0)
    discount = round(subtotal * pct / 100, 2)
    after = subtotal - discount
    shipping = 0.0 if after >= Config.FREE_SHIPPING_THRESHOLD else Config.SHIPPING_FEE
    return {"lines": lines, "subtotal": subtotal, "discount": discount,
            "promo_code": code if pct else "", "promo_percent": pct,
            "shipping": shipping, "total": round(after + shipping, 2)}


# --- Storefront pages ---------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/product/<int:pid>")
def product_detail(pid):
    row = get_db().execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    if not row:
        abort(404)
    return render_template("product.html", product=product_dict(row))


@app.route("/checkout")
def checkout():
    return render_template("checkout.html", payment_methods=PAYMENT_METHODS)


@app.route("/track", methods=["GET", "POST"])
def track():
    order, error = None, None
    if request.method == "POST":
        if rate_limited("track:" + client_ip(), 10, 600):
            error = "Too many attempts. Please try again in a few minutes."
        else:
            number = clean(request.form.get("order_number"), 40).upper()
            phone = re.sub(r"[^\d]", "", request.form.get("phone", ""))
            row = get_db().execute("SELECT * FROM orders WHERE order_number = ?", (number,)).fetchone()
            if row and phone and re.sub(r"[^\d]", "", row["phone"]).endswith(phone[-8:]):
                return redirect(url_for("order_view", number=number, t=row["access_token"]))
            error = "We could not find an order matching those details."
    return render_template("track.html", error=error, order=order)


@app.route("/order/<number>")
def order_view(number):
    db = get_db()
    row = db.execute("SELECT * FROM orders WHERE order_number = ?", (number,)).fetchone()
    token = request.args.get("t", "")
    if not row or not secrets.compare_digest(token, row["access_token"]):
        abort(404)
    items = db.execute("SELECT * FROM order_items WHERE order_id = ?", (row["id"],)).fetchall()
    return render_template("order.html", order=row, items=items, statuses=ORDER_STATUSES,
                           payment_methods=PAYMENT_METHODS)


POLICIES = {
    "shipping-returns": "Shipping & Returns",
    "privacy": "Privacy Policy",
    "terms": "Terms of Service",
}


@app.route("/policies/<slug>")
def policy(slug):
    if slug not in POLICIES:
        abort(404)
    return render_template("policy.html", slug=slug, title=POLICIES[slug])


@app.route("/robots.txt")
def robots():
    base = Config.SITE_URL or request.url_root.rstrip("/")
    return Response(f"User-agent: *\nDisallow: /admin\nDisallow: /order/\nSitemap: {base}/sitemap.xml\n",
                    mimetype="text/plain")


@app.route("/sitemap.xml")
def sitemap():
    base = Config.SITE_URL or request.url_root.rstrip("/")
    ids = [r["id"] for r in get_db().execute("SELECT id FROM products")]
    urls = [f"{base}/"] + [f"{base}/product/{i}" for i in ids]
    body = "".join(f"<url><loc>{u}</loc></url>" for u in urls)
    return Response('<?xml version="1.0" encoding="UTF-8"?>'
                    f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{body}</urlset>',
                    mimetype="application/xml")


@app.route("/healthz")
def healthz():
    get_db().execute("SELECT 1")
    return jsonify({"status": "ok"})


# --- Public JSON API ---------------------------------------------------------
@app.route("/api/products")
def api_products():
    rows = get_db().execute("SELECT * FROM products ORDER BY id DESC").fetchall()
    return jsonify([product_dict(r) for r in rows])


@app.route("/api/products/related/<int:pid>")
def api_related(pid):
    db = get_db()
    row = db.execute("SELECT category FROM products WHERE id = ?", (pid,)).fetchone()
    if not row:
        return jsonify([])
    rows = db.execute("SELECT * FROM products WHERE category = ? AND id != ? LIMIT 4",
                      (row["category"], pid)).fetchall()
    return jsonify([product_dict(r) for r in rows])


@app.route("/api/quote", methods=["POST"])
def api_quote():
    data = request.get_json(silent=True) or {}
    return jsonify(price_cart(get_db(), data.get("items"), data.get("promo", "")))


@app.route("/api/validate-promo", methods=["POST"])
def validate_promo():
    code = clean((request.get_json(silent=True) or {}).get("code"), 40).upper()
    pct = Config.PROMO_CODES.get(code, 0)
    return jsonify({"valid": pct > 0, "discount": pct})


@app.route("/api/subscribe", methods=["POST"])
def api_subscribe():
    if rate_limited("sub:" + client_ip(), 5, 3600):
        raise ApiError("Too many requests. Try again later.", 429)
    email = clean((request.get_json(silent=True) or {}).get("email"), 120).lower()
    if not EMAIL_RE.match(email):
        raise ApiError("Please enter a valid email address.")
    db = get_db()
    db.execute("INSERT OR IGNORE INTO subscribers (email, created_at) VALUES (?, ?)", (email, now_iso()))
    db.commit()
    return jsonify({"message": "Thanks for subscribing!"})


@app.route("/api/orders", methods=["POST"])
def api_create_order():
    if rate_limited("order:" + client_ip(), 8, 3600):
        raise ApiError("Too many orders from this connection. Please contact us.", 429)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Invalid request.")
    c = data.get("customer") or {}
    if not isinstance(c, dict):
        raise ApiError("Invalid customer details.")
    name, address, city = clean(c.get("name"), 100), clean(c.get("address"), 300), clean(c.get("city"), 80)
    phone = re.sub(r"[\s\-()]", "", str(c.get("phone", "")))
    email = clean(c.get("email"), 120).lower()
    notes = clean(c.get("notes"), 500)
    method = data.get("payment_method", "cod")
    if len(name) < 2:
        raise ApiError("Please enter your full name.")
    if not PHONE_RE.match(phone):
        raise ApiError("Please enter a valid phone number (digits only, optional +).")
    if email and not EMAIL_RE.match(email):
        raise ApiError("Please enter a valid email address.")
    if len(address) < 5 or len(city) < 2:
        raise ApiError("Please enter your delivery address and city.")
    if method not in PAYMENT_METHODS:
        raise ApiError("Unsupported payment method.")

    db = get_db()
    try:
        db.execute("BEGIN IMMEDIATE")
        quote = price_cart(db, data.get("items"), data.get("promo", ""))
        ts = now_iso()
        for _ in range(5):
            number = f"{Config.ORDER_PREFIX}-{datetime.now():%y%m%d}-{secrets.token_hex(2).upper()}"
            if not db.execute("SELECT 1 FROM orders WHERE order_number = ?", (number,)).fetchone():
                break
        token = secrets.token_urlsafe(16)
        cur = db.execute(
            "INSERT INTO orders (order_number, access_token, customer_name, phone, email, address, city, notes, "
            "payment_method, promo_code, subtotal, discount, shipping, total, status, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)",
            (number, token, name, phone, email, address, city, notes, method, quote["promo_code"],
             quote["subtotal"], quote["discount"], quote["shipping"], quote["total"], ts, ts))
        oid = cur.lastrowid
        for ln in quote["lines"]:
            db.execute("INSERT INTO order_items (order_id, product_id, name, image_url, unit_price, quantity) "
                       "VALUES (?,?,?,?,?,?)", (oid, ln["id"], ln["name"], ln["image_url"], ln["unit_price"], ln["quantity"]))
            db.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (ln["quantity"], ln["id"]))
        db.commit()
    except Exception:
        db.rollback()
        raise
    log.info("New order %s total=%s", number, quote["total"])
    return jsonify({"order_number": number, "redirect": url_for("order_view", number=number, t=token)}), 201


# --- Admin: auth --------------------------------------------------------------
@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    error = None
    if request.method == "POST":
        key = "login:" + client_ip()
        if rate_limited(key, 6, 900):
            error = "Too many attempts. Try again in 15 minutes."
        elif not secrets.compare_digest(request.form.get("csrf", ""), session.get("csrf", "x")):
            error = "Session expired. Please try again."
        else:
            email = request.form.get("email", "").strip().lower()
            ok = secrets.compare_digest(email, ADMIN_EMAIL) & check_password_hash(ADMIN_HASH, request.form.get("password", ""))
            if ok:
                session.clear()
                session["admin_logged_in"] = True
                csrf_token()
                return redirect(url_for("admin_dashboard"))
            error = "Invalid credentials"
    return render_template("admin_login.html", error=error)


@app.route("/admin/logout", methods=["POST"])
@admin_required
def admin_logout():
    if not secrets.compare_digest(request.form.get("csrf", ""), session.get("csrf", "x")):
        abort(403)
    session.clear()
    return redirect(url_for("admin_login"))


@app.route("/admin/dashboard")
@admin_required
def admin_dashboard():
    return render_template("admin_dashboard.html", statuses=ORDER_STATUSES)


# --- Admin: products -----------------------------------------------------------
def save_image(file):
    if not file or not file.filename:
        return None
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_IMAGES:
        raise ApiError("Only PNG, JPG, GIF or WEBP images are allowed.")
    head = file.stream.read(12)
    file.stream.seek(0)
    valid_signature = head.startswith(ALLOWED_IMAGES[ext])
    if ext == "webp":
        valid_signature = head.startswith(b"RIFF") and head[8:12] == b"WEBP"
    if not valid_signature:
        raise ApiError("The uploaded file is not a valid image.")
    name = f"{uuid.uuid4().hex}.{ext}"
    file.save(os.path.join(app.config["UPLOAD_FOLDER"], name))
    return f"/static/uploads/{name}"


def read_product_form():
    f = request.form
    name, category = clean(f.get("name"), 160), clean(f.get("category"), 80)
    if not name or not category:
        raise ApiError("Name and category are required.")
    try:
        price = round(float(f.get("price", "")), 2)
        stock = int(f.get("stock", 0) or 0)
        rating = float(f.get("rating") or 0)
    except ValueError:
        raise ApiError("Price, stock and rating must be numbers.")
    if not math.isfinite(price) or not math.isfinite(rating) or price <= 0 or stock < 0 or not 0 <= rating <= 5:
        raise ApiError("Check price (> 0), stock (>= 0) and rating (0-5).")
    specs = f.get("full_specs", "{}") or "{}"
    try:
        if not isinstance(json.loads(specs), dict):
            raise ValueError
    except ValueError:
        raise ApiError("Full specifications must be a valid JSON object.")
    return {"name": name, "price": price, "category": category, "brand": clean(f.get("brand"), 60) or category.split(" ")[0],
            "stock": stock, "rating": rating, "short_specs": clean(f.get("short_specs"), 200),
            "description": (f.get("description") or "").strip()[:3000], "full_specs": specs,
            "is_new": int(f.get("is_new") == "true"), "is_bestseller": int(f.get("is_bestseller") == "true")}


@app.route("/admin/api/products", methods=["POST"])
@admin_required
def admin_add_product():
    p = read_product_form()
    image = save_image(request.files.get("image")) or clean(request.form.get("image_url"), 500)
    if not image:
        raise ApiError("Please upload a product image.")
    db = get_db()
    cur = db.execute(
        "INSERT INTO products (name, price, category, brand, stock, image_url, rating, is_new, is_bestseller, "
        "short_specs, description, full_specs, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (p["name"], p["price"], p["category"], p["brand"], p["stock"], image, p["rating"], p["is_new"],
         p["is_bestseller"], p["short_specs"], p["description"], p["full_specs"], now_iso()))
    db.commit()
    return jsonify({"message": "Product added", "id": cur.lastrowid}), 201


@app.route("/admin/api/products/<int:pid>", methods=["PUT"])
@admin_required
def admin_update_product(pid):
    p = read_product_form()
    db = get_db()
    row = db.execute("SELECT image_url FROM products WHERE id = ?", (pid,)).fetchone()
    if not row:
        raise ApiError("Product not found.", 404)
    image = save_image(request.files.get("image")) or clean(request.form.get("image_url"), 500) or row["image_url"]
    db.execute(
        "UPDATE products SET name=?, price=?, category=?, brand=?, stock=?, image_url=?, rating=?, is_new=?, "
        "is_bestseller=?, short_specs=?, description=?, full_specs=? WHERE id=?",
        (p["name"], p["price"], p["category"], p["brand"], p["stock"], image, p["rating"], p["is_new"],
         p["is_bestseller"], p["short_specs"], p["description"], p["full_specs"], pid))
    db.commit()
    return jsonify({"message": "Product updated"})


@app.route("/admin/api/products/<int:pid>", methods=["DELETE"])
@admin_required
def admin_delete_product(pid):
    db = get_db()
    db.execute("DELETE FROM products WHERE id = ?", (pid,))  # order history keeps its own snapshot
    db.commit()
    return jsonify({"message": "Product deleted"})


# --- Admin: orders, stats, subscribers ------------------------------------------
@app.route("/admin/api/stats")
@admin_required
def admin_stats():
    db = get_db()
    one = lambda q: db.execute(q).fetchone()[0]
    return jsonify({
        "orders": one("SELECT COUNT(*) FROM orders"),
        "pending": one("SELECT COUNT(*) FROM orders WHERE status = 'pending'"),
        "revenue": round(one("SELECT COALESCE(SUM(total),0) FROM orders WHERE status NOT IN ('cancelled')"), 2),
        "products": one("SELECT COUNT(*) FROM products"),
        "low_stock": one("SELECT COUNT(*) FROM products WHERE stock <= 3"),
        "subscribers": one("SELECT COUNT(*) FROM subscribers"),
    })


@app.route("/admin/api/orders")
@admin_required
def admin_orders():
    db = get_db()
    status = request.args.get("status", "")
    rows = db.execute("SELECT * FROM orders WHERE (? = '' OR status = ?) ORDER BY id DESC LIMIT 500",
                      (status, status)).fetchall()
    out = []
    for r in rows:
        d = {k: r[k] for k in r.keys() if k != "access_token"}
        d["items"] = [dict(i) for i in db.execute("SELECT name, unit_price, quantity FROM order_items WHERE order_id = ?", (r["id"],))]
        out.append(d)
    return jsonify(out)


@app.route("/admin/api/orders/<int:oid>", methods=["PATCH"])
@admin_required
def admin_update_order(oid):
    status = (request.get_json(silent=True) or {}).get("status")
    if status not in ORDER_STATUSES:
        raise ApiError("Invalid status.")
    db = get_db()
    row = db.execute("SELECT status FROM orders WHERE id = ?", (oid,)).fetchone()
    if not row:
        raise ApiError("Order not found.", 404)
    old = row["status"]
    # Return stock when an order is cancelled; take it back if it is re-opened.
    if status == "cancelled" and old != "cancelled":
        for it in db.execute("SELECT product_id, quantity FROM order_items WHERE order_id = ?", (oid,)):
            db.execute("UPDATE products SET stock = stock + ? WHERE id = ?", (it["quantity"], it["product_id"]))
    elif old == "cancelled" and status != "cancelled":
        for it in db.execute("SELECT product_id, quantity FROM order_items WHERE order_id = ?", (oid,)):
            db.execute("UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?", (it["quantity"], it["product_id"]))
    db.execute("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?", (status, now_iso(), oid))
    db.commit()
    return jsonify({"message": "Order updated"})


@app.route("/admin/api/subscribers")
@admin_required
def admin_subscribers():
    rows = get_db().execute("SELECT email, created_at FROM subscribers ORDER BY id DESC").fetchall()
    return jsonify([dict(r) for r in rows])


def _safe_cell(v):
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@") else s  # CSV formula-injection guard


@app.route("/admin/export/orders.csv")
@admin_required
def admin_export_orders():
    rows = get_db().execute("SELECT order_number, created_at, status, customer_name, phone, email, city, address, "
                            "payment_method, promo_code, subtotal, discount, shipping, total FROM orders ORDER BY id DESC").fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(rows[0].keys() if rows else ["order_number"])
    for r in rows:
        w.writerow([_safe_cell(v) for v in r])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=orders.csv"})


# --- Errors -------------------------------------------------------------------------
@app.errorhandler(404)
def not_found(_e):
    if request.path.startswith(("/api/", "/admin/api/")):
        return jsonify({"error": "Not found"}), 404
    return render_template("error.html", code=404, message="We couldn't find that page."), 404


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "File too large (max 6 MB)."}), 413


@app.errorhandler(500)
def server_error(_e):
    if request.path.startswith(("/api/", "/admin/api/")):
        return jsonify({"error": "Something went wrong. Please try again."}), 500
    return render_template("error.html", code=500, message="Something went wrong on our side."), 500


init_db()

if __name__ == "__main__":
    app.run(debug=env("FLASK_DEBUG", "0") == "1", host=env("HOST", "127.0.0.1"), port=int(env("PORT", "5000")))
