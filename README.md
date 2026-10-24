# NEXUS Premium Store

A Flask-based electronics storefront with product browsing, filtering, wishlist, cart,
server-priced checkout, order tracking, and an admin dashboard.

## Run locally on Windows

For the step-by-step Arabic guide, open **START_HERE_AR.txt**. Short version:

```cmd
py -m venv venv
venv\Scripts\activate
py -m pip install -r requirements.txt
copy .env.example .env
py app.py
```

If `.env` already exists, do not overwrite it. Configure `SECRET_KEY`, `ADMIN_EMAIL`,
and `ADMIN_PASSWORD` inside `.env`, then open `http://127.0.0.1:5000` in a browser.

## Run tests

Install development dependencies and run:

```cmd
py -m pip install -r requirements-dev.txt
py -m pytest -q
```

## Important

`py app.py` runs a local development server. Before public launch, configure HTTPS, unique
secrets, production hosting, backups, and a production WSGI server. Review `UPGRADE_NOTES.txt`.
